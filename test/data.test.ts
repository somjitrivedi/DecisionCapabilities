import assert from "node:assert/strict";
import { test } from "node:test";
import { loadGermanFile, parseGerman } from "../src/data/german.ts";
import { evaluate } from "../src/ir/interpreter.ts";
import { validateCase } from "../src/model/case.ts";
import { validateSchema } from "../src/model/schema.ts";
import { compile } from "../src/lang/compile.ts";
import { Store } from "../src/store/store.ts";
import { baseCase, schema, underwritingRules } from "./helpers.ts";

const rows = loadGermanFile();

test("the underwriting schema is internally consistent", () => {
  assert.deepEqual(validateSchema(schema), []);
});

test("case validation catches missing, mistyped, unknown and output fields", () => {
  assert.deepEqual(validateCase(schema, baseCase()), []);
  const c = baseCase() as unknown as Record<string, Record<string, unknown>>;
  delete c.loan!.amount;
  c.applicant!.age = "40";
  c.accounts!.checking = "rich";
  c.bureau!.extra = 1;
  c.loan!.applicationDate = "2026-02-30";
  c.decision = {};
  assert.deepEqual(validateCase(schema, c), [
    "applicant.age: expected number",
    "accounts.checking: expected one of overdrawn, low, healthy, none",
    "bureau.extra: not in schema",
    "loan.amount: required",
    "loan.applicationDate: expected date as YYYY-MM-DD",
    "decision: is the decision output and cannot be supplied as input",
  ]);
});

test("German Credit loads 1,000 valid applications, 700 good and 300 bad", () => {
  assert.equal(rows.length, 1000);
  assert.equal(rows.filter((r) => r.label === "good").length, 700);
  assert.equal(rows.filter((r) => r.label === "bad").length, 300);
  for (const r of rows) assert.deepEqual(validateCase(schema, r.case), [], r.extId);
});

test("German Credit codes map onto the object model", () => {
  const first = rows[0]!;
  assert.equal(first.extId, "G0001");
  assert.equal(first.label, "good");
  assert.deepEqual(first.case, {
    applicant: {
      id: "G0001",
      age: 67,
      dateOfBirth: null,
      income: null,
      dependents: 1,
      residenceYears: 4,
      housing: "own",
      hasTelephone: true,
      documents: [],
    },
    employment: { tenure: "7y_plus", jobType: "skilled" },
    accounts: { checking: "overdrawn", savings: "none" },
    bureau: { score: null, history: "critical", existingCredits: 2, otherPlans: "none", delinquencies: null },
    loan: {
      amount: 1169,
      termMonths: 6,
      purpose: "electronics",
      installmentBurden: 4,
      collateral: "real_estate",
      guarantor: "none",
      applicationDate: null,
    },
  });
});

test("malformed German rows are rejected with the line number", () => {
  assert.throws(() => parseGerman("A11 6 A34\n"), /line 1: expected 21 fields/);
  assert.throws(() => parseGerman("A19 6 A34 A43 1169 A65 A75 4 A93 A101 4 A121 67 A143 A152 2 A173 1 A192 A201 1\n"), /unknown checking code A19/);
});

test("the first German applicant is declined for critical history and debt burden", () => {
  const r = evaluate(underwritingRules(), rows[0]!.case as never, { today: "2026-11-24" });
  assert.equal(r.outcome, "decline");
  assert.deepEqual(r.reasons.map((x) => x.code), ["CRITICAL_HISTORY", "HIGH_DEBT_BURDEN"]);
});

test("store round-trips datasets, rulesets and runs, and summarises outcomes against labels", () => {
  const store = new Store(":memory:");
  assert.equal(store.schemaVersion(), 1);
  store.replaceDataset("german", "test", rows.slice(0, 10));
  store.replaceDataset("german", "test", rows);
  const count = store.db.prepare("select count(*) as n from applications").get() as { n: number };
  assert.equal(count.n, 1000);
  const id = store.datasetId("german")!;
  const apps = store.applications(id);
  assert.equal(apps.length, 1000);
  assert.deepEqual(apps[0]!.case, rows[0]!.case);
  const rules = underwritingRules();
  const source = "ruleset X\nrule A: if true then approve";
  const hash = compile(source, schema).sourceHash;
  const r1 = store.saveRuleset("X", hash, source);
  assert.equal(store.saveRuleset("X", hash, source), r1);
  const results = apps.map((a) => ({ applicationId: a.id, result: evaluate(rules, a.case, { today: "2026-11-24" }) }));
  const runId = store.saveRun(r1, id, "2026-11-24", 1, results);
  const s = store.summarize(runId);
  assert.equal(s.total, 1000);
  assert.deepEqual(s.byOutcome, { approve: 526, refer: 120, decline: 354 });
  assert.equal(s.badRateByOutcome.approve, 100 / 526);
  assert.ok(s.badRateByOutcome.approve! < 0.3 && s.badRateByOutcome.decline! > 0.3);
  assert.equal(s.topReasons[0]!.code, "HIGH_DEBT_BURDEN");
  store.close();
});
