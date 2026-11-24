import assert from "node:assert/strict";
import { test } from "node:test";
import { compileExpression, formatAll } from "../src/lang/compile.ts";
import { codesOf, compileOk, diagnosticsOf, exprCodes, schema } from "./helpers.ts";

const rules = (body: string): string => `ruleset T\n${body}`;

test("well-typed expressions produce no diagnostics", () => {
  for (const text of [
    "applicant.age >= 18",
    "loan.amount < 30000",
    "loan.amount * 2 > loan.amount + 500",
    "loan.amount / loan.amount > 0.5",
    'loan.purpose in ["car_new", "car_used"]',
    'loan.purpose not in ["business"]',
    "applicant.age between 18 and 65",
    "loan.amount between 1_000 and 5_000",
    'contains(applicant.documents, "income_proof")',
    "count(applicant.documents) >= 2",
    "min(loan.amount, 8000) > 100",
    "not applicant.hasTelephone",
    "applicant.income is not null and applicant.income > 1",
    "(applicant.income ?? 0) > 1",
    "decision.apr is null",
  ]) {
    assert.deepEqual(exprCodes(text), [], text);
  }
});

test("money and number do not mix, but numeric literals adapt to money", () => {
  assert.deepEqual(exprCodes("loan.amount > applicant.age"), ["E201"]);
  assert.deepEqual(exprCodes("loan.amount + applicant.age > 3"), ["E212"]);
  assert.deepEqual(exprCodes("loan.amount * loan.amount > 3"), ["E212"]);
  assert.deepEqual(exprCodes("applicant.age / loan.amount > 3"), ["E212"]);
  assert.equal(compileExpression("loan.amount / loan.amount", schema).type?.kind, "number");
  assert.equal(compileExpression("loan.amount * 0.5", schema).type?.kind, "money");
  assert.equal(compileExpression("loan.amount - 100", schema).type?.kind, "money");
});

test("the type-error message names the field, both types and a fix", () => {
  const source = rules('rule A: if loan.amount = "high" then decline');
  const d = diagnosticsOf(source)[0]!;
  assert.equal(d.code, "E201");
  assert.equal(d.message, "loan.amount is money, not string");
  assert.equal(d.hint, "compare with a number without quotes, such as 30000");
  assert.equal(
    formatAll([d], source, "t.rules"),
    [
      "t.rules:2:12: error E201: loan.amount is money, not string",
      "   |",
      ' 2 | rule A: if loan.amount = "high" then decline',
      "   |            ^^^^^^^^^^^^^^^^^^^^",
      "   = hint: compare with a number without quotes, such as 30000",
    ].join("\n"),
  );
});

test("quoted numbers get a remove-the-quotes hint", () => {
  const d = compileExpression('loan.amount > "5000"', schema).diagnostics[0]!;
  assert.equal(d.hint, "remove the quotes: 5000");
});

test("unknown names suggest the closest match", () => {
  const hint = (text: string): string | undefined => compileExpression(text, schema).diagnostics[0]?.hint;
  assert.equal(hint("applicant.incme > 3"), "did you mean applicant.income?");
  assert.equal(hint("aplicant.age > 3"), "did you mean applicant?");
  assert.equal(hint("mni(1, 2) > 3"), "did you mean min()?");
  assert.equal(hint('loan.purpose = "car_neww"'), 'did you mean "car_new"?');
  assert.deepEqual(exprCodes("applicant.zzzzzz > 1"), ["E202"]);
  assert.deepEqual(exprCodes("zz.age > 1"), ["E203"]);
  assert.deepEqual(exprCodes("nothing > 1"), ["E214"]);
  assert.deepEqual(exprCodes("applicant > 1"), ["E214"]);
  assert.deepEqual(exprCodes("applicant.age.years > 1"), ["E202"]);
});

test("enum values are checked wherever a string literal meets an enum", () => {
  assert.deepEqual(exprCodes('loan.purpose = "yacht"'), ["E208"]);
  assert.deepEqual(exprCodes('"yacht" = loan.purpose'), ["E208"]);
  assert.deepEqual(exprCodes('loan.purpose in ["car_new", "yacht"]'), ["E208"]);
  assert.deepEqual(exprCodes('contains(applicant.documents, "passport")'), ["E208"]);
  assert.deepEqual(exprCodes("loan.purpose = loan.collateral"), ["E201"]);
  assert.deepEqual(exprCodes('loan.purpose < "car_new"'), ["E201"]);
  assert.deepEqual(codesOf(rules('rule A: if true then set decision.riskGrade = "Z"')), ["E208"]);
});

test("conditions must be true/false tests", () => {
  assert.deepEqual(codesOf(rules("rule A: if loan.amount then approve")), ["E207"]);
  assert.deepEqual(exprCodes("not loan.amount"), ["E207"]);
  assert.deepEqual(exprCodes("loan.amount and true"), ["E207"]);
});

test("comparing with null literal points to is null", () => {
  const d = compileExpression("applicant.income = null", schema).diagnostics[0]!;
  assert.equal(d.code, "E209");
  assert.equal(d.hint, "write applicant.income is null");
  assert.equal(compileExpression("applicant.income != null", schema).diagnostics[0]!.hint, "write applicant.income is not null");
});

test("function arity and argument types are checked", () => {
  assert.deepEqual(exprCodes("min(1) > 0"), ["E205"]);
  assert.deepEqual(exprCodes("age(applicant.age) > 0"), ["E206"]);
  assert.deepEqual(exprCodes("count(loan.amount) > 0"), ["E206"]);
  assert.deepEqual(exprCodes("min(loan.amount, applicant.age) > 0"), ["E206"]);
  assert.deepEqual(exprCodes("round(loan.amount, 2) > 0"), []);
});

test("nullable inputs warn unless guarded or given a fallback", () => {
  assert.deepEqual(exprCodes("applicant.income > 3"), ["W301"]);
  assert.deepEqual(exprCodes("applicant.income is not null and applicant.income > 3"), []);
  assert.deepEqual(exprCodes("applicant.income is null or applicant.income > 3"), []);
  assert.deepEqual(exprCodes("applicant.income > 3 and applicant.income is not null"), ["W301"]);
  assert.deepEqual(exprCodes("(applicant.income ?? 0) > 3"), []);
  assert.deepEqual(exprCodes("applicant.income > 1 and applicant.income < 9"), ["W301"]);
});

test("narrowing from the condition carries into then actions and else actions", () => {
  assert.deepEqual(
    codesOf(rules("rule A: if applicant.income is not null then set decision.maxAmount = applicant.income * 0.5")),
    [],
  );
  assert.deepEqual(
    codesOf(rules("rule A: if applicant.income is null then refer else set decision.maxAmount = applicant.income")),
    [],
  );
  assert.deepEqual(codesOf(rules("rule A: if true then set decision.maxAmount = applicant.income")), ["W301"]);
});

test("pointless null checks and fallbacks are warned about", () => {
  assert.deepEqual(exprCodes("loan.amount is null"), ["W303"]);
  assert.deepEqual(exprCodes("(loan.amount ?? 0) > 1"), ["W302"]);
});

test("set targets only decision fields with matching types", () => {
  assert.deepEqual(codesOf(rules("rule A: if true then set applicant.age = 3")), ["E210"]);
  assert.deepEqual(codesOf(rules("rule A: if true then set decision.aprr = 3")), ["E202"]);
  assert.deepEqual(codesOf(rules("rule A: if true then set decision.apr = loan.amount")), ["E211"]);
  assert.deepEqual(codesOf(rules("rule A: if true then set decision.maxAmount = applicant.age")), ["E211"]);
  assert.deepEqual(codesOf(rules("rule A: if true then set decision.maxAmount = 5000")), []);
  assert.deepEqual(codesOf(rules("rule A: if true then set decision.manualReview = true")), []);
});

test("constants fold, keep literal flexibility and must be constant", () => {
  const rs = compileOk(rules("const A = 1_000\nconst B = A * 3\nrule R: if loan.amount > B then decline"));
  const cond = rs.rules[0]!.condition;
  assert.equal(cond.op, "cmp");
  if (cond.op === "cmp") assert.deepEqual(cond.right.op === "lit" ? cond.right.value : null, 3000);
  assert.deepEqual(codesOf(rules("const A = loan.amount\nrule R: if true then approve")), ["E217"]);
  assert.deepEqual(codesOf(rules("const A = 1\nconst A = 2\nrule R: if true then approve")), ["E213"]);
  assert.deepEqual(codesOf(rules("const loan = 1\nrule R: if true then approve")), ["E213"]);
});

test("duplicate rule names, reason style and multiple outcomes", () => {
  assert.deepEqual(codesOf(rules("rule A: if true then approve\nrule A: if true then decline")), ["E102"]);
  assert.deepEqual(codesOf(rules('rule A: if true then decline reason "low"')), ["W304"]);
  assert.deepEqual(codesOf(rules("rule A: if true then approve, decline")), ["W305"]);
});

test("lists must be homogeneous and free of null", () => {
  assert.deepEqual(exprCodes('applicant.age in [1, "a"]'), ["E215"]);
  assert.deepEqual(exprCodes('applicant.age in ["a", "b"]'), ["E201"]);
  assert.deepEqual(exprCodes("applicant.age in [1, null]"), ["E215"]);
  assert.deepEqual(exprCodes("applicant.age in loan.amount"), ["E201"]);
});

test("between bounds must match and empty ranges are flagged", () => {
  assert.deepEqual(exprCodes('applicant.age between 1 and "x"'), ["E216"]);
  assert.deepEqual(exprCodes("applicant.age between 9 and 1"), ["W306"]);
  assert.deepEqual(exprCodes("loan.applicationDate between @2025-01-01 and @2025-12-31"), ["W301"]);
});

test("errors do not cascade from an earlier error in the same expression", () => {
  assert.deepEqual(exprCodes("applicant.nope + 1 > 2 and applicant.nope2 < 3"), ["E202", "E202"]);
});

test("a ruleset with errors returns no IR but keeps every diagnostic", () => {
  const source = rules("rule A: if loan.amount > applicant.age then approve\nrule B: if applicant.incme > 1 then approve");
  assert.deepEqual(codesOf(source), ["E201", "E202"]);
});

test("the IR is plain JSON", () => {
  const rs = compileOk(rules('default decline\nrule A priority 3: if loan.purpose in ["car_new"] then approve reason "OK"'));
  assert.deepEqual(JSON.parse(JSON.stringify(rs)), rs);
  assert.equal(rs.defaultOutcome, "decline");
  assert.deepEqual(rs.rules[0]!.then, [{ kind: "outcome", outcome: "approve", reason: "OK" }]);
});
