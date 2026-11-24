import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExprNode } from "../src/lang/ast.ts";
import { parse, parseExpression } from "../src/lang/parser.ts";

function shape(node: ExprNode): string {
  switch (node.kind) {
    case "number":
      return String(node.value);
    case "string":
      return JSON.stringify(node.value);
    case "bool":
      return String(node.value);
    case "null":
      return "null";
    case "date":
      return `@${node.value}`;
    case "list":
      return `[${node.items.map(shape).join(",")}]`;
    case "path":
      return node.parts.join(".");
    case "unary":
      return `(${node.op} ${shape(node.arg)})`;
    case "binary":
      return `(${shape(node.left)} ${node.op} ${shape(node.right)})`;
    case "between":
      return `(${shape(node.arg)} ${node.negated ? "not " : ""}between ${shape(node.low)} ${shape(node.high)})`;
    case "in":
      return `(${shape(node.arg)} ${node.negated ? "not " : ""}in ${shape(node.list)})`;
    case "isNull":
      return `(${shape(node.arg)} is ${node.negated ? "not " : ""}null)`;
    case "call":
      return `${node.name}(${node.args.map(shape).join(",")})`;
  }
}

const p = (text: string): string => {
  const r = parseExpression(text);
  assert.deepEqual(r.diagnostics, []);
  return shape(r.expr!);
};

test("precedence: or < and < not < comparison < ?? < additive < multiplicative < unary", () => {
  assert.equal(p("a or b and c"), "(a or (b and c))");
  assert.equal(p("not a and b"), "((not a) and b)");
  assert.equal(p("x.a + 2 * 3 > 7"), "((x.a + (2 * 3)) > 7)");
  assert.equal(p("x.a ?? 0 < 5"), "((x.a ?? 0) < 5)");
  assert.equal(p("x.a ?? 1 + 2"), "(x.a ?? (1 + 2))");
  assert.equal(p("-x.a * 2"), "((- x.a) * 2)");
  assert.equal(p("a - b - c"), "((a - b) - c)");
});

test("between binds its own and", () => {
  assert.equal(p("x.a between 1 and 5 and x.b"), "((x.a between 1 5) and x.b)");
  assert.equal(p("x.a not between 1 and 5"), "(x.a not between 1 5)");
});

test("in, not in, is null and is not null", () => {
  assert.equal(p('x.a in ["p", "q"]'), '(x.a in ["p","q"])');
  assert.equal(p("x.a not in []"), "(x.a not in [])");
  assert.equal(p("x.a is null or x.b is not null"), "((x.a is null) or (x.b is not null))");
});

test("calls, dates and parentheses", () => {
  assert.equal(p("min(x.a, 3) > age(@2000-01-01)"), "(min(x.a,3) > age(@2000-01-01))");
  assert.equal(p("(a or b) and c"), "((a or b) and c)");
  assert.equal(p("today()"), "today()");
});

test("chained comparisons are rejected", () => {
  const r = parseExpression("a < b < c");
  assert.equal(r.diagnostics[0]?.code, "E101");
  assert.match(r.diagnostics[0]!.message, /chained/);
});

test("a full ruleset parses with header, consts, priorities and else branches", () => {
  const r = parse(`ruleset Demo
default decline
const LIMIT = 5
rule A priority 10: if loan.amount > LIMIT then refer reason "BIG", reason "EXTRA"
rule "Second rule" priority -2:
  if true then set decision.apr = 1 else approve`);
  assert.deepEqual(r.diagnostics, []);
  const f = r.file!;
  assert.equal(f.name, "Demo");
  assert.equal(f.defaultOutcome, "decline");
  assert.equal(f.consts[0]?.name, "LIMIT");
  assert.deepEqual(f.rules.map((x) => [x.name, x.priority, x.then.length, x.else.length]), [
    ["A", 10, 2, 0],
    ["Second rule", -2, 1, 1],
  ]);
});

test("a missing header stops parsing with a hint", () => {
  const r = parse("rule A: if true then approve");
  assert.equal(r.file, null);
  assert.match(r.diagnostics[0]!.hint ?? "", /ruleset/);
});

test("errors recover at the next rule so several are reported at once", () => {
  const r = parse(`ruleset X
rule A: if loan.amount > then approve
rule B: if true approve
rule C: if true then
rule D: if true then approve`);
  assert.deepEqual(
    r.diagnostics.map((d) => d.message),
    [
      "expected a value, found keyword then",
      "expected then after the condition, found keyword approve",
      "expected an action, found keyword rule",
    ],
  );
  assert.deepEqual(r.file!.rules.map((x) => x.name), ["D"]);
});

test("stray tokens after actions are reported", () => {
  const r = parse("ruleset X\nrule A: if true then approve decline");
  assert.match(r.diagnostics[0]!.message, /after the actions/);
});

test("reserved words may name rules when the name is clearly delimited", () => {
  const ok = parse("ruleset Refer\nrule Decline: if true then approve\nrule Approve priority 2 if true then approve");
  assert.deepEqual(ok.diagnostics, []);
  assert.equal(ok.file!.name, "Refer");
  assert.deepEqual(ok.file!.rules.map((r) => r.name), ["Decline", "Approve"]);
  assert.match(parse("ruleset X\nrule then then approve").diagnostics[0]!.message, /reserved/);
  assert.equal(parse('ruleset X\nrule "then": if true then approve').diagnostics.length, 0);
});

test("reason codes must be quoted", () => {
  const r = parse("ruleset X\nrule A: if true then decline reason LOW");
  assert.match(r.diagnostics[0]!.hint ?? "", /reason "LOW_INCOME"/);
});
