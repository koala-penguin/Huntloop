import type { Page } from "playwright-core";
import { CHALLENGE } from "../ingest/html";

export type BlockKind = "captcha" | "login" | "checkpoint";

const LOGIN_URL = /\/(login|signin|sign-in|authwall|uas\/login|oauth)(\/|\?|$)/i;
const CHECKPOINT_URL = /\/checkpoint\//i;
const LOGIN_TEXT = /sign in to (view|see|continue)|join (linkedin|now) to see|log in to (view|continue)|please sign in/i;

/** Classifies what a page shows: a bot check, a sign-in wall, a security checkpoint — or nothing. */
export function classifyBlock(url: string, title: string, text: string): BlockKind | null {
  if (CHECKPOINT_URL.test(url)) return "checkpoint";
  const head = `${title}\n${text.slice(0, 3_000)}`;
  if (CHALLENGE.test(head) && text.length < 5_000) return "captcha";
  if (LOGIN_URL.test(new URL(url).pathname + new URL(url).search)) return "login";
  if (LOGIN_TEXT.test(head) && text.length < 5_000) return "login";
  return null;
}

export async function detectBlock(page: Page): Promise<BlockKind | null> {
  const [title, text] = await Promise.all([page.title().catch(() => ""), page.evaluate(() => document.body?.innerText ?? "").catch(() => "")]);
  return classifyBlock(page.url(), title, text);
}
