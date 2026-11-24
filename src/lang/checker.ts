import type { Value } from "../model/case.ts";
import { findField, rootEntity, type Schema } from "../model/schema.ts";
import { BUILTINS } from "../ir/builtins.ts";
import { evalExpr } from "../ir/interpreter.ts";
import { IR_VERSION, type Action, type CmpOp, type Expr, type Rule, type RuleSet } from "../ir/ir.ts";
import {
  T,
  arithmeticType,
  assignable,
  fromFieldType,
  isAny,
  isFlexible,
  isNumeric,
  numericUnify,
  orderable,
  sameType,
  show,
  withNullable,
  type ArithOp,
  type Type,
} from "../ir/types.ts";
import type { ActionNode, ExprNode, FileNode, RuleDecl } from "./ast.ts";
import { SourceMap, closest, type Diagnostic, type Span } from "./diagnostics.ts";

interface Checked {
  type: Type;
  ir: Expr;
}

const REASON_RE = /^[A-Z][A-Z0-9_]*$/;

function pathKey(node: ExprNode): string | null {
  return node.kind === "path" && node.parts.length === 2 ? node.parts.join(".") : null;
}

function nonNullFacts(node: ExprNode): string[] {
  if (node.kind === "isNull" && node.negated) {
    const key = pathKey(node.arg);
    return key === null ? [] : [key];
  }
  if (node.kind === "binary" && node.op === "and") return [...nonNullFacts(node.left), ...nonNullFacts(node.right)];
  return [];
}

function nullFacts(node: ExprNode): string[] {
  if (node.kind === "isNull" && !node.negated) {
    const key = pathKey(node.arg);
    return key === null ? [] : [key];
  }
  if (node.kind === "binary" && node.op === "or") return [...nullFacts(node.left), ...nullFacts(node.right)];
  return [];
}

function isConstant(expr: Expr): boolean {
  switch (expr.op) {
    case "lit":
      return true;
    case "field":
    case "call":
      return false;
    case "list":
      return expr.items.every(isConstant);
    case "not":
    case "neg":
    case "isNull":
      return isConstant(expr.arg);
    case "and":
    case "or":
      return expr.args.every(isConstant);
    case "cmp":
    case "arith":
    case "coalesce":
      return isConstant(expr.left) && isConstant(expr.right);
    case "between":
      return isConstant(expr.arg) && isConstant(expr.low) && isConstant(expr.high);
    case "in":
      return isConstant(expr.arg) && isConstant(expr.list);
  }
}

function lit(type: Type, value: Value): Expr {
  return { op: "lit", type, value };
}

export class Checker {
  readonly diagnostics: Diagnostic[] = [];
  private readonly consts = new Map<string, Checked>();
  private narrowed = new Set<string>();
  private warned = new Set<string>();
  private readonly map: SourceMap;

  private readonly schema: Schema;
  private readonly source: string;

  constructor(schema: Schema, source: string) {
    this.schema = schema;
    this.source = source;
    this.map = new SourceMap(source);
  }

  private report(severity: Diagnostic["severity"], code: string, message: string, span: Span, hint?: string): void {
    const d: Diagnostic = { severity, code, message, span };
    if (hint !== undefined) d.hint = hint;
    this.diagnostics.push(d);
  }

  private error(code: string, message: string, span: Span, hint?: string): Checked {
    this.report("error", code, message, span, hint);
    return { type: T.any(), ir: lit(T.any(), null) };
  }

  private text(node: { span: Span }): string {
    const raw = this.source.slice(node.span.start, node.span.end).replace(/\s+/g, " ");
    return raw.length > 40 ? `${raw.slice(0, 37)}...` : raw;
  }

  private withNarrowing<R>(keys: string[], fn: () => R): R {
    if (keys.length === 0) return fn();
    const saved = this.narrowed;
    this.narrowed = new Set([...saved, ...keys]);
    try {
      return fn();
    } finally {
      this.narrowed = saved;
    }
  }

  checkFile(file: FileNode): RuleSet {
    const outputRoot = this.schema.output;
    for (const c of file.consts) {
      if (this.consts.has(c.name)) {
        this.error("E213", `constant ${c.name} is already defined`, c.nameSpan);
        continue;
      }
      if (this.schema.roots[c.name] !== undefined || BUILTINS.has(c.name)) {
        this.error("E213", `constant ${c.name} clashes with a built-in name`, c.nameSpan, "pick a different name");
        continue;
      }
      const checked = this.expr(c.value);
      if (!isConstant(checked.ir)) {
        this.error("E217", `constant ${c.name} must be computed from literals and other constants`, c.value.span);
        continue;
      }
      const value = evalExpr(checked.ir, { input: {}, outputs: {}, outputRoot, ctx: { today: "1970-01-01" } });
      this.consts.set(c.name, { type: checked.type, ir: lit(checked.type, value) });
    }
    const rules: Rule[] = [];
    const names = new Map<string, RuleDecl>();
    file.rules.forEach((decl, order) => {
      const prior = names.get(decl.name);
      if (prior !== undefined) {
        this.error(
          "E102",
          `rule ${decl.name} is already defined on line ${this.map.position(prior.nameSpan.start).line}`,
          decl.nameSpan,
          "rule names must be unique within a ruleset",
        );
      } else names.set(decl.name, decl);
      const rule = this.checkRule(decl, order);
      if (rule !== null) rules.push(rule);
    });
    return {
      irVersion: IR_VERSION,
      name: file.name,
      schema: this.schema.name,
      defaultOutcome: file.defaultOutcome ?? "refer",
      rules,
    };
  }

  private checkRule(decl: RuleDecl, order: number): Rule | null {
    this.warned = new Set();
    const cond = this.expr(decl.condition);
    if (!isAny(cond.type) && cond.type.kind !== "boolean") {
      this.error(
        "E207",
        `the condition of rule ${decl.name} is ${show(cond.type)}, not a true/false test`,
        decl.condition.span,
        "compare it with something, as in applicant.income < 30000",
      );
    }
    const thenActions = this.withNarrowing(nonNullFacts(decl.condition), () => this.actions(decl.then, decl.name));
    const elseActions = this.withNarrowing(nullFacts(decl.condition), () => this.actions(decl.else, decl.name));
    return {
      id: decl.name,
      priority: decl.priority,
      order,
      line: this.map.position(decl.span.start).line,
      condition: cond.ir,
      then: thenActions,
      else: elseActions,
    };
  }

  private actions(nodes: ActionNode[], rule: string): Action[] {
    const out: Action[] = [];
    const outcomes = nodes.filter((n) => n.kind === "outcome");
    if (outcomes.length > 1) {
      this.report(
        "warning",
        "W305",
        `rule ${rule} sets ${outcomes.length} outcomes in one branch; only the most severe one counts`,
        outcomes[1]!.span,
      );
    }
    for (const node of nodes) {
      switch (node.kind) {
        case "outcome":
          if (node.reason !== null) this.checkReason(node.reason, node.span);
          out.push({ kind: "outcome", outcome: node.outcome, reason: node.reason });
          break;
        case "reason":
          this.checkReason(node.code, node.span);
          out.push({ kind: "reason", code: node.code });
          break;
        case "set": {
          const action = this.setAction(node);
          if (action !== null) out.push(action);
          break;
        }
      }
    }
    return out;
  }

  private checkReason(code: string, span: Span): void {
    if (!REASON_RE.test(code)) {
      this.report("warning", "W304", `reason code "${code}" is not UPPER_SNAKE_CASE`, span, "reason codes look like LOW_INCOME");
    }
  }

  private setAction(node: ActionNode & { kind: "set" }): Action | null {
    const target = node.target;
    const outputRoot = this.schema.output;
    const outputEntity = rootEntity(this.schema, outputRoot)!;
    const writable = outputEntity.fields.map((f) => `${outputRoot}.${f.name}`).join(", ");
    if (target.parts[0] !== outputRoot || target.parts.length !== 2) {
      const isInput = this.schema.roots[target.parts[0]!] !== undefined;
      this.error(
        "E210",
        isInput ? `${target.parts.join(".")} is an input and cannot be set` : `cannot set ${target.parts.join(".")}`,
        target.span,
        `only these fields can be set: ${writable}`,
      );
      this.expr(node.value);
      return null;
    }
    const fieldName = target.parts[1]!;
    const f = findField(outputEntity, fieldName);
    if (f === undefined) {
      const guess = closest(fieldName, outputEntity.fields.map((x) => x.name));
      this.error(
        "E202",
        `${outputEntity.name} has no field ${fieldName}`,
        target.partSpans[1]!,
        guess !== undefined ? `did you mean ${outputRoot}.${guess}?` : `fields: ${writable}`,
      );
      this.expr(node.value);
      return null;
    }
    const fieldType = fromFieldType(f.type, f.nullable);
    const value = this.expr(node.value, fieldType);
    if (!assignable(fieldType, value.type) || (!f.nullable && value.type.nullable)) {
      this.error(
        "E211",
        `${outputRoot}.${fieldName} is ${show(fieldType)}, but the value is ${show(value.type)}`,
        node.value.span,
        this.mismatchHint(fieldType, value.type),
      );
      return null;
    }
    return { kind: "set", field: fieldName, value: value.ir };
  }

  checkStandalone(node: ExprNode, expected?: Type): Checked {
    this.warned = new Set();
    return this.expr(node, expected);
  }

  private expr(node: ExprNode, expected?: Type, nullOk = false): Checked {
    switch (node.kind) {
      case "number":
        return { type: T.flexNumber(), ir: lit(T.flexNumber(), node.value) };
      case "string":
        if (expected !== undefined && expected.kind === "enum") return this.enumLiteral(node.value, expected, node.span);
        return { type: T.string(), ir: lit(T.string(), node.value) };
      case "bool":
        return { type: T.boolean(), ir: lit(T.boolean(), node.value) };
      case "null":
        return { type: T.null(), ir: lit(T.null(), null) };
      case "date":
        return { type: T.date(), ir: lit(T.date(), node.value) };
      case "list":
        return this.list(node, expected);
      case "path":
        return this.path(node, nullOk);
      case "unary":
        return node.op === "not" ? this.not(node) : this.negate(node);
      case "binary":
        return this.binary(node);
      case "between":
        return this.between(node);
      case "in":
        return this.inList(node);
      case "isNull":
        return this.isNull(node);
      case "call":
        return this.call(node);
    }
  }

  private enumLiteral(value: string, type: Type & { kind: "enum" }, span: Span): Checked {
    const values = this.schema.enums[type.name]?.values ?? [];
    if (!values.includes(value)) {
      const guess = closest(value, values);
      return this.error(
        "E208",
        `"${value}" is not a ${type.name} value`,
        span,
        guess !== undefined ? `did you mean "${guess}"?` : `${type.name} values: ${values.map((v) => `"${v}"`).join(", ")}`,
      );
    }
    const t = T.enumOf(type.name);
    return { type: t, ir: lit(t, value) };
  }

  private list(node: ExprNode & { kind: "list" }, expected?: Type): Checked {
    const elementExpected = expected?.kind === "list" ? expected.element : expected;
    const items = node.items.map((i) => this.expr(i, elementExpected));
    let element: Type = T.any();
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      if (isAny(it.type)) continue;
      if (it.type.kind === "null") {
        this.error("E215", "lists cannot contain null", node.items[i]!.span);
        continue;
      }
      if (isAny(element)) {
        element = withNullable(it.type, false);
        continue;
      }
      if (isNumeric(element) && isNumeric(it.type)) {
        const u = numericUnify(element, it.type);
        if (typeof u !== "string") {
          element = withNullable(u, false);
          continue;
        }
      }
      if (!sameType(element, it.type)) {
        this.error("E215", `list items must share one type; this item is ${show(it.type)}, earlier items are ${show(element)}`, node.items[i]!.span);
      }
    }
    const type = T.listOf(element);
    return { type, ir: { op: "list", type, items: items.map((i) => i.ir) } };
  }

  private path(node: ExprNode & { kind: "path" }, nullOk: boolean): Checked {
    const [head, ...rest] = node.parts as [string, ...string[]];
    const roots = Object.keys(this.schema.roots);
    if (rest.length === 0) {
      const c = this.consts.get(head);
      if (c !== undefined) return c;
      if (this.schema.roots[head] !== undefined) {
        const entity = rootEntity(this.schema, head)!;
        return this.error(
          "E214",
          `${head} is a whole ${entity.name}, not a value`,
          node.span,
          `name one of its fields, such as ${head}.${entity.fields[0]?.name ?? "field"}`,
        );
      }
      const guess = closest(head, [...this.consts.keys(), ...roots]);
      return this.error(
        "E214",
        `unknown name ${head}`,
        node.span,
        guess !== undefined ? `did you mean ${guess}?` : `fields are written as <entity>.<field>; entities: ${roots.join(", ")}`,
      );
    }
    const entity = rootEntity(this.schema, head);
    if (entity === undefined) {
      const guess = closest(head, roots);
      return this.error(
        "E203",
        `unknown entity ${head}`,
        node.partSpans[0]!,
        guess !== undefined ? `did you mean ${guess}?` : `entities: ${roots.join(", ")}`,
      );
    }
    const fieldName = rest[0]!;
    const f = findField(entity, fieldName);
    if (f === undefined) {
      const guess = closest(fieldName, entity.fields.map((x) => x.name));
      return this.error(
        "E202",
        `${entity.name} has no field ${fieldName}`,
        node.partSpans[1]!,
        guess !== undefined ? `did you mean ${head}.${guess}?` : `${entity.name} fields: ${entity.fields.map((x) => x.name).join(", ")}`,
      );
    }
    if (rest.length > 1) {
      return this.error("E202", `${head}.${fieldName} is ${show(fromFieldType(f.type, false))} and has no fields`, node.partSpans[2]!);
    }
    const key = `${head}.${fieldName}`;
    const isOutput = head === this.schema.output;
    const nullable = isOutput ? true : f.nullable && !this.narrowed.has(key);
    const type = fromFieldType(f.type, nullable);
    if (nullable && !isOutput && !nullOk && !this.warned.has(key)) {
      this.warned.add(key);
      this.report(
        "warning",
        "W301",
        `${key} can be null; when it is, this test is unknown and the rule does not fire`,
        node.span,
        `guard it with "${key} is not null and ...", or supply a fallback with "${key} ?? <value>"`,
      );
    }
    return { type, ir: { op: "field", type, root: head, field: fieldName } };
  }

  private not(node: ExprNode & { kind: "unary" }): Checked {
    const arg = this.expr(node.arg);
    if (!isAny(arg.type) && arg.type.kind !== "boolean") {
      return this.error("E207", `not needs a true/false test, but ${this.text(node.arg)} is ${show(arg.type)}`, node.arg.span);
    }
    const type = T.boolean(arg.type.nullable);
    return { type, ir: { op: "not", type, arg: arg.ir } };
  }

  private negate(node: ExprNode & { kind: "unary" }): Checked {
    const arg = this.expr(node.arg);
    if (!isNumeric(arg.type)) {
      return this.error("E212", `cannot negate ${show(arg.type)}`, node.arg.span);
    }
    if (arg.ir.op === "lit" && typeof arg.ir.value === "number") {
      return { type: arg.type, ir: lit(arg.type, -arg.ir.value) };
    }
    return { type: arg.type, ir: { op: "neg", type: arg.type, arg: arg.ir } };
  }

  private binary(node: ExprNode & { kind: "binary" }): Checked {
    switch (node.op) {
      case "and":
      case "or":
        return this.logical(node);
      case "==":
      case "!=":
      case "<":
      case "<=":
      case ">":
      case ">=":
        return this.compare(node);
      case "??":
        return this.coalesce(node);
      default:
        return this.arith(node, node.op);
    }
  }

  private logical(node: ExprNode & { kind: "binary" }): Checked {
    const op = node.op as "and" | "or";
    const left = this.expr(node.left);
    const facts = op === "and" ? nonNullFacts(node.left) : nullFacts(node.left);
    const right = this.withNarrowing(facts, () => this.expr(node.right));
    for (const [side, c] of [
      [node.left, left],
      [node.right, right],
    ] as const) {
      if (!isAny(c.type) && c.type.kind !== "boolean") {
        this.error(
          "E207",
          `both sides of ${op} must be true/false tests, but ${this.text(side)} is ${show(c.type)}`,
          side.span,
          "compare the value with something, as in loan.amount > 5000",
        );
      }
    }
    const type = T.boolean(left.type.nullable || right.type.nullable);
    const args: Expr[] = [];
    for (const c of [left, right]) {
      if (c.ir.op === op) args.push(...c.ir.args);
      else args.push(c.ir);
    }
    return { type, ir: { op, type, args } };
  }

  private operands(left: ExprNode, right: ExprNode): [Checked, Checked] {
    const literalish = (n: ExprNode): boolean => n.kind === "string" || n.kind === "list";
    if (literalish(left) && !literalish(right)) {
      const r = this.expr(right);
      const l = this.expr(left, r.type);
      return [l, r];
    }
    const l = this.expr(left);
    const r = this.expr(right, l.type);
    return [l, r];
  }

  private compare(node: ExprNode & { kind: "binary" }): Checked {
    const op = node.op as CmpOp;
    if (node.left.kind === "null" || node.right.kind === "null") {
      const other = node.left.kind === "null" ? node.right : node.left;
      this.expr(other, undefined, true);
      return this.error(
        "E209",
        `${op === "==" ? "=" : op} null is always unknown, never true`,
        node.span,
        `write ${this.text(other)} is ${op === "!=" ? "not null" : "null"}`,
      );
    }
    const [l, r] = this.operands(node.left, node.right);
    const type = T.boolean(l.type.nullable || r.type.nullable);
    const ir: Expr = { op: "cmp", type, cmp: op, left: l.ir, right: r.ir };
    if (isAny(l.type) || isAny(r.type)) return { type, ir };
    let problem: string | null = null;
    if (op === "==" || op === "!=") {
      if (isNumeric(l.type) && isNumeric(r.type)) {
        const u = numericUnify(l.type, r.type);
        if (typeof u === "string") problem = u;
      } else if (!sameType(l.type, r.type)) problem = "mismatch";
    } else {
      problem = orderable(l.type, r.type);
    }
    if (problem === null) return { type, ir };
    const isLit = (n: ExprNode): boolean => n.kind === "number" || n.kind === "string" || n.kind === "bool" || n.kind === "date";
    let message: string;
    if (problem.startsWith("enum values have no order")) message = `${this.text(node.left)} ${op} ${this.text(node.right)}: ${problem.split(";")[0]}`;
    else if (isLit(node.right)) message = `${this.text(node.left)} is ${show(l.type)}, not ${show(r.type)}`;
    else if (isLit(node.left)) message = `${this.text(node.right)} is ${show(r.type)}, not ${show(l.type)}`;
    else message = `${this.text(node.left)} is ${show(l.type)} but ${this.text(node.right)} is ${show(r.type)}`;
    this.report("error", "E201", message, node.span, this.mismatchHint(l.type, r.type, node.right));
    return { type: T.any(), ir };
  }

  private mismatchHint(a: Type, b: Type, literal?: ExprNode): string | undefined {
    const enumType = a.kind === "enum" ? a : b.kind === "enum" ? b : undefined;
    if (enumType !== undefined && enumType.kind === "enum") {
      const values = this.schema.enums[enumType.name]?.values ?? [];
      return `${enumType.name} values: ${values.map((v) => `"${v}"`).join(", ")}`;
    }
    if (literal?.kind === "string" && (a.kind === "number" || a.kind === "money") && /^-?\d+(\.\d+)?$/.test(literal.value)) {
      return `remove the quotes: ${literal.value}`;
    }
    if ((isNumeric(a) && b.kind === "string") || (a.kind === "string" && isNumeric(b))) {
      return "compare with a number without quotes, such as 30000";
    }
    if ((a.kind === "money" && b.kind === "number") || (a.kind === "number" && b.kind === "money")) {
      return "money combines only with money or a plain numeric literal such as 30000";
    }
    if (a.kind === "date" || b.kind === "date") return "write dates as @YYYY-MM-DD, or use age(), monthsSince() or daysBetween()";
    if (a.kind === "boolean" || b.kind === "boolean") return "use true or false without quotes";
    return undefined;
  }

  private coalesce(node: ExprNode & { kind: "binary" }): Checked {
    const left = this.expr(node.left, undefined, true);
    const right = this.expr(node.right, withNullable(left.type, false));
    if (!isAny(left.type) && !left.type.nullable) {
      this.report("warning", "W302", `${this.text(node.left)} is never null here, so ?? has no effect`, node.opSpan);
    }
    let base: Type;
    if (isNumeric(left.type) && isNumeric(right.type)) {
      const u = numericUnify(left.type, right.type);
      if (typeof u === "string") return this.error("E201", `the fallback after ?? does not match: ${u}`, node.right.span);
      base = u;
    } else if (left.type.kind === "null") {
      base = right.type;
    } else if (!sameType(left.type, right.type)) {
      return this.error(
        "E201",
        `the fallback after ?? is ${show(right.type)}, but ${this.text(node.left)} is ${show(left.type)}`,
        node.right.span,
      );
    } else {
      base = isAny(left.type) ? right.type : left.type;
    }
    const type = withNullable(base, right.type.nullable);
    return { type, ir: { op: "coalesce", type, left: left.ir, right: right.ir } };
  }

  private arith(node: ExprNode & { kind: "binary" }, op: ArithOp): Checked {
    const l = this.expr(node.left);
    const r = this.expr(node.right);
    const result = arithmeticType(op, l.type, r.type);
    if (typeof result === "string") {
      return this.error("E212", result, node.span, this.mismatchHint(l.type, r.type));
    }
    if (l.ir.op === "lit" && r.ir.op === "lit" && typeof l.ir.value === "number" && typeof r.ir.value === "number") {
      const folded = evalExpr(
        { op: "arith", type: result, arith: op, left: l.ir, right: r.ir },
        { input: {}, outputs: {}, outputRoot: this.schema.output, ctx: { today: "1970-01-01" } },
      );
      if (folded !== null) return { type: result, ir: lit(result, folded) };
    }
    return { type: result, ir: { op: "arith", type: result, arith: op, left: l.ir, right: r.ir } };
  }

  private between(node: ExprNode & { kind: "between" }): Checked {
    const arg = this.expr(node.arg);
    const low = this.expr(node.low, arg.type);
    const high = this.expr(node.high, arg.type);
    for (const [side, c] of [
      [node.low, low],
      [node.high, high],
    ] as const) {
      const problem = orderable(arg.type, c.type);
      if (problem !== null) {
        this.error("E216", `between bounds must match ${this.text(node.arg)}: ${problem}`, side.span, this.mismatchHint(arg.type, c.type));
      }
    }
    if (low.ir.op === "lit" && high.ir.op === "lit" && typeof low.ir.value === "number" && typeof high.ir.value === "number" && low.ir.value > high.ir.value) {
      this.report("warning", "W306", `between ${low.ir.value} and ${high.ir.value} is empty; the low bound comes first`, node.span);
    }
    const type = T.boolean(arg.type.nullable || low.type.nullable || high.type.nullable);
    const ir: Expr = { op: "between", type, arg: arg.ir, low: low.ir, high: high.ir };
    return node.negated ? { type, ir: { op: "not", type, arg: ir } } : { type, ir };
  }

  private inList(node: ExprNode & { kind: "in" }): Checked {
    const arg = this.expr(node.arg);
    const list = this.expr(node.list, T.listOf(withNullable(arg.type, false)));
    const type = T.boolean(arg.type.nullable || list.type.nullable);
    const ir: Expr = { op: "in", type, arg: arg.ir, list: list.ir };
    const wrap = (): Checked => (node.negated ? { type, ir: { op: "not", type, arg: ir } } : { type, ir });
    if (isAny(arg.type) || isAny(list.type)) return wrap();
    if (list.type.kind !== "list") {
      return this.error("E201", `in needs a list, but ${this.text(node.list)} is ${show(list.type)}`, node.list.span, 'write a list such as ["a", "b"]');
    }
    const element = list.type.element;
    const ok = isAny(element) || sameType(withNullable(arg.type, false), element) || (isNumeric(arg.type) && isNumeric(element) && typeof numericUnify(arg.type, element) !== "string");
    if (!ok) {
      this.report(
        "error",
        "E201",
        `${this.text(node.arg)} is ${show(arg.type)}, but the list holds ${show(element)}`,
        node.list.span,
        this.mismatchHint(arg.type, element),
      );
    }
    return wrap();
  }

  private isNull(node: ExprNode & { kind: "isNull" }): Checked {
    const arg = this.expr(node.arg, undefined, true);
    if (!isAny(arg.type) && !arg.type.nullable) {
      this.report(
        "warning",
        "W303",
        `${this.text(node.arg)} is never null here, so this test is always ${node.negated ? "true" : "false"}`,
        node.span,
      );
    }
    const type = T.boolean();
    const ir: Expr = { op: "isNull", type, arg: arg.ir };
    return node.negated ? { type, ir: { op: "not", type, arg: ir } } : { type, ir };
  }

  private call(node: ExprNode & { kind: "call" }): Checked {
    const fn = BUILTINS.get(node.name);
    if (fn === undefined) {
      node.args.forEach((a) => this.expr(a));
      const guess = closest(node.name, BUILTINS.keys());
      return this.error(
        "E204",
        `unknown function ${node.name}`,
        node.nameSpan,
        guess !== undefined ? `did you mean ${guess}()?` : `functions: ${[...BUILTINS.keys()].join(", ")}`,
      );
    }
    const args: Checked[] = [];
    node.args.forEach((a, i) => {
      args.push(this.expr(a, fn.expect?.(i, args.map((x) => x.type))));
    });
    if (args.length < fn.minArgs || args.length > fn.maxArgs) {
      const want = fn.minArgs === fn.maxArgs ? `${fn.minArgs}` : `${fn.minArgs} or ${fn.maxArgs}`;
      return this.error("E205", `${node.name} takes ${want} argument${fn.maxArgs === 1 ? "" : "s"}, but got ${args.length}`, node.span, `usage: ${fn.signature}`);
    }
    const result = fn.check(args.map((a) => a.type));
    if ("arg" in result) {
      return this.error("E206", `${node.name}: ${result.message}`, node.args[result.arg]!.span, `usage: ${fn.signature}`);
    }
    return { type: result, ir: { op: "call", type: result, fn: node.name, args: args.map((a) => a.ir) } };
  }
}
