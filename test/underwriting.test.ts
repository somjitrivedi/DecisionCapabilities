import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { evaluate } from "../src/ir/interpreter.ts";
import type { LoanCase } from "../src/model/case.ts";
import { compile } from "../src/lang/compile.ts";
import { asCase, baseCase, schema, underwritingRules } from "./helpers.ts";

const TODAY = "2026-11-24";
const rules = underwritingRules();

function decide(mutate: (c: LoanCase) => void = () => {}) {
  const c = baseCase();
  mutate(c);
  return evaluate(rules, asCase(c), { today: TODAY });
}

function codes(r: ReturnType<typeof decide>): string[] {
  return r.reasons.map((x) => x.code);
}

test("the underwriting ruleset has 51 rules and compiles without warnings", () => {
  const result = compile(readFileSync("rules/personal-loan.rules", "utf8"), schema);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(rules.rules.length, 51);
});

test("a strong applicant is approved at grade A pricing", () => {
  const r = decide();
  assert.equal(r.outcome, "approve");
  assert.deepEqual(codes(r), ["STRONG_PROFILE"]);
  assert.deepEqual(r.outputs, { riskGrade: "A", apr: 8.5, maxAmount: 8000, maxTermMonths: 60 });
});

const cases: { name: string; mutate: (c: LoanCase) => void; outcome: string; reasons: string[] }[] = [
  { name: "low income", mutate: (c) => (c.applicant.income = 25_000), outcome: "decline", reasons: ["LOW_INCOME"] },
  { name: "underage, refer reason suppressed", mutate: (c) => (c.applicant.age = 17), outcome: "decline", reasons: ["UNDERAGE"] },
  {
    name: "age at maturity",
    mutate: (c) => {
      c.applicant.age = 70;
      c.loan.termMonths = 72;
    },
    outcome: "decline",
    reasons: ["AGE_AT_MATURITY", "TERM_TOO_LONG"],
  },
  {
    name: "two eligibility declines in source order",
    mutate: (c) => {
      c.loan.amount = 25_000;
      c.loan.termMonths = 72;
    },
    outcome: "decline",
    reasons: ["TERM_TOO_LONG", "AMOUNT_TOO_HIGH"],
  },
  { name: "low bureau score", mutate: (c) => (c.bureau.score = 550), outcome: "decline", reasons: ["LOW_BUREAU_SCORE"] },
  { name: "delinquencies", mutate: (c) => (c.bureau.delinquencies = 3), outcome: "decline", reasons: ["DELINQUENCIES"] },
  { name: "missing delinquencies count as zero", mutate: (c) => (c.bureau.delinquencies = null), outcome: "approve", reasons: ["STRONG_PROFILE"] },
  { name: "missing score is not a decline", mutate: (c) => (c.bureau.score = null), outcome: "approve", reasons: ["STRONG_PROFILE"] },
  { name: "vacation", mutate: (c) => (c.loan.purpose = "vacation"), outcome: "decline", reasons: ["PURPOSE_NOT_FINANCED"] },
  { name: "unemployed without guarantor", mutate: (c) => (c.employment.tenure = "unemployed"), outcome: "decline", reasons: ["UNEMPLOYED"] },
  {
    name: "overdrawn on a long term",
    mutate: (c) => {
      c.accounts.checking = "overdrawn";
      c.loan.termMonths = 36;
    },
    outcome: "decline",
    reasons: ["OVERDRAWN_LONG_TERM"],
  },
  {
    name: "income not verified on a large loan",
    mutate: (c) => {
      c.applicant.income = null;
      c.loan.amount = 12_000;
    },
    outcome: "refer",
    reasons: ["INCOME_NOT_VERIFIED"],
  },
  {
    name: "large loan without income proof",
    mutate: (c) => {
      c.applicant.documents = ["id_proof"];
      c.loan.amount = 12_000;
    },
    outcome: "refer",
    reasons: ["MISSING_INCOME_PROOF"],
  },
  { name: "business purpose", mutate: (c) => (c.loan.purpose = "business"), outcome: "refer", reasons: ["BUSINESS_PURPOSE"] },
  { name: "age mismatch", mutate: (c) => (c.applicant.dateOfBirth = "1990-01-15"), outcome: "refer", reasons: ["AGE_MISMATCH"] },
  { name: "matching date of birth", mutate: (c) => (c.applicant.dateOfBirth = "1986-05-01"), outcome: "approve", reasons: ["STRONG_PROFILE"] },
  { name: "stale application", mutate: (c) => (c.loan.applicationDate = "2026-07-01"), outcome: "refer", reasons: ["STALE_APPLICATION"] },
  {
    name: "young applicant, large loan",
    mutate: (c) => {
      c.applicant.age = 22;
    },
    outcome: "refer",
    reasons: ["YOUNG_LARGE_LOAN"],
  },
];

for (const tc of cases) {
  test(`golden: ${tc.name}`, () => {
    const r = decide(tc.mutate);
    assert.equal(r.outcome, tc.outcome);
    assert.deepEqual(codes(r), tc.reasons);
  });
}

test("grade C pricing applies when checking is overdrawn but savings are high", () => {
  const r = decide((c) => {
    c.accounts.checking = "overdrawn";
    c.loan.termMonths = 36;
  });
  assert.equal(r.outputs.riskGrade, "C");
  assert.equal(r.outputs.apr, 13);
});

test("grade E refers large loans and caps amount and term", () => {
  const r = decide((c) => {
    c.accounts.checking = "overdrawn";
    c.accounts.savings = "very_low";
    c.loan.amount = 7_000;
  });
  assert.equal(r.outcome, "refer");
  assert.deepEqual(codes(r), ["HIGH_RISK_LARGE_LOAN"]);
  assert.deepEqual(r.outputs, { riskGrade: "E", apr: 21, maxAmount: 4000, maxTermMonths: 36 });
});

test("grade D caps the amount at 8,000", () => {
  const r = decide((c) => {
    c.accounts.checking = "low";
    c.accounts.savings = "very_low";
    c.loan.amount = 9_500;
  });
  assert.deepEqual(r.outputs, { riskGrade: "D", apr: 16.5, maxAmount: 8000, maxTermMonths: 36 });
});

test("apr adjustments stack in source order", () => {
  const r = decide((c) => {
    c.loan.collateral = "real_estate";
    c.loan.termMonths = 48;
    c.loan.guarantor = "co_applicant";
  });
  assert.equal(r.outcome, "approve");
  assert.equal(r.outputs.apr, 7.75);
});

test("a guarantor lifts the unemployment decline and discounts the rate", () => {
  const r = decide((c) => {
    c.employment.tenure = "unemployed";
    c.loan.guarantor = "guarantor";
  });
  assert.equal(r.outcome, "approve");
  assert.equal(r.outputs.apr, 8);
});

test("income caps the maximum amount at half of annual income", () => {
  const r = decide((c) => {
    c.applicant.income = 30_000;
    c.loan.amount = 18_000;
  });
  assert.equal(r.outputs.maxAmount, 15_000);
  assert.equal(r.outputs.manualReview, true);
  assert.equal(r.outcome, "approve");
  assert.deepEqual(codes(r), []);
});

test("the trace records every rule once with its result", () => {
  const r = decide();
  assert.equal(r.trace.length, 51);
  assert.equal(new Set(r.trace.map((t) => t.rule)).size, 51);
  assert.ok(r.trace.every((t) => t.result !== "unknown" || t.branch === "none"));
});
