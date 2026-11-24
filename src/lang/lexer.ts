import { isIsoDate } from "../model/case.ts";
import type { Diagnostic, Span } from "./diagnostics.ts";

export type TokenKind =
  | "ident"
  | "keyword"
  | "number"
  | "string"
  | "date"
  | "op"
  | "eof";

export interface Token {
  kind: TokenKind;
  text: string;
  value: string | number;
  span: Span;
}

export const KEYWORDS = new Set([
  "ruleset",
  "default",
  "const",
  "rule",
  "priority",
  "if",
  "then",
  "else",
  "and",
  "or",
  "not",
  "in",
  "is",
  "null",
  "true",
  "false",
  "between",
  "approve",
  "decline",
  "refer",
  "reason",
  "set",
]);

const OPERATORS = ["??", "==", "!=", "<>", "<=", ">=", "<", ">", "=", "+", "-", "*", "/", "(", ")", "[", "]", ",", ".", ":"];

const CHAR_HINTS: Record<string, string> = {
  "&": "write and instead of &&",
  "|": "write or instead of ||",
  "!": "write not for negation, or != for inequality",
  "'": 'strings use double quotes, as in "LOW_INCOME"',
  ";": "rules need no terminator; separate actions with commas",
};

const isIdentStart =(c: string): boolean => /[A-Za-z_]/.test(c);
const isIdentPart = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
const isDigit = (c: string): boolean => c >= "0" && c <= "9";

export interface LexResult {
  tokens: Token[];
  diagnostics: Diagnostic[];
}

export function lex(text: string): LexResult {
  const tokens: Token[] = [];
  const diagnostics: Diagnostic[] = [];
  let i = 0;
  const push = (kind: TokenKind, start: number, value: string | number): void => {
    tokens.push({ kind, text: text.slice(start, i), value, span: { start, end: i } });
  };
  while (i < text.length) {
    const c = text[i]!;
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i++;
      continue;
    }
    if (c === "#" || (c === "/" && text[i + 1] === "/")) {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    const start = i;
    if (isIdentStart(c)) {
      while (i < text.length && isIdentPart(text[i]!)) i++;
      const word = text.slice(start, i);
      const lower = word.toLowerCase();
      if (KEYWORDS.has(lower)) push("keyword", start, lower);
      else push("ident", start, word);
      continue;
    }
    if (isDigit(c)) {
      while (i < text.length && (isDigit(text[i]!) || text[i] === "_")) i++;
      if (text[i] === "." && isDigit(text[i + 1] ?? "")) {
        i++;
        while (i < text.length && (isDigit(text[i]!) || text[i] === "_")) i++;
      }
      const raw = text.slice(start, i);
      if (raw.endsWith("_") || raw.includes("__")) {
        diagnostics.push({
          severity: "error",
          code: "E004",
          message: `malformed number ${raw}`,
          span: { start, end: i },
          hint: "underscores may only separate digit groups, as in 30_000",
        });
      }
      push("number", start, Number(raw.replaceAll("_", "")));
      if (isIdentStart(text[i] ?? "")) {
        const s = i;
        while (i < text.length && isIdentPart(text[i]!)) i++;
        diagnostics.push({
          severity: "error",
          code: "E004",
          message: `unexpected ${text.slice(s, i)} after number`,
          span: { start: s, end: i },
          hint: "separate the number from the word with a space or an operator",
        });
      }
      continue;
    }
    if (c === '"') {
      i++;
      let value = "";
      let closed = false;
      while (i < text.length) {
        const ch = text[i]!;
        if (ch === "\n") break;
        if (ch === '"') {
          i++;
          closed = true;
          break;
        }
        if (ch === "\\" && i + 1 < text.length) {
          const next = text[i + 1]!;
          value += next === "n" ? "\n" : next === "t" ? "\t" : next;
          i += 2;
          continue;
        }
        value += ch;
        i++;
      }
      if (!closed) {
        diagnostics.push({
          severity: "error",
          code: "E002",
          message: "unterminated string",
          span: { start, end: i },
          hint: 'close the string with " on the same line',
        });
      }
      push("string", start, value);
      continue;
    }
    if (c === "@") {
      i++;
      while (i < text.length && /[0-9-]/.test(text[i]!)) i++;
      const raw = text.slice(start + 1, i);
      if (!isIsoDate(raw)) {
        diagnostics.push({
          severity: "error",
          code: "E003",
          message: `invalid date literal @${raw}`,
          span: { start, end: i },
          hint: "write dates as @YYYY-MM-DD, for example @2025-01-31",
        });
      }
      push("date", start, raw);
      continue;
    }
    const op = OPERATORS.find((o) => text.startsWith(o, i));
    if (op !== undefined) {
      i += op.length;
      push("op", start, op === "<>" ? "!=" : op === "=" ? "==" : op);
      continue;
    }
    if ((c === "&" || c === "|") && text[i + 1] === c) {
      i += 2;
      diagnostics.push({
        severity: "error",
        code: "E001",
        message: `${c}${c} is not an operator`,
        span: { start, end: i },
        hint: CHAR_HINTS[c]!,
      });
      push("keyword", start, c === "&" ? "and" : "or");
      continue;
    }
    i++;
    const diagnostic: Diagnostic = {
      severity: "error",
      code: "E001",
      message: `unexpected character ${JSON.stringify(c)}`,
      span: { start, end: i },
    };
    const hint = CHAR_HINTS[c];
    if (hint !== undefined) diagnostic.hint = hint;
    diagnostics.push(diagnostic);
  }
  tokens.push({ kind: "eof", text: "", value: "", span: { start: text.length, end: text.length } });
  return { tokens, diagnostics };
}
