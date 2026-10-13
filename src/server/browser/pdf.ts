import "server-only";
import { chromium, type Browser } from "playwright-core";
import { UserFacingError } from "../errors";
import { browserCandidates } from "./service";

/**
 * HTML → PDF for CV export. Chrome only prints PDFs headless, so each export starts its own short-
 * lived headless browser (separate from the visible window used for job sites). The page can't
 * load anything from the network. Exports run one at a time.
 */

let chain: Promise<unknown> = Promise.resolve();

export function htmlToPdf(html: string, paper: "A4" | "Letter"): Promise<Buffer> {
  const run = chain.then(() => render(html, paper));
  chain = run.catch(() => undefined);
  return run;
}

async function render(html: string, paper: "A4" | "Letter"): Promise<Buffer> {
  let browser: Browser | undefined;
  let first: unknown;
  for (const candidate of browserCandidates()) {
    try {
      browser = await chromium.launch({ headless: true, ...candidate });
      break;
    } catch (error) {
      first ??= error;
    }
  }
  if (!browser) throw new UserFacingError("browser_unavailable", String(first));
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) => (route.request().url().startsWith("data:") ? route.continue() : route.abort()));
    await page.setContent(html, { waitUntil: "load" });
    return await page.pdf({ format: paper, preferCSSPageSize: true, printBackground: false, tagged: true, outline: true });
  } finally {
    await browser.close();
  }
}
