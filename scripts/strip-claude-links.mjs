// Removes Claude Code session links and attribution lines from commit messages, PR descriptions and comments.
// Used by .githooks/commit-msg (node scripts/strip-claude-links.mjs <message-file>) and by the
// "Strip Claude links" workflow on GitHub.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const ATTRIBUTION = [
  /^\s*Claude-Session:/i,
  /^\s*Co-Authored-By:.*\bClaude\b/i,
  // Links only: a plain mention of the address in prose stays.
  /https?:\/\/claude\.ai\/code/i,
  /https?:\/\/(www\.)?claude\.com\/claude-code/i,
];

/** The text without attribution lines (and the "---" rule above a footer). Unchanged when there's nothing to remove. */
export function stripClaudeLinks(text) {
  const lines = text.split("\n");
  const kept = [];
  let removed = false;
  for (const line of lines) {
    if (!ATTRIBUTION.some((re) => re.test(line))) {
      kept.push(line);
      continue;
    }
    removed = true;
    // A footer usually sits under a blank line and a "---" rule; drop those too.
    while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
    if (kept.length && kept[kept.length - 1].trim() === "---") kept.pop();
  }
  return removed ? kept.join("\n").trimEnd() : text;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node scripts/strip-claude-links.mjs <file>");
    process.exit(1);
  }
  const text = fs.readFileSync(file, "utf8");
  const cleaned = stripClaudeLinks(text);
  if (cleaned !== text) fs.writeFileSync(file, `${cleaned}\n`);
}
