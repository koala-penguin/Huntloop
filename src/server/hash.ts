import crypto from "node:crypto";
import { stableStringify } from "@/shared/stable-json";

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Hash of a JSON value with sorted keys, so equal content always hashes the same. */
export function hashJson(value: unknown): string {
  return sha256(stableStringify(value));
}
