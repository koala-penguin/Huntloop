"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { aiSettingsSchema, CONNECTIONS, type AiConfig, type AiSettings, type Connection } from "@/shared/ai-settings";
import { MODEL_IDS, type ModelId } from "@/shared/models";
import { isLocale, LOCALE_COOKIE } from "@/i18n/locales";
import { appContext } from "@/server/context";
import { getAiConfig, saveAiConfig, saveAiSettings, saveSourceSettings } from "@/server/repo/settings";
import { envDefaultModel } from "@/server/config/env";
import { sourceSettingsSchema, type SourceSettings } from "@/shared/source-settings";
import { withBrowserPage } from "@/server/browser/service";
import { errorCodeOf } from "@/server/errors";
import { setUserLocale } from "@/server/repo/users";
import { getAnthropic, modeFor } from "@/server/ai/client";
import { defaultConnection, getClaudeCodeStatus, isConsoleSignIn } from "@/server/ai/claude-code/status";

export async function setLocaleAction(locale: string): Promise<void> {
  if (!isLocale(locale)) throw new Error("Unsupported language");
  const store = await cookies();
  store.set(LOCALE_COOKIE, locale, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
  const { db, user } = appContext();
  setUserLocale(db, user.id, locale);
  revalidatePath("/", "layout");
}

export type SaveResult = { ok: true; settings: AiSettings } | { ok: false; error: string };

/** Saves one profile (API or subscription); which connection is active stays as it is. */
export async function saveAiSettingsAction(input: unknown): Promise<SaveResult> {
  const parsed = aiSettingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  const { db, user } = appContext();
  const settings = saveAiSettings(db, user.id, parsed.data, defaultConnection());
  revalidatePath("/", "layout");
  return { ok: true, settings };
}

/** Switches between the API key and the Claude subscription (from the next AI call). */
export async function setActiveConnectionAction(connection: string): Promise<{ ok: true; config: AiConfig } | { ok: false; error: string }> {
  if (!(CONNECTIONS as readonly string[]).includes(connection)) return { ok: false, error: "invalid" };
  const { db, user } = appContext();
  const config = getAiConfig(db, user.id, envDefaultModel(), defaultConnection());
  const saved = saveAiConfig(db, user.id, { ...config, active: connection as Connection });
  revalidatePath("/", "layout");
  return { ok: true, config: saved };
}

export interface ClaudeCodeView {
  found: boolean;
  version: string | null;
  loggedIn: boolean;
  authMethod: string | null;
  /** Signed in with a Console API key: billed per token, not the plan's limits. */
  consoleSignIn: boolean;
}

/** Asks the Claude Code CLI again whether it is installed and signed in (nothing about the credentials). */
export async function checkClaudeCodeAction(): Promise<ClaudeCodeView> {
  const status = await getClaudeCodeStatus({ refresh: true });
  revalidatePath("/", "layout");
  return { found: status.found, version: status.version, loggedIn: status.loggedIn, authMethod: status.authMethod, consoleSignIn: isConsoleSignIn(status.authMethod) };
}

export type ModelAccessResult =
  | { ok: true; mode: "live" | "fake"; available: ModelId[] }
  | { ok: false; error: string };

/** Lists the models this API key can use (Models API) and intersects them with Huntloop's registry. */
export async function checkModelAccessAction(): Promise<ModelAccessResult> {
  try {
    const mode = modeFor("api") === "api" ? "live" : "fake";
    const ids = new Set<string>();
    for await (const model of getAnthropic(mode).models.list()) ids.add(model.id);
    return { ok: true, mode, available: MODEL_IDS.filter((id) => ids.has(id)) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function saveSourceSettingsAction(input: unknown): Promise<{ ok: true; settings: SourceSettings } | { ok: false; error: string }> {
  const parsed = sourceSettingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const { db, user } = appContext();
  const settings = saveSourceSettings(db, user.id, parsed.data);
  revalidatePath("/", "layout");
  return { ok: true, settings };
}

/** Opens Huntloop's browser window briefly, to check it works on this computer. */
export async function testBrowserAction(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await withBrowserPage(async (page) => {
      await page.setContent(
        '<!doctype html><title>Huntloop</title><body style="font:16px system-ui;padding:2rem"><h1>Huntloop browser</h1><p>This window is where Huntloop reads SEEK and LinkedIn for you.</p></body>',
      );
      await page.waitForTimeout(1500);
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorCodeOf(error) ?? "browser_unavailable" };
  }
}
