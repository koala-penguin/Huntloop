import type { CvDocument } from "@/shared/schemas/cv";
import { countryName, formatCvDate, type CvTranslator } from "./i18n";

/**
 * One layout for every format: the HTML preview and PDF, the DOCX file and plain text are all
 * rendered from these blocks, so they always contain the same words. Single column, standard
 * headings, no tables or graphics — what applicant-tracking systems read best.
 */
export type CvBlock =
  | { kind: "name"; text: string }
  | { kind: "headline"; text: string }
  | { kind: "contact"; text: string }
  | { kind: "rights"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; parts: Array<{ text: string; lineId: string | null }> }
  | { kind: "role"; title: string; meta: string }
  | { kind: "bullet"; text: string; lineId: string | null }
  | { kind: "note"; text: string };

const join = (parts: Array<string | null | undefined>, sep: string) => parts.filter((p) => p && p.trim()).join(sep);

/** "Australian citizen" for a known market option; otherwise "Citizen of {country}" and similar. */
function workRightText(right: NonNullable<CvDocument["workRight"]>, t: CvTranslator, locale: string): string {
  const key = `workRightOption.${right.option}`;
  if (right.option && t.has(key as "workRightOption.au_citizen")) return t(key as "workRightOption.au_citizen");
  return t(`workRight.${right.status as "citizen"}`, { country: countryName(right.country, locale) ?? right.country });
}

export function cvBlocks(doc: CvDocument, t: CvTranslator): CvBlock[] {
  const locale = doc.locale;
  const blocks: CvBlock[] = [];
  const h = doc.header;
  if (h.name) blocks.push({ kind: "name", text: h.name });
  if (h.headline) blocks.push({ kind: "headline", text: h.headline });
  const contact = join([join([h.city, countryName(h.country, locale)], ", "), h.email, h.phone, ...h.links], " · ");
  if (contact) blocks.push({ kind: "contact", text: contact });
  if (doc.workRight) blocks.push({ kind: "rights", text: workRightText(doc.workRight, t, locale) });

  if (doc.summary.length) {
    blocks.push({ kind: "heading", text: t("summary") }, { kind: "paragraph", parts: doc.summary.map((l) => ({ text: l.text, lineId: l.id })) });
  }
  if (doc.skills.length) blocks.push({ kind: "heading", text: t("skills") }, { kind: "paragraph", parts: [{ text: doc.skills.join(", "), lineId: null }] });
  if (doc.roles.length) {
    blocks.push({ kind: "heading", text: t("experience") });
    for (const r of doc.roles) {
      const dates = join([formatCvDate(r.start, locale), r.end ? formatCvDate(r.end, locale) : t("present")], " – ");
      blocks.push({ kind: "role", title: join([r.title, r.company], " — "), meta: join([r.location, dates], " · ") });
      for (const b of r.bullets) blocks.push({ kind: "bullet", text: b.text, lineId: b.id });
    }
  }
  if (doc.education.length) {
    blocks.push({ kind: "heading", text: t("education") });
    for (const e of doc.education) {
      blocks.push({ kind: "paragraph", parts: [{ text: join([join([e.degree, e.field], ", "), e.institution, formatCvDate(e.end, locale)], " — "), lineId: null }] });
    }
  }
  if (doc.certifications.length) {
    blocks.push({ kind: "heading", text: t("certifications") });
    for (const c of doc.certifications) blocks.push({ kind: "bullet", text: join([c.name, c.issuer, c.year], " — "), lineId: null });
  }
  if (doc.languages.length) {
    const levels = ["native", "fluent", "professional", "conversational", "basic"];
    const text = doc.languages.map((l) => (levels.includes(l.level) ? `${l.language} (${t(`languageLevel.${l.level as "native"}`)})` : l.language)).join(" · ");
    blocks.push({ kind: "heading", text: t("languages") }, { kind: "paragraph", parts: [{ text, lineId: null }] });
  }
  if (doc.clearances.length) {
    const text = doc.clearances.map((c) => `${c.level} (${t(`clearanceStatus.${c.status as "active"}`)})`).join(" · ");
    blocks.push({ kind: "heading", text: t("clearances") }, { kind: "paragraph", parts: [{ text, lineId: null }] });
  }
  if (doc.referees) blocks.push({ kind: "note", text: t("referees") });
  return blocks;
}

export function cvPlainText(doc: CvDocument, t: CvTranslator): string {
  return cvBlocks(doc, t)
    .map((b) => {
      switch (b.kind) {
        case "paragraph":
          return b.parts.map((p) => p.text).join(" ");
        case "role":
          return `${b.title}\n${b.meta}`;
        case "bullet":
          return `• ${b.text}`;
        default:
          return b.text;
      }
    })
    .join("\n");
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const FONTS = `Calibri, Carlito, "Segoe UI", Arial, "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", "Noto Sans CJK KR", sans-serif`;

/**
 * A standalone HTML document. `highlight` marks lines that still need the user's attention (preview
 * only — exports never pass it).
 */
export function renderCvHtml(doc: CvDocument, t: CvTranslator, options: { highlight?: Set<string> } = {}): string {
  const mark = (lineId: string | null) => (lineId && options.highlight?.has(lineId) ? ` class="flag" data-line="${escapeHtml(lineId)}"` : lineId ? ` data-line="${escapeHtml(lineId)}"` : "");
  const body: string[] = [];
  let list: string[] | null = null;
  const closeList = () => {
    if (list) body.push(`<ul>${list.join("")}</ul>`);
    list = null;
  };
  for (const b of cvBlocks(doc, t)) {
    if (b.kind === "bullet") {
      (list ??= []).push(`<li${mark(b.lineId)}>${escapeHtml(b.text)}</li>`);
      continue;
    }
    closeList();
    if (b.kind === "name") body.push(`<h1>${escapeHtml(b.text)}</h1>`);
    else if (b.kind === "headline") body.push(`<p class="headline">${escapeHtml(b.text)}</p>`);
    else if (b.kind === "contact") body.push(`<p class="contact">${escapeHtml(b.text)}</p>`);
    else if (b.kind === "rights") body.push(`<p class="rights">${escapeHtml(b.text)}</p>`);
    else if (b.kind === "heading") body.push(`<h2>${escapeHtml(b.text)}</h2>`);
    else if (b.kind === "paragraph") body.push(`<p>${b.parts.map((p) => `<span${mark(p.lineId)}>${escapeHtml(p.text)}</span>`).join(" ")}</p>`);
    else if (b.kind === "role") body.push(`<h3>${escapeHtml(b.title)}</h3><p class="meta">${escapeHtml(b.meta)}</p>`);
    else if (b.kind === "note") body.push(`<p class="note">${escapeHtml(b.text)}</p>`);
  }
  closeList();
  const size = doc.paper === "Letter" ? "Letter" : "A4";
  return `<!doctype html>
<html lang="${escapeHtml(doc.language)}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(doc.header.name ?? "CV")}</title>
<style>
@page { size: ${size}; margin: 16mm 17mm; }
html { background: #fff; color: #111; }
body { font-family: ${FONTS}; font-size: 10.5pt; line-height: 1.38; margin: 0; padding: 0; }
@media screen { body { padding: 24px 28px; } }
h1 { font-size: 20pt; margin: 0 0 2pt; }
h2 { font-size: 11.5pt; text-transform: uppercase; letter-spacing: 0.04em; border-bottom: 1px solid #999; margin: 12pt 0 4pt; padding-bottom: 1pt; }
h3 { font-size: 10.5pt; margin: 8pt 0 0; break-after: avoid; }
p { margin: 0 0 4pt; }
.headline { font-size: 11.5pt; }
.contact, .meta { color: #333; }
.rights { font-weight: 600; }
.note { margin-top: 12pt; font-style: italic; }
ul { margin: 2pt 0 4pt; padding-left: 16pt; }
li { margin: 0 0 2pt; break-inside: avoid; }
.flag { background: #fff3c4; outline: 1px dashed #b7791f; }
</style>
</head>
<body>
${body.join("\n")}
</body>
</html>`;
}
