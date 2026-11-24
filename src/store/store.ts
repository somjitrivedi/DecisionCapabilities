import { DatabaseSync } from "node:sqlite";
import type { DatasetRow, Label } from "../data/german.ts";
import type { Case } from "../model/case.ts";
import type { DecisionResult, Outcome } from "../ir/ir.ts";

const MIGRATIONS: string[] = [
  `
  create table datasets (
    id integer primary key,
    name text not null unique,
    source text not null,
    row_count integer not null,
    loaded_at text not null
  );
  create table applications (
    id integer primary key,
    dataset_id integer not null references datasets(id) on delete cascade,
    ext_id text not null,
    payload text not null,
    label text check (label in ('good', 'bad')),
    unique (dataset_id, ext_id)
  );
  create table rulesets (
    id integer primary key,
    name text not null,
    source_hash text not null unique,
    source text not null,
    created_at text not null
  );
  create table runs (
    id integer primary key,
    ruleset_id integer not null references rulesets(id),
    dataset_id integer not null references datasets(id),
    evaluated_on text not null,
    started_at text not null,
    duration_ms real not null,
    decisions integer not null
  );
  create table decisions (
    run_id integer not null references runs(id) on delete cascade,
    application_id integer not null references applications(id),
    outcome text not null check (outcome in ('approve', 'refer', 'decline')),
    reasons text not null,
    outputs text not null,
    fired text not null,
    primary key (run_id, application_id)
  );
  create index decisions_outcome on decisions(run_id, outcome);
  `,
];

export interface StoredApplication {
  id: number;
  extId: string;
  case: Case;
  label: Label | null;
}

export interface RunSummary {
  runId: number;
  total: number;
  byOutcome: Record<Outcome, number>;
  badRateByOutcome: Record<Outcome, number | null>;
  topReasons: { code: string; count: number }[];
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("pragma foreign_keys = on; pragma journal_mode = wal;");
    this.migrate();
  }

  private migrate(): void {
    const row = this.db.prepare("pragma user_version").get() as { user_version: number };
    for (let v = row.user_version; v < MIGRATIONS.length; v++) {
      this.db.exec("begin");
      try {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`pragma user_version = ${v + 1}`);
        this.db.exec("commit");
      } catch (e) {
        this.db.exec("rollback");
        throw e;
      }
    }
  }

  schemaVersion(): number {
    return (this.db.prepare("pragma user_version").get() as { user_version: number }).user_version;
  }

  close(): void {
    this.db.close();
  }

  private transaction<R>(fn: () => R): R {
    this.db.exec("begin");
    try {
      const r = fn();
      this.db.exec("commit");
      return r;
    } catch (e) {
      this.db.exec("rollback");
      throw e;
    }
  }

  replaceDataset(name: string, source: string, rows: DatasetRow[]): number {
    return this.transaction(() => {
      const existing = this.db.prepare("select id from datasets where name = ?").get(name) as { id: number } | undefined;
      if (existing !== undefined) {
        const runIds = this.db.prepare("select id from runs where dataset_id = ?").all(existing.id) as { id: number }[];
        for (const r of runIds) this.db.prepare("delete from decisions where run_id = ?").run(r.id);
        this.db.prepare("delete from runs where dataset_id = ?").run(existing.id);
        this.db.prepare("delete from applications where dataset_id = ?").run(existing.id);
        this.db.prepare("delete from datasets where id = ?").run(existing.id);
      }
      const info = this.db
        .prepare("insert into datasets (name, source, row_count, loaded_at) values (?, ?, ?, ?)")
        .run(name, source, rows.length, new Date().toISOString());
      const datasetId = Number(info.lastInsertRowid);
      const insert = this.db.prepare("insert into applications (dataset_id, ext_id, payload, label) values (?, ?, ?, ?)");
      for (const r of rows) insert.run(datasetId, r.extId, JSON.stringify(r.case), r.label);
      return datasetId;
    });
  }

  datasetId(name: string): number | null {
    const row = this.db.prepare("select id from datasets where name = ?").get(name) as { id: number } | undefined;
    return row?.id ?? null;
  }

  applications(datasetId: number): StoredApplication[] {
    const rows = this.db
      .prepare("select id, ext_id, payload, label from applications where dataset_id = ? order by id")
      .all(datasetId) as { id: number; ext_id: string; payload: string; label: Label | null }[];
    return rows.map((r) => ({ id: r.id, extId: r.ext_id, case: JSON.parse(r.payload) as Case, label: r.label }));
  }

  saveRuleset(name: string, sourceHash: string, source: string): number {
    const existing = this.db.prepare("select id from rulesets where source_hash = ?").get(sourceHash) as { id: number } | undefined;
    if (existing !== undefined) return existing.id;
    const info = this.db
      .prepare("insert into rulesets (name, source_hash, source, created_at) values (?, ?, ?, ?)")
      .run(name, sourceHash, source, new Date().toISOString());
    return Number(info.lastInsertRowid);
  }

  saveRun(
    rulesetId: number,
    datasetId: number,
    evaluatedOn: string,
    durationMs: number,
    results: { applicationId: number; result: DecisionResult }[],
  ): number {
    return this.transaction(() => {
      const info = this.db
        .prepare("insert into runs (ruleset_id, dataset_id, evaluated_on, started_at, duration_ms, decisions) values (?, ?, ?, ?, ?, ?)")
        .run(rulesetId, datasetId, evaluatedOn, new Date().toISOString(), durationMs, results.length);
      const runId = Number(info.lastInsertRowid);
      const insert = this.db.prepare(
        "insert into decisions (run_id, application_id, outcome, reasons, outputs, fired) values (?, ?, ?, ?, ?, ?)",
      );
      for (const { applicationId, result } of results) {
        insert.run(
          runId,
          applicationId,
          result.outcome,
          JSON.stringify(result.reasons),
          JSON.stringify(result.outputs),
          JSON.stringify(result.fired),
        );
      }
      return runId;
    });
  }

  summarize(runId: number): RunSummary {
    const rows = this.db
      .prepare(
        `select d.outcome as outcome, count(*) as n, sum(case when a.label = 'bad' then 1 else 0 end) as bad,
                sum(case when a.label is not null then 1 else 0 end) as labelled
         from decisions d join applications a on a.id = d.application_id
         where d.run_id = ? group by d.outcome`,
      )
      .all(runId) as { outcome: Outcome; n: number; bad: number; labelled: number }[];
    const byOutcome: Record<Outcome, number> = { approve: 0, refer: 0, decline: 0 };
    const badRateByOutcome: Record<Outcome, number | null> = { approve: null, refer: null, decline: null };
    for (const r of rows) {
      byOutcome[r.outcome] = r.n;
      badRateByOutcome[r.outcome] = r.labelled > 0 ? r.bad / r.labelled : null;
    }
    const topReasons = this.db
      .prepare(
        `select json_extract(j.value, '$.code') as code, count(*) as count
         from decisions d, json_each(d.reasons) j
         where d.run_id = ? group by code order by count desc, code limit 10`,
      )
      .all(runId) as { code: string; count: number }[];
    return { runId, total: rows.reduce((s, r) => s + r.n, 0), byOutcome, badRateByOutcome, topReasons };
  }
}
