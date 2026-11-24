import { readFileSync } from "node:fs";
import type { Case, LoanCase, Value } from "../src/model/case.ts";
import { underwritingSchema } from "../src/model/underwriting.ts";
import { evalExpr } from "../src/ir/interpreter.ts";
import type { RuleSet } from "../src/ir/ir.ts";
import { compile, compileExpression, formatAll } from "../src/lang/compile.ts";
import type { Diagnostic } from "../src/lang/diagnostics.ts";

export const schema = underwritingSchema;

export function baseCase(): LoanCase {
  return {
    applicant: {
      id: "T1",
      age: 40,
      dateOfBirth: null,
      income: 60_000,
      dependents: 1,
      residenceYears: 4,
      housing: "own",
      hasTelephone: true,
      documents: ["id_proof", "income_proof"],
    },
    employment: { tenure: "4_to_7y", jobType: "skilled" },
    accounts: { checking: "healthy", savings: "high" },
    bureau: { score: 720, history: "existing_paid", existingCredits: 1, otherPlans: "none", delinquencies: 0 },
    loan: {
      amount: 8_000,
      termMonths: 24,
      purpose: "car_used",
      installmentBurden: 2,
      collateral: "car_or_other",
      guarantor: "none",
      applicationDate: "2026-11-20",
    },
  };
}

export function asCase(c: LoanCase): Case {
  return c as unknown as Case;
}

export function compileOk(source: string): RuleSet {
  const result = compile(source, schema);
  if (result.ruleset === null) throw new Error(formatAll(result.diagnostics, source, "test.rules"));
  return result.ruleset;
}

export function diagnosticsOf(source: string): Diagnostic[] {
  return compile(source, schema).diagnostics;
}

export function codesOf(source: string): string[] {
  return diagnosticsOf(source).map((d) => d.code);
}

export function exprCodes(text: string): string[] {
  return compileExpression(text, schema).diagnostics.map((d) => d.code);
}

export function evalText(text: string, input: LoanCase = baseCase(), today = "2026-11-24"): Value {
  const result = compileExpression(text, schema);
  if (result.expr === null) throw new Error(formatAll(result.diagnostics, text, "expr"));
  return evalExpr(result.expr, { input: asCase(input), outputs: {}, outputRoot: "decision", ctx: { today } });
}

export function underwritingRules(): RuleSet {
  return compileOk(readFileSync("rules/personal-loan.rules", "utf8"));
}
