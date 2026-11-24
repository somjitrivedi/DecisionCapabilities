import type { Value } from "../model/case.ts";
import type { ArithOp, Type } from "./types.ts";

export const IR_VERSION = 1;

export type CmpOp = "==" | "!=" | "<" | "<=" | ">" | ">=";

export type Expr =
  | { op: "lit"; type: Type; value: Value }
  | { op: "field"; type: Type; root: string; field: string }
  | { op: "list"; type: Type; items: Expr[] }
  | { op: "not"; type: Type; arg: Expr }
  | { op: "and" | "or"; type: Type; args: Expr[] }
  | { op: "cmp"; type: Type; cmp: CmpOp; left: Expr; right: Expr }
  | { op: "arith"; type: Type; arith: ArithOp; left: Expr; right: Expr }
  | { op: "neg"; type: Type; arg: Expr }
  | { op: "between"; type: Type; arg: Expr; low: Expr; high: Expr }
  | { op: "in"; type: Type; arg: Expr; list: Expr }
  | { op: "isNull"; type: Type; arg: Expr }
  | { op: "coalesce"; type: Type; left: Expr; right: Expr }
  | { op: "call"; type: Type; fn: string; args: Expr[] };

export type Outcome = "approve" | "refer" | "decline";

export const OUTCOMES: readonly Outcome[] = ["approve", "refer", "decline"];

export const OUTCOME_SEVERITY: Record<Outcome, number> = { approve: 1, refer: 2, decline: 3 };

export type Action =
  | { kind: "outcome"; outcome: Outcome; reason: string | null }
  | { kind: "reason"; code: string }
  | { kind: "set"; field: string; value: Expr };

export interface Rule {
  id: string;
  priority: number;
  order: number;
  line: number;
  condition: Expr;
  then: Action[];
  else: Action[];
}

export interface RuleSet {
  irVersion: number;
  name: string;
  schema: string;
  defaultOutcome: Outcome;
  rules: Rule[];
}

export interface ReasonEntry {
  code: string;
  rule: string;
  outcome: Outcome | null;
}

export type Truth = "true" | "false" | "unknown";

export interface TraceEntry {
  rule: string;
  result: Truth;
  branch: "then" | "else" | "none";
}

export interface DecisionResult {
  ruleset: string;
  outcome: Outcome;
  reasons: ReasonEntry[];
  outputs: Record<string, Value>;
  fired: string[];
  trace: TraceEntry[];
}

export function executionOrder(ruleset: RuleSet): Rule[] {
  return [...ruleset.rules].sort((a, b) => b.priority - a.priority || a.order - b.order);
}
