import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import { dataPath, readEnv } from "../config/env";
import type { BlockKind } from "./challenge";

/**
 * When a SEEK / LinkedIn / browsing-agent run stops at a CAPTCHA, sign-in wall or checkpoint, this
 * keeps a record of it: a screenshot, the site, URL and time under data/captcha-events/, a count per
 * site, and (optional) a Discord message so the user can deal with it by hand. It only observes and
 * reports: Huntloop never solves the check, and the run still waits for the user as before.
 */

export interface BlockEvent {
  site: string;
  kind: BlockKind;
  url: string;
  title: string;
  at: string;
  /** Path of the saved PNG, or null when the screenshot failed. */
  screenshot: string | null;
}

export interface BlockEventOptions {
  /** Where events are saved (default data/captcha-events). */
  dir?: string;
  /** Discord webhook URL (default HUNTLOOP_DISCORD_WEBHOOK); null turns alerts off. */
  webhook?: string | null;
  fetchImpl?: typeof fetch;
  now?: Date;
}

type Counts = Record<string, { total: number; byKind: Record<string, number>; last: string }>;

function validWebhook(value: string | null | undefined): string | null {
  if (!value) return null;
  if (URL.canParse(value)) {
    const protocol = new URL(value).protocol;
    if (protocol === "https:" || protocol === "http:") return value;
  }
  // Never print the value: a webhook URL carries a secret.
  console.warn("[huntloop] HUNTLOOP_DISCORD_WEBHOOK is not a valid URL; alerts are off");
  return null;
}

export async function recordBlockEvent(
  page: Pick<Page, "screenshot" | "title" | "url">,
  info: { site: string; kind: BlockKind; waiting: boolean },
  options: BlockEventOptions = {},
): Promise<BlockEvent> {
  const dir = options.dir ?? dataPath("captcha-events");
  fs.mkdirSync(dir, { recursive: true });
  const at = (options.now ?? new Date()).toISOString();
  const stem = path.join(dir, `${at.replace(/[:.]/g, "-")}-${info.site.replace(/[^\w.-]+/g, "_")}-${info.kind}`);

  // Screenshot first, while the check is still on screen.
  let screenshot: string | null = `${stem}.png`;
  try {
    // Bounded like the webhook: the Continue prompt appears after this.
    await page.screenshot({ path: screenshot, type: "png", timeout: 5_000 });
  } catch {
    screenshot = null;
  }
  const event: BlockEvent = { site: info.site, kind: info.kind, url: page.url(), title: await page.title().catch(() => ""), at, screenshot };
  fs.writeFileSync(`${stem}.json`, JSON.stringify(event, null, 2));

  // Per-site counts. Browser work runs one task at a time, so a plain read-modify-write is enough.
  const countsFile = path.join(dir, "counts.json");
  let counts: Counts = {};
  try {
    counts = JSON.parse(fs.readFileSync(countsFile, "utf8")) as Counts;
  } catch {
    counts = {};
  }
  const site = (counts[info.site] ??= { total: 0, byKind: {}, last: at });
  site.total++;
  site.byKind[info.kind] = (site.byKind[info.kind] ?? 0) + 1;
  site.last = at;
  fs.writeFileSync(countsFile, JSON.stringify(counts, null, 2));
  console.info(`[huntloop] ${info.site} paused on a ${info.kind} at ${event.url}; saved ${screenshot ?? `${stem}.json`}`);

  // Only alert when someone can act (a task is waiting for the user to press Continue).
  const webhook = info.waiting ? validWebhook(options.webhook === undefined ? readEnv().HUNTLOOP_DISCORD_WEBHOOK : options.webhook) : null;
  if (webhook) {
    try {
      const time = new Date(at).toLocaleString();
      const form = new FormData();
      form.append(
        "payload_json",
        JSON.stringify({
          content: `Huntloop paused on ${info.site}: ${info.kind} at ${event.url} (${time}). Deal with it in Huntloop's browser window, then press Continue.`,
          allowed_mentions: { parse: [] },
        }),
      );
      if (screenshot) form.append("files[0]", new Blob([fs.readFileSync(screenshot)], { type: "image/png" }), path.basename(screenshot));
      // Bounded: the pause prompt appears after this.
      const res = await (options.fetchImpl ?? fetch)(webhook, { method: "POST", body: form, signal: AbortSignal.timeout(5_000) });
      if (!res.ok) console.warn("[huntloop] CAPTCHA alert webhook failed", res.status);
    } catch (error) {
      console.warn("[huntloop] CAPTCHA alert webhook failed", error instanceof Error ? error.name : "error");
    }
  }
  return event;
}
