# Huntloop

Land a new job with your personal AI Agent.

Huntloop is a local, single-user web app that works with you through the whole job hunt. The first module is **job search**:
find the postings where you have the best chance of getting an interview, understand them, research the employer, and
— once you decide to go for one — tailor your CV to it. It's built for Australia first (also NZ, Singapore, the US, and any
other country you configure), with the UI fully in **English and Korean**.

## Quick start

Requirements: Node.js 20.9 or newer.

```bash
npm install
cp .env.example .env.local   # then add your ANTHROPIC_API_KEY
npm run build && npm start   # http://127.0.0.1:3000
```

- Without `ANTHROPIC_API_KEY` the app runs in **demo mode**: every AI feature works with simulated responses, so you can
  click through everything without spending anything.
- `npm run dev` is fine for development, but use `npm run build && npm start` for real use: long background tasks
  (searches, research) restart when the dev server hot-reloads.
- The server binds to `127.0.0.1` only. Huntloop has no login and stores your CV and job data locally in `./data`
  (change with `HUNTLOOP_DATA_DIR`). CVs, postings and screenshots are sent only to the Anthropic API.

## Adding a job

On **Jobs**, paste a job link or the posting's text, or drop in screenshots (several parts of one long posting are fine) or
a PDF. Huntloop:

- reads the posting — Greenhouse, Lever and Ashby links through their public job APIs; other links through a guarded fetch
  (structured page data first, then the readable text). SEEK, LinkedIn, Indeed and similar sites aren't read automatically;
  Huntloop asks for the text or screenshots instead. Screenshots are transcribed by Claude, and you can correct the text;
- lists every requirement with a verbatim quote from the posting (quotes that can't be found are dropped);
- compares each requirement with your profile, quoting your CV as evidence (also checked word for word);
- works out your **Interview Chance** in code: hard requirements first (work rights, citizenship, clearance, location,
  posting age), then a tier — **Strong, Good, Stretch or Long shot** — with what would move you up a tier.

Answering a Yes/No question or your work rights for that country re-tiers the job instantly, without another AI call.
Results are cached, so reopening a job costs nothing.

Each job also has:

- **Ask AI** — a conversation with Claude about that job. It knows your profile, the posting and the analysis, can
  search the web, save notes and update the job's status. It can *propose* adding a fact to your profile or going ahead
  with the application; those only happen when you click to confirm.
- **Employer** — deep research on the company (what it does, recent activity, growth, leadership changes, hiring,
  culture, red flags) with a source link and date for every claim, open-role counts from the employer's own job board
  where available, and advice for your application. Reports are kept for 30 days and shared with the chat.

## Searching for jobs

On **Search**, describe what you want in your own words (any language), or leave it empty to use your job
preferences. Huntloop turns the request into filters you can edit, then:

1. gathers jobs from the **Adzuna** job API (free key — add `ADZUNA_APP_ID` and `ADZUNA_APP_KEY` to `.env.local`;
   AU, NZ, SG, US and more) and a **Claude web-search agent** that looks for postings on employers' own career and
   applicant-tracking pages (only links it actually saw in search results are kept);
2. removes duplicates and jobs already in your list, and rules out clear mismatches in code (excluded companies or
   words, too old, outside your countries, unrelated titles) before any AI call;
3. gives the most relevant ones a quick Interview Chance check (marked **Provisional**, since search results are
   short excerpts), and reads the full posting of the best few for a complete assessment.

Results are grouped by tier, with what's **new since the last run**. Adzuna's limits (25 calls a minute, 250 a day,
2,500 a month) are enforced. How many jobs each run assesses is set in **Settings → Search limits**. SEEK and LinkedIn
come next, through a visible browser window on your computer.

## Models and cost

Every AI task uses **Claude Opus 5.5** by default. In **Settings → AI models** you can pick a different default model and
override the model and effort level per task (CV reading, posting analysis, interview-chance assessment, screening, chat,
search agent, employer research, CV tailoring, …). Settings also has daily/monthly spending caps; background work pauses
when a cap is reached. Spend is computed from the API's usage data (including refusal-fallback attempts and web searches)
and shown on the dashboard.

Refusal fallbacks (`fallbacks: "default"`) are enabled on models that support them, so a false-positive safety decline is
retried on another model instead of failing.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Development server on 127.0.0.1:3000 |
| `npm run build` / `npm start` | Production build / server |
| `npm run lint` | ESLint (includes a rule that every UI string comes from `messages/*.json`) |
| `npm run typecheck` | Route type generation + `tsc` |
| `npm test` | Unit tests (Vitest, demo-mode AI) |
| `npm run test:e2e` | Browser tests (Playwright) against a production build with simulated AI |
| `npm run db:generate` | Generate a migration after changing `src/server/db/schema.ts` |

## Project layout

```
src/app/          pages, route handlers, server actions (Next.js App Router)
src/components/   UI (ui/ primitives, feature components)
src/shared/       code used by both server and browser (model registry, AI settings schema, Zod schemas)
src/server/       server-only: database, repositories, Claude client, AI tasks, background task runner
messages/         en.json and ko.json — every user-visible string
drizzle/          SQL migrations (applied automatically at startup)
tests/            unit/ (Vitest), e2e/ (Playwright)
```

## Roadmap

1. **Foundation** — app shell, English/Korean, settings for models/effort/budget, Claude client, background tasks. ✅
2. **Profile** — CV upload → structured profile, work rights per country, preferences. ✅
3. **Bring your own job** — add postings by URL, long pasted text, screenshots or PDF; "Interview Chance" tier with
   evidence; per-job AI chat; employer deep research. ✅
4. **AI search** — Adzuna and a Claude web-search agent ✅; SEEK and LinkedIn through a visible (headed) browser, and
   Chrome DevTools MCP for AI-driven browsing.
5. **Proceed → CV tailoring** — once you and the AI agree to go for a job, a tailored CV (DOCX/PDF) where every claim is
   traceable to your real experience.

## License

MIT
