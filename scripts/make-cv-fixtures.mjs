// Regenerates the PDF and DOCX CV fixtures from tests/fixtures/cv/sample-cv-en.txt.
// Usage: node scripts/make-cv-fixtures.mjs [chromiumPath]
import fs from "node:fs";
import { chromium } from "@playwright/test";
import { Document, Packer, Paragraph } from "docx";

const dir = "tests/fixtures/cv";
const text = fs.readFileSync(`${dir}/sample-cv-en.txt`, "utf8");
const lines = text.split("\n");

const doc = new Document({ sections: [{ children: lines.map((line) => new Paragraph({ text: line })) }] });
fs.writeFileSync(`${dir}/sample-cv-en.docx`, await Packer.toBuffer(doc));

const browser = await chromium.launch(process.argv[2] ? { executablePath: process.argv[2] } : {});
const page = await browser.newPage();
const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
// Two-column layout on purpose: machine text extraction can interleave columns.
await page.setContent(`<html><body style="font-family: Helvetica, Arial; font-size: 11px; display:flex; gap:24px">
  <div style="width:30%">${lines.slice(0, 5).map((l) => `<p>${escape(l)}</p>`).join("")}</div>
  <div style="width:70%">${lines.slice(5).map((l) => `<p>${escape(l)}</p>`).join("")}</div></body></html>`);
fs.writeFileSync(`${dir}/sample-cv-en.pdf`, await page.pdf({ format: "A4" }));
await browser.close();
console.log("fixtures written");
