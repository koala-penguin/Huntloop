import { createTranslator } from "next-intl";
import en from "../../../messages/en.json";
import ko from "../../../messages/ko.json";
import type { CvLanguage } from "@/shared/schemas/cv";

/**
 * Headings and labels inside a CV, in the CV's language (the posting's), which can differ from the
 * app's language. Works outside a request (tasks, route handlers, tests).
 */
export function cvTranslator(language: CvLanguage) {
  return createTranslator({ locale: language, messages: language === "ko" ? ko : en, namespace: "cvDocument" });
}
export type CvTranslator = ReturnType<typeof cvTranslator>;

/** "2021-03" → "Mar 2021" / "2021년 3월"; "2021" stays "2021". */
export function formatCvDate(value: string | null, locale: string): string | null {
  if (!value) return null;
  const m = /^(\d{4})(?:-(\d{2}))?$/.exec(value);
  if (!m) return value;
  if (!m[2]) return m[1];
  return new Intl.DateTimeFormat(locale, { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)));
}

export function countryName(code: string | null, locale: string): string | null {
  if (!code) return null;
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}
