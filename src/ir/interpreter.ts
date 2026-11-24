import type { Case, Value } from "../model/case.ts";
import { BUILTINS, type EvalContext } from "./builtins.ts";
import { todayIso } from "./dates.ts";
import {
  OUTCOME_SEVERITY,
  executionOrder,
  type Action,
  type DecisionResult,
  type Expr,
  type Outcome,
  type ReasonEntry,
  type RuleSet,
  type TraceEntry,
  type Truth,
} from "./ir.ts";

export interface Env {
  input: Case;
  outputRoot: string;
  outputs: Record<string, Value>;
  ctx: EvalContext;
}

export interface EvaluateOptions {
  today?: string;
  outputRoot?: string;
}

function compare(op: string, a: Value, b: Value): boolean {
  switch (op) {
    case "==":
      return a === b;
    case "!=":
      return a !== b;
    case "<":
      return (a as number | string) < (b as number | string);
    case "<=":
      return (a as number | string) <= (b as number | string);
    case ">":
      return (a as number | string) > (b as number | string);
    default:
      return (a as number | string) >= (b as number | string);
  }
}

function arith(op: string, a: number, b: number): number | null {
  switch (op) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    default:
      return b === 0 ? null : a / b;
  }
}

export function evalExpr(expr: Expr, env: Env): Value {
  switch (expr.op) {
    case "lit":
      return expr.value;
    case "field": {
      const source = expr.root === env.outputRoot ? env.outputs : env.input[expr.root];
      const v = source?.[expr.field];
      return v === undefined ? null : v;
    }
    case "list":
      return expr.items.map((i) => evalExpr(i, env));
    case "not": {
      const v = evalExpr(expr.arg, env);
      return v === null ? null : !v;
    }
    case "and": {
      let unknown = false;
      for (const a of expr.args) {
        const v = evalExpr(a, env);
        if (v === false) return false;
        if (v === null) unknown = true;
      }
      return unknown ? null : true;
    }
    case "or": {
      let unknown = false;
      for (const a of expr.args) {
        const v = evalExpr(a, env);
        if (v === true) return true;
        if (v === null) unknown = true;
      }
      return unknown ? null : false;
    }
    case "cmp": {
      const l = evalExpr(expr.left, env);
      const r = evalExpr(expr.right, env);
      if (l === null || r === null) return null;
      return compare(expr.cmp, l, r);
    }
    case "arith": {
      const l = evalExpr(expr.left, env);
      const r = evalExpr(expr.right, env);
      if (l === null || r === null) return null;
      return arith(expr.arith, l as number, r as number);
    }
    case "neg": {
      const v = evalExpr(expr.arg, env);
      return v === null ? null : -(v as number);
    }
    case "between": {
      const v = evalExpr(expr.arg, env);
      const lo = evalExpr(expr.low, env);
      const hi = evalExpr(expr.high, env);
      if (v === null || lo === null || hi === null) return null;
      return (v as number) >= (lo as number) && (v as number) <= (hi as number);
    }
    case "in": {
      const v = evalExpr(expr.arg, env);
      const l = evalExpr(expr.list, env);
      if (v === null || l === null) return null;
      return (l as Value[]).includes(v);
    }
    case "isNull":
      return evalExpr(expr.arg, env) === null;
    case "coalesce": {
      const l = evalExpr(expr.left, env);
      return l !== null ? l : evalExpr(expr.right, env);
    }
    case "call": {
      const fn = BUILTINS.get(expr.fn);
      if (fn === undefined) throw new Error(`unknown function ${expr.fn}`);
      const args = expr.args.map((a) => evalExpr(a, env));
      if (args.some((a) => a === null)) return null;
      return fn.run(args, env.ctx);
    }
  }
}

function truth(v: Value): Truth {
  if (v === true) return "true";
  if (v === false) return "false";
  return "unknown";
}

interface OutcomeHit {
  outcome: Outcome;
  rule: string;
}

function runActions(actions: Action[], rule: string, env: Env, hits: OutcomeHit[], reasons: ReasonEntry[]): void {
  for (const action of actions) {
    switch (action.kind) {
      case "outcome":
        hits.push({ outcome: action.outcome, rule });
        if (action.reason !== null) reasons.push({ code: action.reason, rule, outcome: action.outcome });
        break;
      case "reason":
        reasons.push({ code: action.code, rule, outcome: null });
        break;
      case "set":
        env.outputs[action.field] = evalExpr(action.value, env);
        break;
    }
  }
}

export function evaluate(ruleset: RuleSet, input: Case, options: EvaluateOptions = {}): DecisionResult {
  const env: Env = {
    input,
    outputRoot: options.outputRoot ?? "decision",
    outputs: {},
    ctx: { today: options.today ?? todayIso() },
  };
  const hits: OutcomeHit[] = [];
  const allReasons: ReasonEntry[] = [];
  const fired: string[] = [];
  const trace: TraceEntry[] = [];
  for (const rule of executionOrder(ruleset)) {
    const result = truth(evalExpr(rule.condition, env));
    let branch: TraceEntry["branch"] = "none";
    if (result === "true" && rule.then.length > 0) branch = "then";
    if (result === "false" && rule.else.length > 0) branch = "else";
    if (branch !== "none") {
      fired.push(rule.id);
      runActions(branch === "then" ? rule.then : rule.else, rule.id, env, hits, allReasons);
    }
    trace.push({ rule: rule.id, result, branch });
  }
  let outcome: Outcome = ruleset.defaultOutcome;
  if (hits.length > 0) {
    outcome = hits.reduce((worst, h) => (OUTCOME_SEVERITY[h.outcome] > OUTCOME_SEVERITY[worst] ? h.outcome : worst), hits[0]!.outcome);
  }
  const reasons = allReasons.filter((r) => r.outcome === null || r.outcome === outcome);
  return { ruleset: ruleset.name, outcome, reasons, outputs: env.outputs, fired, trace };
}
