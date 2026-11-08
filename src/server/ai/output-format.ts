import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { adaptForUnionLimit, decodeAdapted, type AdaptedSchema } from "./schema-limits";

/**
 * `betaZodOutputFormat` with the schema kept within the API's union limit (see schema-limits.ts).
 * `parse` maps the adapted answer back and checks it against the original Zod schema, so callers
 * get exactly what the schema describes (nulls included).
 */
export function apiOutputFormat<S extends z.ZodType>(schema: S) {
  const base = betaZodOutputFormat(schema);
  const adapted = adaptForUnionLimit(base.schema as Record<string, unknown>);
  return {
    type: base.type,
    schema: adapted.schema,
    parse: (content: string): z.infer<S> => {
      const output = schema.safeParse(decodeAdapted(adapted, JSON.parse(content)));
      if (!output.success) throw new Anthropic.AnthropicError(`Failed to parse structured output: ${output.error.message}`);
      return output.data;
    },
  };
}

/** Input schema for a strict client tool from a Zod schema, within the union limit; `decode` maps a tool call's input back. */
export function strictToolSchema(json: Record<string, unknown>): AdaptedSchema & { decode: (input: unknown) => unknown } {
  const adapted = adaptForUnionLimit(json);
  return { ...adapted, decode: (input) => decodeAdapted(adapted, input) };
}
