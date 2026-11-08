/**
 * The API rejects strict schemas (structured outputs, strict tools) with more than
 * `UNION_PARAM_LIMIT` parameters whose type is a union — an `anyOf` or a `type` array, which is
 * what every `.nullable()` becomes. Schemas over the limit are adapted before they're sent:
 * nullable string and string-enum fields become plain (non-null) strings where `""` stands for
 * null, and `decodeAdapted` turns those `""` (and a literal `"null"`) back into `null` before the
 * Zod schema parses the answer. Prompts describe a missing value as `null, or "" where the output
 * format doesn't allow null`, which is true on both connections. Callers still see `null`. Schemas within the limit are sent unchanged.
 */

/** Documented API limit: "limit: 16 parameters with unions". */
export const UNION_PARAM_LIMIT = 16;

/** What the model writes instead of null in an adapted field. */
export const NULL_SENTINEL = "";

const SENTINEL_NOTE = 'Write "" (an empty string) when there is no value.';

type JsonSchema = Record<string, unknown>;

export interface AdaptedSchema {
  schema: JsonSchema;
  /** Nodes (in `schema`) whose `""` means null. Empty when the schema was sent unchanged. */
  sentinels: Set<JsonSchema>;
  /** Union-typed parameters before and after adapting. */
  unionsBefore: number;
  unionsAfter: number;
}

function isObject(value: unknown): value is JsonSchema {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isUnion(node: JsonSchema): boolean {
  return Array.isArray(node.anyOf) || Array.isArray(node.type);
}

/** Every sub-schema of `node` (properties, items, union variants, definitions), not following `$ref`. */
function children(node: JsonSchema): JsonSchema[] {
  const out: JsonSchema[] = [];
  const push = (v: unknown) => {
    if (isObject(v)) out.push(v);
  };
  if (isObject(node.properties)) Object.values(node.properties).forEach(push);
  if (Array.isArray(node.items)) node.items.forEach(push);
  else push(node.items);
  if (Array.isArray(node.prefixItems)) node.prefixItems.forEach(push);
  for (const key of ["anyOf", "oneOf", "allOf"] as const) if (Array.isArray(node[key])) (node[key] as unknown[]).forEach(push);
  for (const key of ["$defs", "definitions"] as const) if (isObject(node[key])) Object.values(node[key] as JsonSchema).forEach(push);
  push(node.additionalProperties);
  return out;
}

/** Union-typed parameters in a JSON schema (each node with `anyOf` or a `type` array; definitions counted once). */
export function countUnionParams(schema: unknown): number {
  if (!isObject(schema)) return 0;
  return (isUnion(schema) ? 1 : 0) + children(schema).reduce((n, c) => n + countUnionParams(c), 0);
}

const isNull = (v: unknown) => isObject(v) && v.type === "null" && Object.keys(v).every((k) => k === "type" || k === "description");

/** For a `string | null` (or nullable string enum) node: the string variant, else null. */
function nullableString(node: JsonSchema): JsonSchema | null {
  let variant: JsonSchema | null = null;
  if (Array.isArray(node.anyOf) && node.anyOf.length === 2) {
    const [a, b] = node.anyOf as unknown[];
    if (isNull(a) && isObject(b)) variant = b;
    else if (isNull(b) && isObject(a)) variant = a;
  } else if (Array.isArray(node.type) && node.type.length === 2 && node.type.includes("null") && node.type.includes("string")) {
    const rest = Object.fromEntries(Object.entries(node).filter(([k]) => k !== "type"));
    variant = { ...rest, type: "string" };
  }
  if (!variant || variant.type !== "string" || isUnion(variant)) return null;
  // A format (date, uri…), const, minLength or pattern would reject "" (null would become inexpressible).
  // On the output-format path the SDK moves minLength/pattern into the description text.
  if (["format", "const", "minLength", "pattern"].some((k) => k in variant)) return null;
  if (typeof variant.description === "string" && /\b(minLength|pattern):/.test(variant.description)) return null;
  if (Array.isArray(variant.enum) && (variant.enum.includes(NULL_SENTINEL) || variant.enum.some((v) => typeof v !== "string"))) return null;
  return variant;
}

/** Nullable strings reachable without passing through a union of several non-null variants (where decoding would be ambiguous). */
function collectCandidates(node: JsonSchema, out: JsonSchema[]): void {
  if (nullableString(node)) {
    out.push(node);
    return;
  }
  if (Array.isArray(node.anyOf) || Array.isArray(node.oneOf)) {
    const variants = ((node.anyOf ?? node.oneOf) as unknown[]).filter((v) => !isNull(v));
    if (variants.length !== 1) return;
  }
  if (Array.isArray(node.allOf)) return;
  for (const child of children(node)) collectCandidates(child, out);
}

/** Copy of `schema` that stays within the union limit (see the module comment); throws if it can't. */
export function adaptForUnionLimit(schema: JsonSchema, limit = UNION_PARAM_LIMIT): AdaptedSchema {
  const unionsBefore = countUnionParams(schema);
  const copy = structuredClone(schema);
  const sentinels = new Set<JsonSchema>();
  if (unionsBefore <= limit) return { schema: copy, sentinels, unionsBefore, unionsAfter: unionsBefore };

  const candidates: JsonSchema[] = [];
  collectCandidates(copy, candidates);
  for (const node of candidates) {
    const variant = nullableString(node)!;
    const description = [node.description, variant.description].filter((d): d is string => typeof d === "string" && !!d);
    for (const key of Object.keys(node)) delete node[key];
    Object.assign(node, variant, { type: "string", description: [...new Set(description), SENTINEL_NOTE].join("\n\n") });
    if (Array.isArray(node.enum)) node.enum = [...(node.enum as string[]), NULL_SENTINEL];
    sentinels.add(node);
  }
  const unionsAfter = countUnionParams(copy);
  if (unionsAfter > limit) {
    throw new Error(`Schema has ${unionsAfter} union-typed parameters after adapting (API limit ${limit}); reduce its nullable non-string fields`);
  }
  return { schema: copy, sentinels, unionsBefore, unionsAfter };
}

function resolveRef(root: JsonSchema, ref: string): JsonSchema | null {
  if (!ref.startsWith("#")) return null;
  let node: unknown = root;
  for (const part of ref.slice(1).split("/").filter(Boolean)) {
    if (!isObject(node)) return null;
    node = node[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return isObject(node) ? node : null;
}

/** The model's answer to an adapted schema, with each sentinel `""` turned back into `null`. */
export function decodeAdapted(adapted: Pick<AdaptedSchema, "schema" | "sentinels">, value: unknown): unknown {
  if (adapted.sentinels.size === 0) return value;
  const walk = (node: JsonSchema | null, v: unknown, depth: number): unknown => {
    if (!node || depth > 64) return v;
    if (typeof node.$ref === "string") return walk(resolveRef(adapted.schema, node.$ref), v, depth + 1);
    // The prompt or habit may still produce a literal "null"; it means no value too.
    if (adapted.sentinels.has(node)) return v === NULL_SENTINEL || (typeof v === "string" && v.trim().toLowerCase() === "null") ? null : v;
    if (v === null || v === undefined) return v;
    const variants = (node.anyOf ?? node.oneOf) as unknown[] | undefined;
    if (Array.isArray(variants)) {
      const nonNull = variants.filter((x) => !isNull(x));
      return nonNull.length === 1 && isObject(nonNull[0]) ? walk(nonNull[0], v, depth + 1) : v;
    }
    if (Array.isArray(v)) {
      const items = node.items;
      if (Array.isArray(items) || Array.isArray(node.prefixItems)) {
        const tuple = (node.prefixItems ?? items) as unknown[];
        return v.map((x, i) => walk(isObject(tuple[i]) ? tuple[i] : null, x, depth + 1));
      }
      return isObject(items) ? v.map((x) => walk(items, x, depth + 1)) : v;
    }
    if (isObject(v) && (isObject(node.properties) || isObject(node.additionalProperties))) {
      const props = isObject(node.properties) ? node.properties : {};
      const rest = isObject(node.additionalProperties) ? node.additionalProperties : null;
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(isObject(props[k]) ? props[k] : rest, x, depth + 1)]));
    }
    return v;
  };
  return walk(adapted.schema, value, 0);
}
