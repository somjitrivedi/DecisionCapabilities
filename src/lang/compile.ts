import { createHash } from "node:crypto";
import type { Schema } from "../model/schema.ts";
import type { Expr, RuleSet } from "../ir/ir.ts";
import type { Type } from "../ir/types.ts";
import { Checker } from "./checker.ts";
import { SourceMap, formatDiagnostic, hasErrors, type Diagnostic } from "./diagnostics.ts";
import { parse, parseExpression } from "./parser.ts";

export interface CompileResult {
  ruleset: RuleSet | null;
  diagnostics: Diagnostic[];
  sourceHash: string;
}

export function hashSource(source: string): string {
  return createHash("sha256").update(source.replace(/\r\n/g, "\n")).digest("hex");
}

function sortDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((a, b) => a.span.start - b.span.start);
}

export function compile(source: string, schema: Schema): CompileResult {
  const sourceHash = hashSource(source);
  const parsed = parse(source);
  if (parsed.file === null) return { ruleset: null, diagnostics: sortDiagnostics(parsed.diagnostics), sourceHash };
  const checker = new Checker(schema, source);
  const ruleset = checker.checkFile(parsed.file);
  const diagnostics = sortDiagnostics([...parsed.diagnostics, ...checker.diagnostics]);
  return { ruleset: hasErrors(diagnostics) ? null : ruleset, diagnostics, sourceHash };
}

export interface ExpressionResult {
  expr: Expr | null;
  type: Type | null;
  diagnostics: Diagnostic[];
}

export function compileExpression(source: string, schema: Schema, expected?: Type): ExpressionResult {
  const parsed = parseExpression(source);
  if (parsed.expr === null) return { expr: null, type: null, diagnostics: parsed.diagnostics };
  const checker = new Checker(schema, source);
  const checked = checker.checkStandalone(parsed.expr, expected);
  const diagnostics = sortDiagnostics([...parsed.diagnostics, ...checker.diagnostics]);
  return hasErrors(diagnostics)
    ? { expr: null, type: null, diagnostics }
    : { expr: checked.ir, type: checked.type, diagnostics };
}

export function formatAll(diagnostics: Diagnostic[], source: string, file: string): string {
  const map = new SourceMap(source);
  return diagnostics.map((d) => formatDiagnostic(d, map, file)).join("\n\n");
}
