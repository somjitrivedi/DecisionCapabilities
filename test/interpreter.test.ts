import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate } from "../src/ir/interpreter.ts";
import { asCase, baseCase, compileOk, evalText } from "./helpers.ts";

const withIncome = (income: number | null) => {
  const c = baseCase();
  c.applicant.income = income;
  return c;
};

test("three-valued logic: unknown propagates through and, or and not", () => {
  const nullIncome = withIncome(null);
  assert.equal(evalText("(applicant.income ?? 0) < 1", nullIncome), true);
  assert.equal(evalText("applicant.income is null", nullIncome), true);
  assert.equal(evalText("applicant.income < 1", nullIncome), null);
  assert.equal(evalText("not (applicant.income < 1)", nullIncome), null);
  assert.equal(evalText("applicant.income < 1 and false", nullIncome), false);
  assert.equal(evalText("applicant.income < 1 and true", nullIncome), null);
  assert.equal(evalText("applicant.income < 1 or true", nullIncome), true);
  assert.equal(evalText("applicant.income < 1 or false", nullIncome), null);
  assert.equal(evalText("applicant.income in [1, 2]", nullIncome), null);
  assert.equal(evalText("applicant.income between 1 and 2", nullIncome), null);
  assert.equal(evalText("min(applicant.income, 5) > 1", nullIncome), null);
});

test("arithmetic, comparison and division by zero", () => {
  assert.equal(evalText("loan.amount * 2 + 1 = 16001"), true);
  assert.equal(evalText("loan.amount / 0 > 1"), null);
  assert.equal(evalText("-applicant.age < 0"), true);
  assert.equal(evalText("applicant.age between 40 and 40"), true);
  assert.equal(evalText("applicant.age not between 41 and 50"), true);
  assert.equal(evalText('loan.purpose in ["car_used"]'), true);
  assert.equal(evalText('loan.purpose not in ["car_used"]'), false);
  assert.equal(evalText('loan.applicationDate < @2026-11-21'), true);
});

test("built-in functions", () => {
  const c = baseCase();
  c.applicant.dateOfBirth = "1986-11-25";
  assert.equal(evalText("age(applicant.dateOfBirth) = 39", c), true);
  c.applicant.dateOfBirth = "1986-11-24";
  assert.equal(evalText("age(applicant.dateOfBirth) = 40", c), true);
  assert.equal(evalText("monthsSince(@2026-01-25) = 9"), true);
  assert.equal(evalText("monthsSince(@2026-01-24) = 10"), true);
  assert.equal(evalText("daysBetween(@2026-07-01, today()) = 146"), true);
  assert.equal(evalText("daysBetween(@2024-02-28, @2024-03-01) = 2"), true);
  assert.equal(evalText("round(loan.amount / 3, 2) = 2666.67"), true);
  assert.equal(evalText("abs(0 - applicant.age) = 40"), true);
  assert.equal(evalText("max(loan.amount, 9000) = 9000"), true);
  assert.equal(evalText("count(applicant.documents) = 2"), true);
  assert.equal(evalText('contains(applicant.documents, "id_proof")'), true);
  assert.equal(evalText('contains(applicant.documents, "bank_statement")'), false);
});

const demo = `ruleset Demo
default approve
rule Late priority 1: if true then set decision.apr = decision.apr + 1
rule Early priority 9: if true then set decision.apr = 10
rule Refer: if loan.amount > 5000 then refer reason "BIG"
rule Decline: if applicant.income < 1000 then decline reason "POOR" else reason "INCOME_OK"
rule Approve: if true then approve reason "FINE"`;

test("rules run by priority then source order; set reads earlier writes", () => {
  const rs = compileOk(demo);
  const r = evaluate(rs, asCase(baseCase()), { today: "2026-11-24" });
  assert.deepEqual(r.trace.map((t) => t.rule), ["Early", "Late", "Refer", "Decline", "Approve"]);
  assert.equal(r.outputs.apr, 11);
});

test("the most severe outcome wins and reasons explain that outcome", () => {
  const rs = compileOk(demo);
  const refer = evaluate(rs, asCase(baseCase()), { today: "2026-11-24" });
  assert.equal(refer.outcome, "refer");
  assert.deepEqual(refer.reasons.map((x) => x.code), ["BIG", "INCOME_OK"]);
  const decline = evaluate(rs, asCase(withIncome(500)), { today: "2026-11-24" });
  assert.equal(decline.outcome, "decline");
  assert.deepEqual(decline.reasons.map((x) => x.code), ["POOR"]);
  assert.deepEqual(decline.fired, ["Early", "Late", "Refer", "Decline", "Approve"]);
});

test("unknown conditions run neither branch; false runs else", () => {
  const rs = compileOk(demo);
  const unknown = evaluate(rs, asCase(withIncome(null)), { today: "2026-11-24" });
  const entry = unknown.trace.find((t) => t.rule === "Decline")!;
  assert.deepEqual(entry, { rule: "Decline", result: "unknown", branch: "none" });
  assert.ok(!unknown.reasons.some((x) => x.code === "INCOME_OK"));
  const known = evaluate(rs, asCase(baseCase()), { today: "2026-11-24" });
  assert.deepEqual(known.trace.find((t) => t.rule === "Decline"), { rule: "Decline", result: "false", branch: "else" });
});

test("the default outcome applies when no outcome action fires", () => {
  const rs = compileOk("ruleset D\ndefault refer\nrule A: if loan.amount > 1_000_000 then decline");
  const r = evaluate(rs, asCase(baseCase()), { today: "2026-11-24" });
  assert.equal(r.outcome, "refer");
  assert.deepEqual(r.fired, []);
  assert.equal(compileOk("ruleset D\nrule A: if false then approve").defaultOutcome, "refer");
});

test("evaluation does not mutate the input case", () => {
  const rs = compileOk(demo);
  const c = baseCase();
  const before = JSON.stringify(c);
  evaluate(rs, asCase(c), { today: "2026-11-24" });
  assert.equal(JSON.stringify(c), before);
});
