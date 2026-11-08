// Pure part of scripts/demo-audit.mjs: classifies rows written before Huntloop recorded whether
// AI output came from the demo simulator (`simulated` IS NULL), using the usage log.
import fs from "node:fs";
import path from "node:path";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/**
 * Which usage_log tasks produced each table's rows, and the window around a row's created_at in
 * which the calls happened. Company reports are saved after the ATS board fetch, and CVs after
 * several calls, so they look further back.
 */
export const AUDIT_TABLES = [
  { table: "posting_analyses", tasks: ["analyzePosting", "screen"], before: 2 * SECOND, after: 2 * SECOND, user: false },
  { table: "assessments", tasks: ["assess", "screen"], before: 2 * SECOND, after: 2 * SECOND, user: false },
  { table: "company_reports", tasks: ["companyResearch"], before: 15 * MINUTE, after: 0, user: false },
  { table: "profile_versions", tasks: ["extractProfile"], before: 2 * SECOND, after: 2 * SECOND, user: true },
  { table: "ai_texts", tasks: ["translate"], before: 2 * SECOND, after: 2 * SECOND, user: false },
  { table: "cv_documents", tasks: ["planTailoring", "tailorCv", "linkedinProfile"], before: 15 * MINUTE, after: 0, user: true },
];

/** `<data dir>/huntloop.db`: --db, else $HUNTLOOP_DATA_DIR, else ./data (plain node doesn't read .env.local). */
export function resolveDbPath(args, env = process.env, cwd = process.cwd()) {
  if (args.db) return path.resolve(cwd, args.db);
  const dir = env.HUNTLOOP_DATA_DIR ? env.HUNTLOOP_DATA_DIR : path.join(cwd, "data");
  return path.resolve(cwd, dir, "huntloop.db");
}

export function parseArgs(argv) {
  const args = { db: null, mark: false, yes: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") args.db = argv[++i] ?? null;
    else if (a.startsWith("--db=")) args.db = a.slice(5);
    else if (a === "--mark") args.mark = true;
    else if (a === "--yes") args.yes = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

/** True once the app (with the demo label) has migrated this database. */
export function hasSimulatedColumn(db) {
  return AUDIT_TABLES.every(({ table }) => db.prepare(`select name from pragma_table_info(?)`).all(table).some((c) => c.name === "simulated"));
}

function verdictOf(matches) {
  if (!matches.length) return "unknown";
  if (matches.every((m) => m.simulated === 1)) return "demo";
  if (matches.every((m) => m.simulated === 0)) return "real";
  return "unknown";
}

/**
 * For every table: totals, how many rows are unlabelled (NULL), and the verdict per unlabelled row
 * — demo if every matching usage row was simulated, real if none was, unknown if none matched or mixed.
 * Profile versions with no extraction call are user edits and take the previous version's verdict.
 */
export function classify(db) {
  /** @type {Record<string, { total: number; nulls: number; labelledDemo: number; labelledReal: number; demo: number[]; real: number[]; unknown: number[] }>} */
  const tables = {};
  for (const spec of AUDIT_TABLES) {
    const { table } = spec;
    const total = db.prepare(`select count(*) as n from ${table}`).get().n;
    const cols = spec.user ? "id, created_at, user_id" : "id, created_at, null as user_id";
    const rows = db.prepare(`select ${cols}, simulated from ${table} order by ${table === "profile_versions" ? "user_id, version" : "id"}`).all();
    const placeholders = spec.tasks.map(() => "?").join(", ");
    const usage = db.prepare(
      `select simulated from usage_log where task in (${placeholders}) and created_at between ? and ?${spec.user ? " and user_id = ?" : ""}`,
    );
    /** @type {{ total: number; nulls: number; labelledDemo: number; labelledReal: number; demo: number[]; real: number[]; unknown: number[] }} */
    const result = { total, nulls: 0, labelledDemo: 0, labelledReal: 0, demo: [], real: [], unknown: [] };
    /** user_id → verdict of the previous profile version (labelled or classified). */
    const previousByUser = new Map();
    for (const row of rows) {
      let verdict;
      if (row.simulated !== null) {
        verdict = row.simulated === 1 ? "demo" : "real";
        if (row.simulated === 1) result.labelledDemo++;
        else result.labelledReal++;
      } else {
        result.nulls++;
        const params = [...spec.tasks, row.created_at - spec.before, row.created_at + spec.after, ...(spec.user ? [row.user_id] : [])];
        const matches = usage.all(...params);
        if (table === "profile_versions" && !matches.length) {
          // No extraction call: the user edited (or typed) the profile. Same label as what they edited.
          verdict = previousByUser.get(row.user_id) ?? "real";
        } else {
          verdict = verdictOf(matches);
        }
        result[verdict].push(row.id);
      }
      if (table === "profile_versions") previousByUser.set(row.user_id, verdict);
    }
    tables[table] = result;
  }

  const flagged = (table) => new Set([...tables[table].demo, ...tables[table].unknown]);
  const badAnalyses = flagged("posting_analyses");
  const badAssessments = flagged("assessments");
  const labelled = (table, value) =>
    new Set(db.prepare(`select id from ${table} where simulated = ?`).all(value).map((r) => r.id));
  const demoAnalyses = labelled("posting_analyses", 1);
  const demoAssessments = labelled("assessments", 1);
  const jobs = db
    .prepare(`select id, title, company_name, analysis_id, assessment_id from jobs order by id`)
    .all()
    .filter(
      (j) =>
        badAnalyses.has(j.analysis_id) || badAssessments.has(j.assessment_id) || demoAnalyses.has(j.analysis_id) || demoAssessments.has(j.assessment_id),
    )
    .map((j) => ({ id: j.id, title: j.title, companyName: j.company_name }));
  return { tables, jobs };
}

/** Writes the verdicts: demo → 1, real → 0; unknown stays NULL. One transaction. Returns rows changed. */
export function mark(db, classification) {
  let changed = 0;
  db.transaction(() => {
    for (const [table, result] of Object.entries(classification.tables)) {
      const set = db.prepare(`update ${table} set simulated = ? where id = ? and simulated is null`);
      for (const id of result.demo) changed += set.run(1, id).changes;
      for (const id of result.real) changed += set.run(0, id).changes;
    }
  })();
  return changed;
}

/** UTC with milliseconds — the same names the app's pre-migration backups use. */
export function backupTimestamp(now = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}${pad(now.getUTCMilliseconds(), 3)}`
  );
}

export function backup(db, dbPath, now = new Date()) {
  const dir = path.join(path.dirname(dbPath), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `huntloop-${backupTimestamp(now)}-before-demo-audit.db`);
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  return target;
}

export function formatReport(classification) {
  // "labelled" = already marked (by the app or an earlier --mark); the last three columns classify the NULL rows.
  const lines = ["table              total  labelled demo/real   NULL → demo   real   unknown"];
  for (const [table, r] of Object.entries(classification.tables)) {
    lines.push(
      `${table.padEnd(18)} ${String(r.total).padStart(5)} ${`${r.labelledDemo}/${r.labelledReal}`.padStart(19)} ${String(r.nulls).padStart(6)} ${String(r.demo.length).padStart(6)} ${String(r.real.length).padStart(6)} ${String(r.unknown.length).padStart(9)}`,
    );
  }
  lines.push("", classification.jobs.length ? "Jobs whose analysis or assessment is demo or unknown:" : "No job uses a demo or unknown analysis/assessment.");
  for (const j of classification.jobs) lines.push(`  #${j.id}  ${j.title ?? "(no title)"} — ${j.companyName ?? "(no company)"}`);
  return lines.join("\n");
}

/**
 * The command. `openDatabase(path, { readonly })` opens better-sqlite3 (injected so tests can use
 * their own build). Returns the exit code.
 */
export function run(argv, { env = process.env, cwd = process.cwd(), out = console.log, err = console.error, openDatabase }) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    err(String(error instanceof Error ? error.message : error));
    return 64;
  }
  if (args.help) {
    out("node scripts/demo-audit.mjs [--db <path>] [--mark] [--yes]");
    return 0;
  }
  const dbPath = resolveDbPath(args, env, cwd);
  out(`Database: ${dbPath}`);
  if (!fs.existsSync(dbPath)) {
    err(`No database at ${dbPath}. Run from the Huntloop checkout the app uses, or pass --db <path>.`);
    return 1;
  }
  const write = args.mark && args.yes;
  const db = openDatabase(dbPath, { readonly: !write, fileMustExist: true });
  try {
    db.pragma("busy_timeout = 5000");
    if (!hasSimulatedColumn(db)) {
      err("This database has no demo labels yet: start the app once first (it adds them), then run this again.");
      return 2;
    }
    const classification = classify(db);
    out(formatReport(classification));
    if (!args.mark) return 0;
    const pending = Object.values(classification.tables).reduce((n, r) => n + r.demo.length + r.real.length, 0);
    if (!write) {
      out(`\n--mark would label ${pending} rows (unknown rows stay unlabelled). Nothing was written; add --yes to write. Stop the app first.`);
      return 0;
    }
    const saved = backup(db, dbPath);
    out(`\nBackup: ${saved}`);
    const changed = mark(db, classification);
    out(`Labelled ${changed} rows (unknown rows stay unlabelled).`);
    return 0;
  } finally {
    db.close();
  }
}
