# Contributing

Thanks for helping out. Here's what you need to know before opening a pull request.

## Setup

```bash
npm install
cp .env.example .env.local
npm run dev   # http://127.0.0.1:3000
```

You don't need an API key. Without one the app runs in demo mode with simulated AI answers, and that's also what the
tests use.

## Before you push

```bash
npm run lint && npm run typecheck && npm test
npm run test:e2e   # if you changed anything in the UI
```

CI runs the same checks on every pull request.

## How the code is organised

[AGENTS.md](AGENTS.md) has the conventions. The ones people trip over most:

- Every piece of text in the UI lives in both `messages/en.json` and `messages/ko.json`, with the same keys. The linter
  rejects hard-coded strings.
- Claude is only called through `src/server/ai/client.ts`.
- Every AI task needs a demo-mode generator in `src/server/ai/fake/`, so the app and the tests work without a key.
- Database changes go in `src/server/db/schema.ts`, followed by `npm run db:generate`.

## Lines we don't cross

These matter more than any code style. Pull requests that cross them won't be merged.

- **Job sites.** Huntloop reads SEEK, LinkedIn and other sites only when the user starts it, slowly, in a visible window.
  No CAPTCHA solving, no stealth plugins or fingerprint tricks, no proxy rotation, no unattended or scheduled runs on
  those sites. When a site asks for a check or a sign-in, pause and hand it to the user.
- **Claude sign-in.** Never read, store or pass on the user's Claude credentials. The subscription connection only runs
  the user's own `claude` command.
- **People.** Employer research is about companies. Don't build anything that profiles individual employees.
- **Privacy.** No telemetry. The user's data stays on their machine.
- **Test data.** Don't commit real CVs, personal details or API keys. Use made-up people and companies in fixtures.

## Pull requests

Keep them small and about one thing. Say what changed and how you tested it. For UI changes, add a screenshot (in both
languages if you touched any text).
