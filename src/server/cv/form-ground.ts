import { dateMentions, enumGrounded, enumIn, hasPresentWord, type EnumKind } from "@/shared/cv-builder-dates";
import type { FormCardStage, FormCardValue, CvBuilderForm, RoleCard } from "@/shared/schemas/cv-builder";

/**
 * The gate between what the interviewer proposes for a data step and what the candidate is shown.
 * A text field is kept only as a contiguous part of ONE message the candidate typed, and stored as
 * their own characters (never the model's string). A date is kept only when they typed that date;
 * "still there" only when they said so next to the role; a level, status or type only when one of
 * its words is in their messages. Everything else is left out and reported.
 *
 * It proves each value is the candidate's; it cannot prove which title goes with which employer.
 * That is what the card is for: nothing is saved until they have looked at it.
 */

export interface TypedMessage {
  id: number;
  text: string;
}

export interface Grounded {
  value: string;
  messageId: number;
}

const QUOTES: Record<string, string> = { "‘": "'", "’": "'", "ʼ": "'", "“": '"', "”": '"', "–": "-", "—": "-" };

/**
 * Folds a text for matching, one output character per kept input character, so a match can be cut
 * out of the original: whitespace runs become one space, case is folded per character (a character
 * whose lower-case form is longer stays as it is), curly quotes and long dashes become plain ones.
 */
function fold(text: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (/\s/.test(c)) {
      if (folded && !folded.endsWith(" ")) {
        folded += " ";
        map.push(i);
      }
      continue;
    }
    const lower = c.toLowerCase();
    folded += QUOTES[c] ?? (lower.length === 1 ? lower : c);
    map.push(i);
  }
  return { folded, map };
}

const ASCII_WORD = /[a-z0-9]/i;

/**
 * The candidate's own spelling of `value`, cut from one of their messages, or null when it isn't
 * there. A short ASCII value ("PB") must stand alone among ASCII letters and digits ("PBX" is not
 * it); Hangul next to it never blocks, because Korean attaches particles without a space (PB에서).
 */
export function groundText(value: string, messages: TypedMessage[]): Grounded | null {
  if (/\.\.\.|…/.test(value)) return null;
  const needle = fold(value.normalize("NFC")).folded.trim();
  if (needle.length < 2) return null;
  const short = needle.length < 4 && /^[a-z0-9]+$/i.test(needle);
  for (const message of messages) {
    const text = message.text.normalize("NFC");
    const { folded, map } = fold(text);
    for (let at = folded.indexOf(needle); at >= 0; at = folded.indexOf(needle, at + 1)) {
      const end = at + needle.length;
      if (short && (ASCII_WORD.test(folded[at - 1] ?? "") || ASCII_WORD.test(folded[end] ?? ""))) continue;
      return { value: text.slice(map[at], map[end - 1] + 1), messageId: message.id };
    }
  }
  return null;
}

/**
 * A date the candidate typed: the proposed "YYYY-MM" or "YYYY" when one of their messages has it;
 * the year alone when they typed that year but not that month. Null otherwise.
 */
export function groundDate(value: string, messages: TypedMessage[]): Grounded | null {
  if (!/^\d{4}(-\d{2})?$/.test(value)) return null;
  const year = value.slice(0, 4);
  let yearOnly: Grounded | null = null;
  for (const message of messages) {
    const typed = dateMentions(message.text).map((d) => d.value);
    if (typed.includes(value)) return { value, messageId: message.id };
    if (!yearOnly && typed.some((d) => d.slice(0, 4) === year)) yearOnly = { value: year, messageId: message.id };
  }
  return yearOnly;
}

export interface ProposalInput {
  // setup
  personas?: string[];
  // target
  titles?: string[];
  industries?: string[];
  cities?: string[];
  availability?: string;
  seniority?: string[];
  workplace?: string[];
  employment_types?: string[];
  // current
  status?: string;
  title?: string;
  company?: string;
  start?: string;
  // roles
  roles?: Array<{ id: string; title: string; company: string; industry: string; location: string; start: string; end: string; current: boolean; employment_type: string }>;
  // education
  education?: Array<{ institution: string; degree: string; field: string; start: string; end: string }>;
  certifications?: Array<{ name: string; issuer: string; year: string }>;
  // languages
  languages?: Array<{ language: string; level: string }>;
}

export interface PendingCard {
  value: unknown;
  inferred?: string[];
  unresolved?: string[];
  sources?: Record<string, number>;
}

export type GroundedProposal =
  | { empty: false; value: FormCardValue; inferred: string[]; unresolved: string[]; dropped: string[]; sources: Record<string, number> }
  | { empty: true; dropped: string[] };

const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

/** The distinct roles (by id) with this job title. */
function titled<T extends { id: string; title: string }>(rows: T[], title: string): T[] {
  return rows.filter((r, i) => same(r.title, title) && rows.findIndex((x) => x.id === r.id) === i);
}

/**
 * Whether the candidate gave this level for this language: the level's word has to be in the same
 * part of a message as the language ("English native, Korean" says nothing about Korean). Parts
 * are split at commas, semicolons, "and" and line breaks; a part that is only a level ("Korean,
 * native") belongs to the language before it.
 */
function levelSaidFor(language: string, level: string, messages: TypedMessage[]): boolean {
  return messages.some((message) => {
    const parts: string[] = [];
    for (const token of message.text.split(/[,;\n]|\s+and\s+|\s*및\s*|\s*그리고\s*/i)) {
      const levelOnly = enumIn("languageLevel", token) !== null && token.trim().split(/\s+/).length <= 2 && !groundText(language, [{ id: 0, text: token }]);
      if (levelOnly && parts.length && enumIn("languageLevel", parts[parts.length - 1]) === null) parts[parts.length - 1] += `, ${token}`;
      else parts.push(token);
    }
    return parts.some((part) => groundText(language, [{ id: 0, text: part }]) !== null && enumGrounded("languageLevel", level, [part]));
  });
}

const FIELD_WORDS: Record<string, string> = {
  titles: "job title",
  industries: "industry",
  cities: "city",
  availability: "availability",
  title: "job title",
  company: "employer",
  industry: "industry",
  location: "city",
  start: "start date",
  end: "end date",
  institution: "institution",
  degree: "qualification",
  field: "field of study",
  name: "certification name",
  issuer: "issuer",
  year: "year",
  language: "language",
};

/** A left-out field in plain words, for the interviewer ("start date of role 2"). */
export function describePath(path: string): string {
  const [group, index, field] = path.split(".");
  if (field === undefined) return FIELD_WORDS[group] ?? group;
  const row = { roles: "role", education: "education entry", certifications: "certification", languages: "language" }[group] ?? group;
  return `${FIELD_WORDS[field] ?? field} of ${row} ${Number(index) + 1}`;
}

/**
 * Grounds one propose_* call. The card value starts from the card still waiting in this
 * conversation (so something typed but not yet accepted is not lost), then takes the newly
 * grounded rows on top. Field paths are "titles", "status", "roles.<i>.start"… with <i> the row's
 * place on the card.
 */
export function groundProposal(
  stage: FormCardStage,
  input: ProposalInput,
  messages: TypedMessage[],
  form: CvBuilderForm,
  options: { pending?: PendingCard | null; toolUseId?: string } = {},
): GroundedProposal {
  const texts = messages.map((m) => m.text);
  const pending = options.pending ?? null;
  const tag = (options.toolUseId ?? "card").replace(/\W/g, "");
  const inferred: string[] = [...(pending?.inferred ?? [])];
  const dropped: string[] = [];
  const sources: Record<string, number> = { ...(pending?.sources ?? {}) };
  let found = 0;

  /** Grounds a text field; a non-empty value that isn't theirs is reported and comes back null. */
  const text = (value: string | undefined, path: string): string | null => {
    if (!value?.trim()) return null;
    const hit = groundText(value, messages);
    if (!hit) {
      dropped.push(path);
      return null;
    }
    sources[path] = hit.messageId;
    found++;
    return hit.value;
  };
  const date = (value: string | undefined, path: string): string | null => {
    if (!value?.trim()) return null;
    const hit = groundDate(value.trim(), messages);
    if (!hit) {
      dropped.push(path);
      return null;
    }
    sources[path] = hit.messageId;
    found++;
    return hit.value;
  };
  const picked = (kind: EnumKind, value: string | undefined, path: string): boolean => {
    if (!value || !enumGrounded(kind, value, texts)) return false;
    if (!inferred.includes(path)) inferred.push(path);
    return true;
  };
  const drop = (list: string[], prefix: string) => list.filter((p) => !p.startsWith(prefix));
  const finish = (value: FormCardValue, unresolved: string[]): GroundedProposal =>
    found ? { empty: false, value, inferred: [...new Set(inferred)], unresolved, dropped, sources } : { empty: true, dropped };

  switch (stage) {
    case "setup": {
      // Who they are, read from how they describe their situation: a description is kept only when
      // one of its words is in what they typed. The picks (language, country, depth) are never the model's.
      const value = structuredClone((pending?.value as CvBuilderForm["setup"] | undefined) ?? form.setup);
      for (const persona of input.personas ?? []) {
        if (!picked("persona", persona, "personas")) continue;
        found++;
        if (!(value.personas as string[]).includes(persona)) (value.personas as string[]).push(persona);
      }
      return finish(value, []);
    }
    case "target": {
      // Nothing on file is removed by a proposal: grounded items are added to what is there.
      const value = structuredClone((pending?.value as CvBuilderForm["target"] | undefined) ?? form.target);
      for (const key of ["titles", "industries", "cities"] as const) {
        for (const item of input[key] ?? []) {
          const hit = text(item, key);
          if (hit && !value[key].some((v) => same(v, hit))) value[key].push(hit);
        }
      }
      const availability = text(input.availability, "availability");
      if (availability) value.availability = availability;
      const enums = [
        ["seniority", "seniority", input.seniority],
        ["workplace", "workplace", input.workplace],
        ["employmentType", "employmentTypes", input.employment_types],
      ] as const;
      for (const [kind, key, list] of enums) {
        for (const v of list ?? []) {
          if (!picked(kind, v, key)) continue;
          found++;
          const target = value[key] as string[];
          if (!target.includes(v)) target.push(v);
        }
      }
      return finish(value, []);
    }

    case "current": {
      const value = { ...((pending?.value as CvBuilderForm["current"] | undefined) ?? form.current) };
      const title = text(input.title, "title");
      const company = text(input.company, "company");
      const start = date(input.start, "start");
      if (title) value.title = title;
      if (company) value.company = company;
      if (start) value.start = start;
      // "I'm studying" has no job title and must still produce a card.
      if (input.status !== value.status && picked("currentStatus", input.status, "status")) {
        value.status = input.status as CvBuilderForm["current"]["status"];
        found++;
      }
      return finish(value, []);
    }

    case "roles": {
      const rows: RoleCard[] = structuredClone(((pending?.value as { roles?: RoleCard[] } | undefined)?.roles ?? []) as RoleCard[]);
      let fresh = rows.filter((r) => !form.roles.some((f) => f.id === r.id)).length;
      (input.roles ?? []).forEach((proposed, n) => {
        const before = { found, dropped: dropped.length };
        const local: Record<string, number> = {};
        const localInferred: string[] = [];
        const field = (value: string, name: string, ground: (v: string, m: TypedMessage[]) => Grounded | null): string | null => {
          if (!value?.trim()) return null;
          const hit = ground(value.trim(), messages);
          if (!hit) {
            dropped.push(`roles.${n}.${name}`);
            return null;
          }
          local[name] = hit.messageId;
          found++;
          return hit.value;
        };
        const title = field(proposed.title, "title", groundText);
        const company = field(proposed.company, "company", groundText);
        if (!title && !company) {
          // No grounded key field: the row is not shown at all.
          found = before.found;
          dropped.splice(before.dropped);
          dropped.push(`roles.${n}.title`);
          return;
        }
        const industry = field(proposed.industry, "industry", groundText);
        const location = field(proposed.location, "location", groundText);
        const start = field(proposed.start, "start", groundDate);
        const end = field(proposed.end, "end", groundDate);

        const known = [...rows, ...form.roles.map((r) => ({ ...r, current: !r.end }))];
        const existing =
          known.find((r) => /^exp-\d+$/.test(proposed.id) && r.id === proposed.id && form.roles.some((f) => f.id === r.id)) ??
          known.find((r) => title !== null && company !== null && same(r.title, title) && same(r.company, company)) ??
          // A follow-up that names only the job title ("as Barista, that was 2015 to 2016") is about
          // the one role with that title on the card still waiting. Never a job already saved: an
          // earlier job with the same title as the current one would rewrite the current one's dates.
          (title !== null && !proposed.company.trim() && titled(rows, title).length === 1 ? titled(rows, title)[0] : undefined);
        const row: RoleCard = existing
          ? { ...existing }
          : {
              id: `new-${tag}_${n}`,
              title: "",
              company: "",
              industry: "",
              location: "",
              country: "",
              start: "",
              end: "",
              employmentType: "full_time",
              seniority: null,
              depth: form.setup.depth === "quick" && (form.roles.length || fresh > 0) ? "brief" : "deep",
              current: false,
            };
        if (!existing) fresh++;
        if (title) row.title = title;
        if (company) row.company = company;
        if (industry) row.industry = industry;
        if (location) row.location = location;
        if (start) row.start = start;
        if (end) {
          row.end = end;
          row.current = false;
        }
        // "Still there" counts only when a message that names this role (or its start date) says so.
        const says = messages.some((m) => hasPresentWord(m.text) && (groundText(row.title, [m]) || groundText(row.company, [m]) || (!!row.start && groundDate(row.start, [m])?.value === row.start)));
        if (proposed.current && !end && says) {
          row.current = true;
          row.end = "";
          found++;
        }
        if (enumGrounded("employmentType", proposed.employment_type, texts)) {
          row.employmentType = proposed.employment_type as RoleCard["employmentType"];
          localInferred.push("employmentType");
        }

        let at = rows.findIndex((r) => r.id === row.id);
        if (at < 0) at = rows.push(row) - 1;
        else rows[at] = row;
        // Paths are by the row's place on the card, which is known only now.
        for (let i = before.dropped; i < dropped.length; i++) dropped[i] = dropped[i].replace(`roles.${n}.`, `roles.${at}.`);
        for (const [name, id] of Object.entries(local)) sources[`roles.${at}.${name}`] = id;
        const kept = drop(inferred, `roles.${at}.`);
        inferred.splice(0, inferred.length, ...kept, ...localInferred.map((name) => `roles.${at}.${name}`));
      });
      const unresolved = rows.flatMap((r, i) => (!r.current && !r.end ? [`roles.${i}.current`] : []));
      return finish({ roles: rows }, unresolved);
    }

    case "education": {
      type Card = FormCardValue<"education">;
      const base = (pending?.value as Card | undefined) ?? { education: [], certifications: [] };
      const value: Card = structuredClone({ education: base.education ?? [], certifications: base.certifications ?? [] });
      (input.education ?? []).forEach((proposed, n) => {
        const institution = text(proposed.institution, `education.${n}.institution`);
        if (!institution) {
          if (!dropped.includes(`education.${n}.institution`)) dropped.push(`education.${n}.institution`);
          return;
        }
        const degree = text(proposed.degree, `education.${n}.degree`);
        const existing = [...value.education, ...form.education].find((e) => same(e.institution, institution) && same(e.degree, degree));
        const row = existing ? { ...existing } : { id: `edu-${tag}_${n}`, institution, degree, field: null as string | null, country: null as string | null, start: null as string | null, end: null as string | null };
        row.institution = institution;
        row.field = text(proposed.field, `education.${n}.field`) ?? row.field;
        row.start = date(proposed.start, `education.${n}.start`) ?? row.start;
        row.end = date(proposed.end, `education.${n}.end`) ?? row.end;
        const at = value.education.findIndex((e) => e.id === row.id);
        if (at < 0) value.education.push(row);
        else value.education[at] = row;
      });
      (input.certifications ?? []).forEach((proposed, n) => {
        const name = text(proposed.name, `certifications.${n}.name`);
        if (!name) {
          if (!dropped.includes(`certifications.${n}.name`)) dropped.push(`certifications.${n}.name`);
          return;
        }
        const existing = [...value.certifications, ...form.certifications].find((c) => same(c.name, name));
        const row = existing ? { ...existing } : { name, issuer: null as string | null, year: null as string | null };
        row.issuer = text(proposed.issuer, `certifications.${n}.issuer`) ?? row.issuer;
        row.year = date(proposed.year, `certifications.${n}.year`)?.slice(0, 4) ?? row.year;
        const at = value.certifications.findIndex((c) => same(c.name, name));
        if (at < 0) value.certifications.push(row);
        else value.certifications[at] = row;
      });
      return finish(value, []);
    }

    case "languages": {
      type Row = FormCardValue<"languages">["languages"][number];
      const rows: Row[] = structuredClone(((pending?.value as { languages?: Row[] } | undefined)?.languages ?? []) as Row[]);
      (input.languages ?? []).forEach((proposed, n) => {
        const language = text(proposed.language, `languages.${n}.language`);
        if (!language) {
          if (!dropped.includes(`languages.${n}.language`)) dropped.push(`languages.${n}.language`);
          return;
        }
        let at = rows.findIndex((r) => same(r.language, language));
        const onFile = form.languages.find((l) => same(l.language, language));
        const row: Row = at >= 0 ? { ...rows[at] } : { language, level: onFile?.level ?? "" };
        if (at < 0) at = rows.push(row) - 1;
        else rows[at] = row;
        if (sources[`languages.${n}.language`] !== undefined && n !== at) {
          sources[`languages.${at}.language`] = sources[`languages.${n}.language`];
          delete sources[`languages.${n}.language`];
        }
        // A level nobody typed is never pre-selected: the candidate picks it on the card.
        if (levelSaidFor(language, proposed.level, messages)) {
          row.level = proposed.level as Row["level"];
          if (!inferred.includes(`languages.${at}.level`)) inferred.push(`languages.${at}.level`);
        }
      });
      const unresolved = rows.flatMap((r, i) => (r.level ? [] : [`languages.${i}.level`]));
      return finish({ languages: rows }, unresolved);
    }
  }
}
