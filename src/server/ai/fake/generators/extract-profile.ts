import { allRequestText, registerFakeGenerator } from "../transport";

const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec";
const MONTH_INDEX: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", sept: "09", oct: "10", nov: "11", dec: "12",
};
const RANGE = new RegExp(
  `(?:(${MONTHS})[a-z]*\\.?\\s+)?(\\d{4})(?:[-./](\\d{1,2}))?\\s*(?:-|–|—|to|~)\\s*(?:(?:(${MONTHS})[a-z]*\\.?\\s+)?(\\d{4})(?:[-./](\\d{1,2}))?|(present|current|now|현재))`,
  "i",
);

const KNOWN_SKILLS: Array<[string, string]> = [
  ["TypeScript", "language"], ["JavaScript", "language"], ["Python", "language"], ["Java", "language"], ["Go", "language"],
  ["Kotlin", "language"], ["Swift", "language"], ["SQL", "language"], ["C#", "language"], ["Rust", "language"],
  ["React", "framework"], ["Next.js", "framework"], ["Node.js", "platform"], ["Vue", "framework"], ["Angular", "framework"],
  ["Django", "framework"], ["Spring", "framework"], ["GraphQL", "tool"], ["AWS", "platform"], ["GCP", "platform"],
  ["Azure", "platform"], ["Docker", "tool"], ["Kubernetes", "platform"], ["Terraform", "tool"], ["PostgreSQL", "database"],
  ["MySQL", "database"], ["MongoDB", "database"], ["Redis", "database"], ["Kafka", "tool"], ["Figma", "tool"],
  ["Agile", "method"], ["Scrum", "method"], ["CI/CD", "method"], ["Machine Learning", "domain"], ["Product Management", "domain"],
];

function mentions(text: string, skill: string): boolean {
  const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9+#.])${escaped}(?![A-Za-z0-9+#])`, "i").test(text);
}

function ym(year: string, month?: string, monthNumber?: string): string {
  if (monthNumber) return `${year}-${monthNumber.padStart(2, "0")}`;
  if (month) return `${year}-${MONTH_INDEX[month.toLowerCase().slice(0, 4) === "sept" ? "sept" : month.toLowerCase().slice(0, 3)]}`;
  return year;
}

function splitTitleCompany(line: string): { title: string; company: string } {
  const cleaned = line.replace(RANGE, "").replace(/[\s|,(—–-]+$/, "").trim();
  const at = cleaned.split(/\s+(?:at|@)\s+|\s+[—|–]\s+|\s+-\s+|,\s+/);
  if (at.length >= 2) return { title: at[0].trim(), company: at[1].replace(/[\s|,(—–-]+$/, "").trim() };
  return { title: cleaned || "Role", company: "Company" };
}

/** Rough, deterministic CV parser for demo mode. Real extraction is done by Claude. */
export function fakeProfileExtraction(text: string) {
  const cv = /<cv_text>\n?([\s\S]*?)\n?<\/cv_text>/.exec(text)?.[1] ?? text;
  const lines = cv.split("\n").map((l) => l.trim());
  const nonEmpty = lines.filter(Boolean);
  const experience: Array<Record<string, unknown>> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = RANGE.exec(lines[i]);
    if (!m) continue;
    const ownText = lines[i].replace(RANGE, "").trim();
    const { title, company } = splitTitleCompany(ownText.length > 3 ? lines[i] : lines[i - 1] ?? "");
    const highlights: string[] = [];
    for (let j = i + 1; j < lines.length && !RANGE.test(lines[j]); j++) {
      if (/^[-•*·]/.test(lines[j])) highlights.push(lines[j].replace(/^[-•*·]\s*/, ""));
    }
    experience.push({
      title,
      company,
      industry: null,
      location: null,
      country: null,
      start: ym(m[2], m[1], m[3]),
      end: m[7] ? null : ym(m[5], m[4], m[6]),
      seniority: /senior|sr\.?/i.test(title) ? "senior" : /lead/i.test(title) ? "lead" : /junior|jr\.?/i.test(title) ? "junior" : null,
      skills: KNOWN_SKILLS.filter(([name]) => mentions(highlights.join(" "), name)).map(([n]) => n),
      highlights,
    });
  }
  const country = /australia|sydney|melbourne|brisbane/i.test(cv) ? "AU" : null;
  const workRights: Array<Record<string, unknown>> = [];
  const citizen = /australian citizen/i.exec(cv);
  const pr = /permanent resident[^\n]*/i.exec(cv);
  const full = /full (?:working|work) rights[^\n]*/i.exec(cv);
  if (citizen) workRights.push({ country: "AU", status: "citizen", visa: null, evidence: citizen[0] });
  else if (pr && country) workRights.push({ country: "AU", status: "permanent_resident", visa: null, evidence: pr[0] });
  else if (full && country) workRights.push({ country: "AU", status: "unrestricted_visa", visa: null, evidence: full[0] });

  return {
    basics: {
      name: nonEmpty[0] && nonEmpty[0].length < 60 ? nonEmpty[0] : null,
      email: /[\w.+-]+@[\w-]+\.[\w.]+/.exec(cv)?.[0] ?? null,
      phone: /\+?\d[\d\s()-]{7,}\d/.exec(cv)?.[0]?.trim() ?? null,
      headline: nonEmpty[1] && nonEmpty[1].length < 90 && !RANGE.test(nonEmpty[1]) ? nonEmpty[1] : null,
      summary: null,
      city: /sydney|melbourne|brisbane|perth|adelaide|canberra|auckland|singapore|seoul/i.exec(cv)?.[0] ?? null,
      country,
      links: [...cv.matchAll(/https?:\/\/\S+/g)].map((m) => m[0]),
    },
    experience,
    skills: KNOWN_SKILLS.filter(([name]) => mentions(cv, name)).map(([name, category]) => ({ name, category })),
    education: [],
    certifications: [],
    languages: [
      ...(/[ㄱ-힝]|korean/i.test(cv) ? [{ language: "Korean", level: "native" }] : []),
      { language: "English", level: /native english/i.test(cv) ? "native" : "professional" },
    ],
    clearances: [],
    workRights,
    transcription: null,
  };
}

registerFakeGenerator("extractProfile", (req) => ({
  content: [{ type: "text", text: JSON.stringify(fakeProfileExtraction(allRequestText(req.body))) }],
}));
