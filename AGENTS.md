<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Huntloop conventions

- **Architecture**: `src/server/**` is server-only (`import "server-only"` where it touches secrets or the DB from app code); `src/shared/**` is isomorphic; pages read data through `appContext()` (`src/server/context.ts`).
- **i18n**: every user-visible string lives in `messages/en.json` and `messages/ko.json` with identical keys and placeholders (enforced by `tests/unit/i18n.test.ts` and the `react/jsx-no-literals` lint rule). AI-written prose is generated in the user's language; enums and labels are rendered from the catalogs.
- **Claude calls** go through `callModel` / `callStructured` in `src/server/ai/client.ts` only. They stream, always send adaptive thinking with an explicit `effort`, never send sampling parameters or forced `tool_choice`, add `fallbacks: "default"` where the model supports it, log cost to `usage_log`, and honour the budget guard. Model/effort per task come from Settings (`src/shared/ai-settings.ts`); capabilities per model live in `src/shared/models.ts`.
- **Demo mode**: without `ANTHROPIC_API_KEY` (or with `HUNTLOOP_AI=fake`) the SDK talks to `src/server/ai/fake/transport.ts`. Every structured AI task must register a fake generator so demo mode and tests work.
- **Database**: Drizzle + better-sqlite3. Change `src/server/db/schema.ts`, then `npm run db:generate`; migrations apply at startup.
- **Background work** uses the DB-backed runner (`src/server/tasks/runner.ts`); register handlers in `src/server/tasks/handlers/`.
- **Checks before committing**: `npm run lint && npm run typecheck && npm test` (and `npm run test:e2e` for UI flows).
