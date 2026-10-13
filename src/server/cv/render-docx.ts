import { AlignmentType, BorderStyle, Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import type { CvDocument } from "@/shared/schemas/cv";
import { cvBlocks } from "./render";
import type { CvTranslator } from "./i18n";

/** Page sizes in twentieths of a point. */
const PAGE = { A4: { width: 11906, height: 16838 }, Letter: { width: 12240, height: 15840 } } as const;
const MARGIN = 964; // 17 mm

/**
 * An ATS-friendly Word file: one column, Word's own heading styles, real bullet lists, contact
 * details in the body (not a header), no tables, text boxes or images.
 */
export async function buildCvDocx(doc: CvDocument, t: CvTranslator): Promise<Buffer> {
  const children: Paragraph[] = [];
  for (const b of cvBlocks(doc, t)) {
    switch (b.kind) {
      case "name":
        children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: b.text })] }));
        break;
      case "headline":
        children.push(new Paragraph({ children: [new TextRun({ text: b.text, size: 23 })] }));
        break;
      case "contact":
        children.push(new Paragraph({ children: [new TextRun({ text: b.text })] }));
        break;
      case "rights":
        children.push(new Paragraph({ children: [new TextRun({ text: b.text, bold: true })] }));
        break;
      case "heading":
        children.push(
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 200, after: 60 },
            border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "999999", space: 1 } },
            children: [new TextRun({ text: b.text })],
          }),
        );
        break;
      case "paragraph":
        children.push(new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: b.parts.map((p) => p.text).join(" ") })] }));
        break;
      case "role":
        children.push(
          new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 140 }, keepNext: true, children: [new TextRun({ text: b.title })] }),
          new Paragraph({ keepNext: true, children: [new TextRun({ text: b.meta })] }),
        );
        break;
      case "bullet":
        children.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: b.text })] }));
        break;
      case "note":
        children.push(new Paragraph({ spacing: { before: 240 }, alignment: AlignmentType.LEFT, children: [new TextRun({ text: b.text, italics: true })] }));
        break;
    }
  }
  const font = doc.language === "ko" ? { ascii: "Calibri", hAnsi: "Calibri", cs: "Calibri", eastAsia: "Malgun Gothic" } : "Calibri";
  const file = new Document({
    creator: "Huntloop",
    title: doc.header.name ?? "CV",
    styles: {
      default: {
        document: { run: { font, size: 21, color: "111111" }, paragraph: { spacing: { after: 40, line: 264 } } },
        title: { run: { font, size: 40, bold: true, color: "111111" } },
        heading1: { run: { font, size: 23, bold: true, allCaps: true, color: "111111" } },
        heading2: { run: { font, size: 21, bold: true, color: "111111" } },
      },
    },
    sections: [{ properties: { page: { size: PAGE[doc.paper], margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } } }, children }],
  });
  return Packer.toBuffer(file);
}
