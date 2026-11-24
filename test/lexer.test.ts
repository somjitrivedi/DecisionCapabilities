import assert from "node:assert/strict";
import { test } from "node:test";
import { lex } from "../src/lang/lexer.ts";

const kinds = (text: string): string[] => lex(text).tokens.map((t) => `${t.kind}:${t.value}`);

test("keywords are case-insensitive and identifiers keep their case", () => {
  assert.deepEqual(kinds("IF applicant.Income Then"), ["keyword:if", "ident:applicant", "op:.", "ident:Income", "keyword:then", "eof:"]);
});

test("numbers accept digit-group underscores and decimals", () => {
  const toks = lex("30_000 12.75 7").tokens;
  assert.deepEqual(toks.slice(0, 3).map((t) => t.value), [30000, 12.75, 7]);
});

test("malformed numbers are reported", () => {
  assert.equal(lex("30_ ").diagnostics[0]?.code, "E004");
  assert.equal(lex("12abc").diagnostics[0]?.code, "E004");
});

test("strings support escapes and report missing quotes", () => {
  assert.equal(lex('"a\\"b"').tokens[0]?.value, 'a"b');
  const r = lex('"open\nrule');
  assert.equal(r.diagnostics[0]?.code, "E002");
});

test("date literals are validated", () => {
  assert.equal(lex("@2024-02-29").tokens[0]?.value, "2024-02-29");
  assert.equal(lex("@2024-02-29").diagnostics.length, 0);
  assert.equal(lex("@2023-02-29").diagnostics[0]?.code, "E003");
  assert.equal(lex("@2023-2-1").diagnostics[0]?.code, "E003");
});

test("= and <> normalise to == and !=", () => {
  assert.deepEqual(kinds("a = b <> c"), ["ident:a", "op:==", "ident:b", "op:!=", "ident:c", "eof:"]);
});

test("&& and || are reported but recovered as and/or", () => {
  const r = lex("a && b || c");
  assert.deepEqual(r.diagnostics.map((d) => d.code), ["E001", "E001"]);
  assert.deepEqual(r.tokens.map((t) => t.value), ["a", "and", "b", "or", "c", ""]);
});

test("line comments are skipped", () => {
  assert.deepEqual(kinds("a # note\nb // other"), ["ident:a", "ident:b", "eof:"]);
});

test("unexpected characters carry hints", () => {
  const d = lex("a ; b").diagnostics[0]!;
  assert.equal(d.code, "E001");
  assert.match(d.hint ?? "", /commas/);
});
