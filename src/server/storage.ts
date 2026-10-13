import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { dataDir } from "./config/env";

export type UploadArea = "cv" | "postings" | "exports";

export function uploadsDir(area: UploadArea): string {
  return path.join(dataDir(), "uploads", area);
}

export function safeFileName(name: string): string {
  const base = path.basename(name).normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^\.+/, "");
  return (base || "file").slice(-100);
}

/** Stores bytes under data/uploads/<area>/ with a unique name; returns the absolute path. */
export async function saveUpload(area: UploadArea, fileName: string, bytes: Uint8Array): Promise<string> {
  const dir = uploadsDir(area);
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${safeFileName(fileName)}`);
  await fs.writeFile(target, bytes);
  return target;
}

/** Reads a previously stored upload, refusing paths outside the uploads folder. */
export async function readUpload(filePath: string): Promise<Uint8Array> {
  const root = path.resolve(path.join(dataDir(), "uploads"));
  const resolved = path.resolve(filePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error("Refusing to read outside the uploads folder");
  return new Uint8Array(await fs.readFile(resolved));
}
