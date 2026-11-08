#!/usr/bin/env node
// Finds AI output in an existing Huntloop database that the demo simulator wrote before Huntloop
// recorded it (posting analyses, assessments, employer reports, profile versions, translations,
// CVs). Read-only by default; safe while the app runs.
//
//   node scripts/demo-audit.mjs [--db <path>]           report only
//   node scripts/demo-audit.mjs [--db <path>] --mark    show what would be labelled
//   node scripts/demo-audit.mjs [--db <path>] --mark --yes
//                                                       back up, then label (stop the app first)
//
// Default database: $HUNTLOOP_DATA_DIR/huntloop.db, else ./data/huntloop.db. Plain node doesn't read
// .env.local, so run it from the checkout the app uses or pass --db.
import { createRequire } from "node:module";
import { run } from "./demo-audit-lib.mjs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

process.exitCode = run(process.argv.slice(2), { openDatabase: (file, options) => new Database(file, options) });
