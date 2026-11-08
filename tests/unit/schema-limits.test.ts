import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { adaptForUnionLimit, countUnionParams, decodeAdapted, NULL_SENTINEL, UNION_PARAM_LIMIT } from "@/server/ai/schema-limits";
import { apiOutputFormat } from "@/server/ai/output-format";
import { submitTool } from "@/server/ai/agent-loop";
import { callStructured, resetAiClient } from "@/server/ai/client";
import { getFakeGenerator, registerFakeGenerator, strictUnionParams, type FakeRequest } from "@/server/ai/fake/transport";
import { analyzePosting } from "@/server/ai/tasks/analyze-posting";
import { assessmentSchema, postingAnalysisSchema } from "@/shared/schemas/job";
import { linkedinOutputSchema, tailoredCvSchema, tailoringPlanSchema } from "@/shared/schemas/cv";
import { searchFiltersSchema } from "@/shared/schemas/search";
import { companyReportSchema } from "@/shared/schemas/company";
import { profileExtractionSchema } from "@/server/ai/tasks/extract-profile";
import { transcriptionSchema } from "@/server/ai/tasks/transcribe-posting";
import { translationSchema } from "@/server/ai/tasks/translate";
import { leadsSchema } from "@/server/ai/tasks/search-agent";
import { testDb } from "../helpers/db";

afterEach(() => resetAiClient());

/** Every schema sent as structured output (callStructured). */
const STRUCTURED: Record<string, z.ZodType> = {
  postingAnalysisSchema,
  assessmentSchema,
  profileExtractionSchema,
  linkedinOutputSchema,
  tailoringPlanSchema,
  tailoredCvSchema,
  translationSchema,
  searchFiltersSchema,
  transcriptionSchema,
};
/** Every schema sent as a strict submit tool (submitTool / runSubmitLoop). */
const SUBMIT: Record<string, z.ZodType> = { companyReportSchema, leadsSchema };

const SRC = path.join(__dirname, "../../src");
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? sourceFiles(full) : /\.tsx?$/.test(name) ? [full] : [];
  });
}

describe("union limit on strict schemas", () => {
  it("covers every schema the code sends as structured output or a submit tool", () => {
    const used = new Set<string>();
    for (const file of sourceFiles(path.join(SRC, "server/ai"))) {
      const text = readFileSync(file, "utf8");
      if (!/callStructured\(|runSubmitLoop\(|submitTool\(/.test(text)) continue;
      for (const m of text.matchAll(/\bschema:\s*([A-Za-z]\w*Schema)\b/g)) used.add(m[1]);
      for (const m of text.matchAll(/submitTool\([^)]*?,\s*([A-Za-z]\w*Schema)\s*\)/g)) used.add(m[1]);
    }
    expect([...used].sort()).toEqual([...Object.keys(STRUCTURED), ...Object.keys(SUBMIT)].sort());
  });

  it("the posting analysis is over the limit as written (why the adapter exists)", () => {
    expect(countUnionParams(betaZodOutputFormat(postingAnalysisSchema).schema)).toBe(22);
  });

  it.each(Object.entries(STRUCTURED))("%s is sent with at most 16 unions", (_name, schema) => {
    expect(countUnionParams(apiOutputFormat(schema).schema)).toBeLessThanOrEqual(UNION_PARAM_LIMIT);
  });

  it.each(Object.entries(SUBMIT))("%s submit tool is sent with at most 16 unions", (_name, schema) => {
    expect(countUnionParams(submitTool("t", "d", schema).input_schema)).toBeLessThanOrEqual(UNION_PARAM_LIMIT);
  });

  it("leaves schemas within the limit unchanged", () => {
    for (const schema of [assessmentSchema, searchFiltersSchema]) {
      const sent = betaZodOutputFormat(schema).schema;
      if (countUnionParams(sent) > UNION_PARAM_LIMIT) continue;
      expect(apiOutputFormat(schema).schema).toEqual(sent);
    }
  });

  it("fails loudly when only non-string unions would remain over the limit", () => {
    const many = z.object(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`n${i}`, z.number().nullable()])));
    expect(() => apiOutputFormat(many)).toThrow(/union-typed parameters/);
  });
});

describe("sentinel round trip", () => {
  // 17 nullable strings force adapting; each changed kind of field is checked below.
  const filler = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`s${i}`, z.string().nullable()]));
  const schema = z.object({
    ...filler,
    plain: z.string(),
    tag: z.enum(["a", "b"]).nullable(),
    num: z.number().nullable(),
    nested: z.object({ inner: z.string().nullable(), level: z.enum(["x", "y"]).nullable() }).nullable(),
    list: z.array(z.object({ note: z.string().nullable() })),
  });
  const format = apiOutputFormat(schema);
  const props = (format.schema as { properties: Record<string, Record<string, unknown>> }).properties;
  const base = Object.fromEntries(Object.keys(filler).map((k) => [k, NULL_SENTINEL]));

  it("sends nullable strings and enums as non-null with a documented sentinel", () => {
    expect(props.s0).toMatchObject({ type: "string" });
    expect(String(props.s0.description)).toContain('""');
    // The SDK sends enums as a description note; the adapted field keeps it and adds the sentinel note.
    expect(props.tag).toMatchObject({ type: "string" });
    expect(String(props.tag.description)).toMatch(/enum[\s\S]*""/);
    // Numbers and objects keep their union (within the limit after the strings are adapted).
    expect(props.num.type).toEqual(["number", "null"]);
    expect(props.nested.anyOf).toBeDefined();
    expect(countUnionParams(format.schema)).toBe(2);
  });

  it("turns sentinels back into null at every depth, and keeps real values", () => {
    const answer = {
      ...base,
      s1: "kept",
      plain: "",
      tag: "",
      num: null,
      nested: { inner: "", level: "" },
      list: [{ note: "" }, { note: "n" }],
    };
    expect(format.parse(JSON.stringify(answer))).toEqual({
      ...Object.fromEntries(Object.keys(filler).map((k) => [k, null])),
      s1: "kept",
      plain: "",
      tag: null,
      num: null,
      nested: { inner: null, level: null },
      list: [{ note: null }, { note: "n" }],
    });
    expect(format.parse(JSON.stringify({ ...answer, tag: "b", nested: null, num: 3 }))).toMatchObject({ tag: "b", nested: null, num: 3 });
  });

  it("still accepts a real null (demo output)", () => {
    expect(format.parse(JSON.stringify({ ...base, plain: "p", tag: null, num: null, nested: { inner: null, level: null }, list: [] }))).toMatchObject({ tag: null, nested: { inner: null } });
  });

  it("decodes through $ref definitions", () => {
    const shared = z.string().nullable();
    const withRefs = z.object({ ...filler, a: shared, b: z.array(shared) });
    const sent = betaZodOutputFormat(withRefs).schema as Record<string, unknown>;
    const adapted = adaptForUnionLimit(sent);
    expect(countUnionParams(adapted.schema)).toBeLessThanOrEqual(UNION_PARAM_LIMIT);
    const decoded = decodeAdapted(adapted, { ...base, a: "", b: ["", "x"] });
    expect(withRefs.parse(decoded)).toMatchObject({ a: null, b: [null, "x"] });
  });

  it("decodes a submit tool's input", () => {
    const tool = submitTool("t", "d", schema);
    // Raw z.toJSONSchema keeps enums: the adapted enum gets "" as a value.
    expect((tool.input_schema as { properties: Record<string, unknown> }).properties.tag).toMatchObject({ type: "string", enum: ["a", "b", ""] });
    expect(Object.keys(tool)).not.toContain("decodeInput");
    expect(JSON.stringify(tool)).not.toContain("decodeInput");
    const input = { ...base, plain: "p", tag: "", num: 1, nested: null, list: [] };
    expect(schema.parse(tool.decodeInput(input))).toMatchObject({ tag: null, s0: null, num: 1 });
  });
});

describe("request body sent for analyzePosting", () => {
  const original = getFakeGenerator("analyzePosting")!;
  afterEach(() => registerFakeGenerator("analyzePosting", original));

  it("has at most 16 unions, and the caller gets null for sentinel answers", async () => {
    let body: FakeRequest["body"] | null = null;
    registerFakeGenerator("analyzePosting", async (req) => {
      body = req.body;
      const reply = await original(req);
      // Answer like the live model would for the adapted schema: "" where there's no value.
      const block = reply.content.find((b) => b.type === "text") as { text: string };
      const out = JSON.parse(block.text) as Record<string, unknown>;
      return { ...reply, content: [{ type: "text", text: JSON.stringify({ ...out, companyDomain: "", region: "", seniority: "" }) }] };
    });
    const { db, userId } = testDb();
    const text = "Senior Frontend Engineer\nAcme Ltd, Auckland\nRequirements: 5+ years React. TypeScript.\nApply by 30 November.";
    const result = await analyzePosting({ db, userId }, { text, hints: {}, noisy: false, sourceUrl: null });
    expect(body).not.toBeNull();
    const sent = body! as FakeRequest["body"] & { output_config: { format: { schema: unknown } } };
    expect(countUnionParams(sent.output_config.format.schema)).toBeLessThanOrEqual(UNION_PARAM_LIMIT);
    expect(strictUnionParams(sent)).toBeLessThanOrEqual(UNION_PARAM_LIMIT);
    expect(result.analysis).toMatchObject({ companyDomain: null, region: null, seniority: null });
  });

  it("the demo transport rejects over-limit schemas like the API does", async () => {
    registerFakeGenerator("parseSearch", () => ({ content: [{ type: "text", text: "{}" }] }));
    const { db, userId } = testDb();
    const many = z.object(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`n${i}`, z.number().nullable()])));
    // Bypass the adapter's own check: send the raw schema through a hand-built format.
    const raw = betaZodOutputFormat(many);
    const { getAnthropic } = await import("@/server/ai/client");
    await expect(
      getAnthropic("fake").beta.messages.create({ model: "claude-opus-5-5", max_tokens: 10, messages: [{ role: "user", content: "x" }], output_config: { format: { type: "json_schema", schema: raw.schema } } }, { headers: { "x-huntloop-task": "parseSearch" } }),
    ).rejects.toMatchObject({ status: 400 });
    // And callStructured surfaces the adapter's error for such a schema before any request.
    await expect(callStructured({ db, userId }, "parseSearch", { schema: many, messages: [{ role: "user", content: "x" }] })).rejects.toThrow(/union-typed/);
  });
});

describe("review follow-ups", () => {
  const filler = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`s${i}`, z.string().nullable()]));
  const base = Object.fromEntries(Object.keys(filler).map((k) => [k, NULL_SENTINEL]));

  it("maps a literal \"null\" in an adapted field back to null (enums and free text)", () => {
    const schema = z.object({ ...filler, tag: z.enum(["a", "b"]).nullable(), plain: z.string() });
    const format = apiOutputFormat(schema);
    const out = format.parse(JSON.stringify({ ...base, s0: "null", s1: " NULL ", s2: "nullable", tag: "Null", plain: "null" }));
    expect(out).toMatchObject({ s0: null, s1: null, s2: "nullable", tag: null, plain: "null" });
    const tool = submitTool("t", "d", schema);
    expect(schema.parse(tool.decodeInput({ ...base, tag: "null", plain: "p" }))).toMatchObject({ tag: null });
  });

  it("maps sentinels inside records back to null", () => {
    const schema = z.object({ ...filler, extra: z.record(z.string(), z.string().nullable()) });
    const tool = submitTool("t", "d", schema);
    expect(schema.parse(tool.decodeInput({ ...base, extra: { a: "", b: "x" } }))).toMatchObject({ extra: { a: null, b: "x" } });
  });

  it("doesn't adapt strings with minLength or pattern (null must stay expressible)", () => {
    const schema = z.object({ ...filler, min: z.string().min(1).nullable(), re: z.string().regex(/^[A-Z]{2}$/).nullable() });
    for (const sent of [apiOutputFormat(schema).schema, submitTool("t", "d", schema).input_schema] as Array<{ properties: Record<string, Record<string, unknown>> }>) {
      expect(countUnionParams(sent.properties.min)).toBe(1);
      expect(countUnionParams(sent.properties.re)).toBe(1);
      expect(countUnionParams(sent.properties.s0)).toBe(0);
    }
  });

  it("prompts describe empty values for both connections", async () => {
    const files = ["server/ai/tasks/extract-profile.ts", "server/ai/tasks/analyze-posting.ts"].map((f) => readFileSync(path.join(SRC, f), "utf8"));
    for (const text of files) {
      expect(text).toContain('null, or "" where the output format doesn\'t allow null');
      // No instruction still demands a bare null for an adapted field.
      expect(text).not.toMatch(/\bnull (only|when)\b|Null if|else null|otherwise null|to null\./);
    }
  });
});
