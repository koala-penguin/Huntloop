import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";

export type DocumentKind = "pdf" | "docx" | "text";

/** Detects the document type from its bytes (not the file name). */
export function detectDocumentKind(bytes: Uint8Array): DocumentKind | null {
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "pdf"; // %PDF
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return "docx"; // zip
  // Plain text: valid UTF-8 without NUL bytes.
  if (bytes.includes(0)) return null;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return "text";
  } catch {
    return null;
  }
}

export async function extractDocumentText(kind: DocumentKind, bytes: Uint8Array): Promise<string> {
  if (kind === "pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    return normalizeText(Array.isArray(text) ? text.join("\n") : text);
  }
  if (kind === "docx") {
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return normalizeText(value);
  }
  return normalizeText(new TextDecoder("utf-8").decode(bytes));
}

export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
