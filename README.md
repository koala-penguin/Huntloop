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

## Going for a job: tailored CV and LinkedIn

When you decide to apply — with **Proceed & tailor my CV** on the job, or by accepting the AI's proposal in the chat —
the job moves to *Applying*, employer research starts if there's none yet, and the **CV** tab drafts a version of your CV
aimed at that job:

- Claude plans what to emphasise (the requirements you meet, the posting's own keywords for them, what to leave out,
  questions whose answers would strengthen the CV), then writes the summary, bullets and skills in the posting's language
  and the market's spelling (e.g. en-AU).
- **Your name, contact details, job titles, employers, dates, education and work rights come straight from your profile**
  — the AI can't change them. Market conventions are applied in code: no photo or date of birth anywhere; in Australia and
  New Zealand a work-rights line and "References available on request"; US Letter paper, and so on.
- **Every line is checked in code.** It must rest on quotes that really are in your CV (or in facts you confirmed), from
  the right role; numbers must appear in those quotes; requirements you don't meet must not be claimed, and posting
  skills the role doesn't show are caught. A line that fails is flagged: **remove** it, **rewrite it in your own words**,
  or **confirm it's true** (it's added to your profile as a fact). Downloads stay disabled until nothing is flagged.
- You get a preview, the share of posting keywords on your CV before → after, a length estimate, and **Word (.docx) and
  PDF** downloads — single column with standard headings, which applicant-tracking systems read best. Ask for changes in
  the CV tab or in the chat; each new version is checked again, and older versions stay available.
- Your **Interview Chance never uses the tailored CV**: it is computed from your verified profile only. Answers you give
  and lines you confirm become facts; reassess the job to use them.

**Profile → LinkedIn** writes your LinkedIn headline, About section and role descriptions once, for the target roles in
your job preferences, with the same checks plus LinkedIn's character limits (headline 220, About 2,600, each role 2,000).
Copy each section into LinkedIn yourself; Huntloop never signs in to or edits your LinkedIn. Each job's CV tab also lists
the points worth making prominent on LinkedIn for that job.

A tailored CV costs about $0.40–0.90 with Opus (plan + draft), a revision about $0.20–0.40, and LinkedIn text about
$0.20–0.40.

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
2,500 a month) are enforced. How many jobs each run assesses is set in **Settings → Search limits**.

### SEEK and LinkedIn

Neither site offers a job-search API, so Huntloop can read them in its **own, visible Chrome window** on your computer
(a separate profile in `data/browser-profile`). Both are **off until you turn them on** in **Settings → Job sources**,
after a risk notice: their terms of use don't allow automated access, and LinkedIn may restrict accounts it thinks are
automated. When on:

- searches open the site's search pages, collect job links, and read each job in full (no "Provisional" excerpts);
  pasted SEEK/LinkedIn links are read the same way;
- it only runs when you start a search or add a link, slowly (3–8 s between pages, at most the number of job pages you
  set per site);
- if a site shows a CAPTCHA, a sign-in wall or a checkpoint, the run **pauses** and asks you to deal with it in the
  window, then Continue — or skip that site. Huntloop never solves CAPTCHAs, hides that it's automated, or uses tricks to
  avoid detection;
- LinkedIn runs in **guest mode** by default. With "Use my LinkedIn login" you sign in yourself in the window; Huntloop
  never sees your password (guest mode is safer for your account).

It uses your installed Google Chrome; set `HUNTLOOP_BROWSER_PATH` in `.env.local` to use another Chrome/Chromium. Use
**Test the browser window** in Settings to check it opens.

### AI browsing agent (Chrome DevTools MCP)

For sites without a built-in reader, Claude can browse in the same visible window itself. Huntloop starts the
[Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) server, attached only to its own window
through a local port, and gives Claude a small set of its tools: open and switch pages, read the page, click, type, press
keys, wait. Turn it on in **Settings → Job sources** (after a notice). It's used for:

- **other job sites** you list there (e.g. a government jobs site): searches include them;
- **SEEK or LinkedIn when their pages change** and the built-in reader finds nothing (optional);
- **"Find on the employer's site"** on a job's Posting tab: looks for the job on the employer's careers pages and, if
  found, re-analyses it from the employer's full posting.

Safeguards, enforced in code before each action reaches the browser:

- it can only search and read. Clicks on "Apply", "Sign in", "Message", "Connect", "Save", "Share" and similar (in English
  and Korean) are refused, and it can only type short search terms into search fields;
- it stays on the sites allowed for the task: the site you listed; or, when looking for a job on the employer's site,
  that site, sites it found through web search, and applicant-tracking systems such as Greenhouse, Lever or Workday (never
  SEEK, LinkedIn or other job boards Huntloop doesn't read). Other links are refused;
- it has no script execution, file upload, network or performance tools. Chrome DevTools MCP's usage statistics are
  turned off;
- a job is kept only if the agent actually opened its page, and Huntloop reads that page itself;
- a CAPTCHA or sign-in wall pauses the run for you, as above. Runs are capped in steps and jobs, and cost about
  $0.50–2 each with Opus (counted towards your spending cap).

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
4. **AI search** — Adzuna and a Claude web-search agent ✅; SEEK and LinkedIn through a visible (headed) browser ✅;
   an AI browsing agent through Chrome DevTools MCP ✅.
5. **Proceed → CV tailoring** — once you and the AI agree to go for a job, a tailored CV (DOCX/PDF) where every claim is
   traceable to your real experience, and LinkedIn profile text for your target roles. ✅
6. **The loop** — pipeline board with outcomes, saved searches, an employer watchlist, a coach chat across all jobs.

## License

MIT
