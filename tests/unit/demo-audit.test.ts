import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "@/server/db/database";
import { getLocalUser } from "@/server/repo/users";
import { classify, mark, run } from "../../scripts/demo-audit-lib.mjs";

let tmp: string;
let file: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "huntloop-audit-"));
  file = path.join(tmp, "huntloop.db");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

/** A migrated database with unlabelled (pre-fix) rows and the usage rows that produced them. */
function seed() {
  const db = createDatabase(file, { backupDir: false });
  const userId = getLocalUser(db).id;
  const raw = (db as unknown as { $client: Database.Database }).$client;
  const usage = raw.prepare("insert into usage_log (user_id, task, model, simulated, created_at) values (?, ?, 'm', ?, ?)");
  const analysis = raw.prepare("insert into posting_analyses (text_hash, prompt_version, model, effort, data, created_at, simulated) values (?, 1, 'm', 'low', '{}', ?, null)");
  // 1: demo analysis; 2: real; 3: no usage row (unknown); 4: mixed (unknown)
  usage.run(userId, "analyzePosting", 1, T0 - 500);
  analysis.run("a1", T0);
  usage.run(userId, "screen", 0, T0 + 100_000 - 300);
  analysis.run("a2", T0 + 100_000);
  analysis.run("a3", T0 + 200_000);
  usage.run(userId, "analyzePosting", 1, T0 + 300_000 - 100);
  usage.run(userId, "analyzePosting", 0, T0 + 300_000 - 200);
  analysis.run("a4", T0 + 300_000);
  // Company report saved 5 minutes after its research call (the ATS fetch ran in between).
  raw.prepare("insert into companies (user_id, name, normalized_name, created_at) values (?, 'Acme', 'acme', ?)").run(userId, T0);
  usage.run(userId, "companyResearch", 1, T0 + 400_000);
  raw.prepare("insert into company_reports (company_id, language, model, data, created_at, expires_at) values (1, 'en', 'm', '{}', ?, ?)").run(T0 + 700_000, T0 + 9e9);
  // Profile: v1 extracted in demo mode, v2 a user edit (no call) → inherits demo; v3 real extraction; v4 edit → real.
  const profile = raw.prepare("insert into profile_versions (user_id, version, cv_text, data, created_at) values (?, ?, 'cv', '{}', ?)");
  usage.run(userId, "extractProfile", 1, T0 + 800_000 - 400);
  profile.run(userId, 1, T0 + 800_000);
  profile.run(userId, 2, T0 + 900_000);
  usage.run(userId, "extractProfile", 0, T0 + 1_000_000 - 400);
  profile.run(userId, 3, T0 + 1_000_000);
  profile.run(userId, 4, T0 + 1_100_000);
  // A job pointing at the demo analysis, one at the real one.
  raw.prepare("insert into jobs (user_id, source, title, company_name, analysis_id) values (?, 'paste', 'Demo job', 'Acme', 1)").run(userId);
  raw.prepare("insert into jobs (user_id, source, title, company_name, analysis_id) values (?, 'paste', 'Real job', 'Acme', 2)").run(userId);
  raw.close();
}

describe("demo audit", () => {
  it("classifies unlabelled rows from the usage log", () => {
    seed();
    const db = new Database(file, { readonly: true });
    const c = classify(db);
    db.close();
    expect(c.tables.posting_analyses).toMatchObject({ total: 4, nulls: 4, demo: [1], real: [2], unknown: [3, 4] });
    expect(c.tables.company_reports).toMatchObject({ demo: [1], real: [], unknown: [] });
    expect(c.tables.profile_versions).toMatchObject({ demo: [1, 2], real: [3, 4], unknown: [] });
    expect(c.jobs.map((j: { title: string }) => j.title)).toEqual(["Demo job"]);
  });

  it("marks demo 1, real 0 and leaves unknown NULL", () => {
    seed();
    const db = new Database(file);
    mark(db, classify(db));
    expect(db.prepare("select id, simulated from posting_analyses order by id").all()).toEqual([
      { id: 1, simulated: 1 },
      { id: 2, simulated: 0 },
      { id: 3, simulated: null },
      { id: 4, simulated: null },
    ]);
    // A second report counts what is now labelled, and has nothing left to classify there.
    expect(classify(db).tables.posting_analyses).toMatchObject({ labelledDemo: 1, labelledReal: 1, nulls: 2, demo: [], real: [], unknown: [3, 4] });
    db.close();
  });

  const open = (f: string, o: Database.Options) => new Database(f, o);
  const quiet = () => {
    const lines: string[] = [];
    return { lines, out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) };
  };

  it("refuses a missing database path and creates no file", () => {
    const missing = path.join(tmp, "nope", "huntloop.db");
    const io = quiet();
    expect(run(["--db", missing, "--mark", "--yes"], { ...io, openDatabase: open })).toBe(1);
    expect(fs.existsSync(missing)).toBe(false);
    expect(fs.existsSync(path.dirname(missing))).toBe(false);
    expect(io.lines[0]).toContain(missing);
  });

  it("is read-only without --yes, and writes a backup before labelling with --mark --yes", () => {
    seed();
    const io = quiet();
    expect(run(["--db", file, "--mark"], { ...io, openDatabase: open })).toBe(0);
    let db = new Database(file, { readonly: true });
    expect(db.prepare("select count(*) as n from posting_analyses where simulated is not null").get()).toEqual({ n: 0 });
    db.close();
    expect(fs.existsSync(path.join(tmp, "backups"))).toBe(false);

    expect(run(["--db", file, "--mark", "--yes"], { ...io, openDatabase: open })).toBe(0);
    const backups = fs.readdirSync(path.join(tmp, "backups"));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^huntloop-\d{8}-\d{9}-before-demo-audit\.db$/);
    const copy = new Database(path.join(tmp, "backups", backups[0]), { readonly: true });
    expect(copy.prepare("select count(*) as n from posting_analyses where simulated is not null").get()).toEqual({ n: 0 });
    copy.close();
    db = new Database(file, { readonly: true });
    expect(db.prepare("select count(*) as n from posting_analyses where simulated is not null").get()).toEqual({ n: 2 });
    db.close();
  });

  it("asks for an app start when the database has no labels yet", () => {
    const old = new Database(file);
    old.exec("create table posting_analyses (id integer primary key)");
    old.close();
    const io = quiet();
    expect(run(["--db", file], { ...io, openDatabase: open })).toBe(2);
    expect(io.lines.join("\n")).toContain("start the app once first");
  });
});
