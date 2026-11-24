import type { Outcome } from "../ir/ir.ts";
import type { ActionNode, BinaryOp, ConstDecl, ExprNode, FileNode, RuleDecl } from "./ast.ts";
import type { Diagnostic, Span } from "./diagnostics.ts";
import { lex, type Token } from "./lexer.ts";

class ParseError extends Error {
  readonly diagnostic: Diagnostic;

  constructor(diagnostic: Diagnostic) {
    super(diagnostic.message);
    this.diagnostic = diagnostic;
  }
}

const CMP_OPS = new Set(["==", "!=", "<", "<=", ">", ">="]);
const OUTCOME_WORDS = new Set(["approve", "decline", "refer"]);
const NAME_FOLLOWERS = new Set(["priority", "if", "default", "const", "rule"]);

export interface ParseResult {
  file: FileNode | null;
  diagnostics: Diagnostic[];
}

function describe(tok: Token): string {
  if (tok.kind === "eof") return "end of file";
  if (tok.kind === "string") return `string ${tok.text}`;
  return tok.kind === "keyword" ? `keyword ${tok.text}` : `${tok.text}`;
}

function join(a: Span, b: Span): Span {
  return { start: a.start, end: b.end };
}

class Parser {
  private pos = 0;
  readonly diagnostics: Diagnostic[] = [];

  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]!;
  }

  private next(): Token {
    const tok = this.peek();
    if (tok.kind !== "eof") this.pos++;
    return tok;
  }

  private prev(): Token {
    return this.tokens[Math.max(0, this.pos - 1)]!;
  }

  private isKeyword(word: string, offset = 0): boolean {
    const tok = this.peek(offset);
    return tok.kind === "keyword" && tok.value === word;
  }

  private isOp(op: string, offset = 0): boolean {
    const tok = this.peek(offset);
    return tok.kind === "op" && tok.value === op;
  }

  private fail(message: string, span: Span, hint?: string, code = "E101"): never {
    const d: Diagnostic = { severity: "error", code, message, span };
    if (hint !== undefined) d.hint = hint;
    throw new ParseError(d);
  }

  private expectKeyword(word: string, hint?: string): Token {
    if (this.isKeyword(word)) return this.next();
    const tok = this.peek();
    return this.fail(`expected ${word}, found ${describe(tok)}`, tok.span, hint);
  }

  private expectOp(op: string, hint?: string): Token {
    if (this.isOp(op)) return this.next();
    const tok = this.peek();
    const shown = op === "==" ? "=" : op;
    return this.fail(`expected ${shown}, found ${describe(tok)}`, tok.span, hint);
  }

  private expectName(what: string): Token {
    const tok = this.peek();
    if (tok.kind === "ident" || tok.kind === "string") return this.next();
    const after = this.peek(1);
    const nameEnds =
      after.kind === "eof" ||
      (after.kind === "op" && after.value === ":") ||
      (after.kind === "keyword" && NAME_FOLLOWERS.has(String(after.value)));
    if (tok.kind === "keyword" && nameEnds) {
      this.next();
      return { ...tok, kind: "ident", value: tok.text };
    }
    if (tok.kind === "keyword") {
      return this.fail(`${tok.text} is a reserved word and cannot be used as ${what}`, tok.span, `quote it, as in "${tok.text}"`);
    }
    return this.fail(`expected ${what}, found ${describe(tok)}`, tok.span);
  }

  private synchronize(): void {
    while (this.peek().kind !== "eof" && !this.isKeyword("rule") && !this.isKeyword("const")) this.next();
  }

  parseFile(): FileNode | null {
    let header: { name: string; span: Span };
    try {
      this.expectKeyword("ruleset", "every rules file starts with: ruleset <Name>");
      const tok = this.expectName("a ruleset name");
      header = { name: String(tok.value), span: tok.span };
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      this.diagnostics.push(e.diagnostic);
      return null;
    }
    let defaultOutcome: Outcome | null = null;
    const consts: ConstDecl[] = [];
    const rules: RuleDecl[] = [];
    if (this.isKeyword("default")) {
      this.next();
      const tok = this.peek();
      if (tok.kind === "keyword" && OUTCOME_WORDS.has(String(tok.value))) {
        this.next();
        defaultOutcome = tok.value as Outcome;
      } else {
        this.diagnostics.push({
          severity: "error",
          code: "E101",
          message: `expected approve, decline or refer after default, found ${describe(tok)}`,
          span: tok.span,
        });
      }
    }
    while (this.peek().kind !== "eof") {
      const startPos = this.pos;
      try {
        if (this.isKeyword("const")) consts.push(this.parseConst());
        else if (this.isKeyword("rule")) rules.push(this.parseRule());
        else {
          const tok = this.peek();
          this.fail(`expected rule or const, found ${describe(tok)}`, tok.span, "each rule starts with: rule <Name>: if ...");
        }
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        this.diagnostics.push(e.diagnostic);
        if (this.pos === startPos) this.next();
        this.synchronize();
      }
    }
    return { name: header.name, nameSpan: header.span, defaultOutcome, consts, rules };
  }

  private parseConst(): ConstDecl {
    this.expectKeyword("const");
    const nameTok = this.peek();
    if (nameTok.kind !== "ident") this.fail(`expected a constant name, found ${describe(nameTok)}`, nameTok.span);
    this.next();
    this.expectOp("==", `write: const ${String(nameTok.value)} = <value>`);
    const value = this.parseExpr();
    return { name: String(nameTok.value), nameSpan: nameTok.span, value };
  }

  private parseRule(): RuleDecl {
    const start = this.expectKeyword("rule");
    const nameTok = this.expectName("a rule name");
    let priority = 0;
    if (this.isKeyword("priority")) {
      this.next();
      const negative = this.isOp("-");
      if (negative) this.next();
      const tok = this.peek();
      if (tok.kind !== "number" || !Number.isInteger(tok.value)) {
        this.fail(`expected a whole number after priority, found ${describe(tok)}`, tok.span);
      }
      this.next();
      priority = negative ? -(tok.value as number) : (tok.value as number);
    }
    if (this.isOp(":")) this.next();
    this.expectKeyword("if", `write: rule ${String(nameTok.value)}: if <condition> then <action>`);
    const condition = this.parseExpr();
    if (!this.isKeyword("then")) {
      const tok = this.peek();
      this.fail(`expected then after the condition, found ${describe(tok)}`, tok.span, "write: if <condition> then <action>");
    }
    this.next();
    const thenActions = this.parseActions();
    let elseActions: ActionNode[] = [];
    if (this.isKeyword("else")) {
      this.next();
      elseActions = this.parseActions();
    }
    const tail = this.peek();
    if (tail.kind !== "eof" && !this.isKeyword("rule") && !this.isKeyword("const")) {
      this.fail(
        `unexpected ${describe(tail)} after the actions of rule ${String(nameTok.value)}`,
        tail.span,
        "separate actions with commas, or start a new rule with: rule <Name>:",
      );
    }
    return {
      name: String(nameTok.value),
      nameSpan: nameTok.span,
      priority,
      condition,
      then: thenActions,
      else: elseActions,
      span: join(start.span, this.prev().span),
    };
  }

  private parseActions(): ActionNode[] {
    const actions = [this.parseAction()];
    while (this.isOp(",")) {
      this.next();
      actions.push(this.parseAction());
    }
    return actions;
  }

  private parseAction(): ActionNode {
    const tok = this.peek();
    if (tok.kind === "keyword" && OUTCOME_WORDS.has(String(tok.value))) {
      this.next();
      let reason: string | null = null;
      if (this.isKeyword("reason")) {
        this.next();
        reason = this.expectReasonCode();
      }
      return { kind: "outcome", outcome: tok.value as Outcome, reason, span: join(tok.span, this.prev().span) };
    }
    if (this.isKeyword("reason")) {
      this.next();
      const code = this.expectReasonCode();
      return { kind: "reason", code, span: join(tok.span, this.prev().span) };
    }
    if (this.isKeyword("set")) {
      this.next();
      const target = this.parsePrimary();
      if (target.kind !== "path") this.fail("set needs a field to assign, such as decision.apr", target.span);
      this.expectOp("==", "write: set decision.<field> = <value>");
      const value = this.parseExpr();
      return { kind: "set", target, value, span: join(tok.span, value.span) };
    }
    return this.fail(
      `expected an action, found ${describe(tok)}`,
      tok.span,
      "actions are approve, decline, refer (each with an optional reason), reason \"CODE\", or set decision.<field> = <value>",
    );
  }

  private expectReasonCode(): string {
    const tok = this.peek();
    if (tok.kind !== "string") {
      this.fail(`expected a reason code in quotes, found ${describe(tok)}`, tok.span, 'write: reason "LOW_INCOME"');
    }
    this.next();
    return String(tok.value);
  }

  parseExpr(): ExprNode {
    return this.parseOr();
  }

  current(): Token {
    return this.peek();
  }

  private parseOr(): ExprNode {
    let left = this.parseAnd();
    while (this.isKeyword("or")) {
      const op = this.next();
      const right = this.parseAnd();
      left = { kind: "binary", op: "or", left, right, opSpan: op.span, span: join(left.span, right.span) };
    }
    return left;
  }

  private parseAnd(): ExprNode {
    let left = this.parseNot();
    while (this.isKeyword("and")) {
      const op = this.next();
      const right = this.parseNot();
      left = { kind: "binary", op: "and", left, right, opSpan: op.span, span: join(left.span, right.span) };
    }
    return left;
  }

  private parseNot(): ExprNode {
    if (this.isKeyword("not")) {
      const tok = this.next();
      const arg = this.parseNot();
      return { kind: "unary", op: "not", arg, span: join(tok.span, arg.span) };
    }
    return this.parsePredicate();
  }

  private parsePredicate(): ExprNode {
    const left = this.parseCoalesce();
    const result = this.parsePredicateTail(left);
    const tok = this.peek();
    if (result !== left && tok.kind === "op" && CMP_OPS.has(String(tok.value))) {
      this.fail("comparisons cannot be chained", tok.span, "join separate comparisons with and, or use between");
    }
    return result;
  }

  private parsePredicateTail(left: ExprNode): ExprNode {
    const tok = this.peek();
    if (tok.kind === "op" && CMP_OPS.has(String(tok.value))) {
      this.next();
      const right = this.parseCoalesce();
      return { kind: "binary", op: tok.value as BinaryOp, left, right, opSpan: tok.span, span: join(left.span, right.span) };
    }
    let negated = false;
    if (this.isKeyword("not") && (this.isKeyword("in", 1) || this.isKeyword("between", 1))) {
      this.next();
      negated = true;
    }
    if (this.isKeyword("between")) {
      this.next();
      const low = this.parseCoalesce();
      this.expectKeyword("and", "write: x between <low> and <high>");
      const high = this.parseCoalesce();
      return { kind: "between", arg: left, low, high, negated, span: join(left.span, high.span) };
    }
    if (this.isKeyword("in")) {
      this.next();
      const list = this.parseCoalesce();
      return { kind: "in", arg: left, list, negated, span: join(left.span, list.span) };
    }
    if (this.isKeyword("is")) {
      this.next();
      let isNot = false;
      if (this.isKeyword("not")) {
        this.next();
        isNot = true;
      }
      const nullTok = this.expectKeyword("null", "is is only used as: x is null, or x is not null");
      return { kind: "isNull", arg: left, negated: isNot, span: join(left.span, nullTok.span) };
    }
    return left;
  }

  private parseCoalesce(): ExprNode {
    let left = this.parseAdditive();
    while (this.isOp("??")) {
      const op = this.next();
      const right = this.parseAdditive();
      left = { kind: "binary", op: "??", left, right, opSpan: op.span, span: join(left.span, right.span) };
    }
    return left;
  }

  private parseAdditive(): ExprNode {
    let left = this.parseMultiplicative();
    while (this.isOp("+") || this.isOp("-")) {
      const op = this.next();
      const right = this.parseMultiplicative();
      left = { kind: "binary", op: op.value as BinaryOp, left, right, opSpan: op.span, span: join(left.span, right.span) };
    }
    return left;
  }

  private parseMultiplicative(): ExprNode {
    let left = this.parseUnary();
    while (this.isOp("*") || this.isOp("/")) {
      const op = this.next();
      const right = this.parseUnary();
      left = { kind: "binary", op: op.value as BinaryOp, left, right, opSpan: op.span, span: join(left.span, right.span) };
    }
    return left;
  }

  private parseUnary(): ExprNode {
    if (this.isOp("-")) {
      const tok = this.next();
      const arg = this.parseUnary();
      return { kind: "unary", op: "-", arg, span: join(tok.span, arg.span) };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): ExprNode {
    const tok = this.peek();
    switch (tok.kind) {
      case "number":
        this.next();
        return { kind: "number", value: tok.value as number, span: tok.span };
      case "string":
        this.next();
        return { kind: "string", value: String(tok.value), span: tok.span };
      case "date":
        this.next();
        return { kind: "date", value: String(tok.value), span: tok.span };
      case "keyword":
        if (tok.value === "true" || tok.value === "false") {
          this.next();
          return { kind: "bool", value: tok.value === "true", span: tok.span };
        }
        if (tok.value === "null") {
          this.next();
          return { kind: "null", span: tok.span };
        }
        return this.fail(`expected a value, found ${describe(tok)}`, tok.span, this.keywordHint(String(tok.value)));
      case "ident":
        return this.parseNameOrCall();
      case "op":
        if (tok.value === "(") {
          this.next();
          const inner = this.parseExpr();
          const close = this.expectOp(")", "every ( needs a matching )");
          return { ...inner, span: join(tok.span, close.span) };
        }
        if (tok.value === "[") return this.parseList();
        return this.fail(`expected a value, found ${describe(tok)}`, tok.span);
      default:
        return this.fail(`expected a value, found ${describe(tok)}`, tok.span, "the condition or action is incomplete");
    }
  }

  private keywordHint(word: string): string | undefined {
    if (word === "then") return "the condition before then is empty or incomplete";
    if (word === "and" || word === "or") return `${word} needs a condition on both sides`;
    return undefined;
  }

  private parseList(): ExprNode {
    const open = this.next();
    const items: ExprNode[] = [];
    if (!this.isOp("]")) {
      items.push(this.parseExpr());
      while (this.isOp(",")) {
        this.next();
        items.push(this.parseExpr());
      }
    }
    const close = this.expectOp("]", "lists look like [\"a\", \"b\"]");
    return { kind: "list", items, span: join(open.span, close.span) };
  }

  private parseNameOrCall(): ExprNode {
    const first = this.next();
    if (this.isOp("(")) {
      this.next();
      const args: ExprNode[] = [];
      if (!this.isOp(")")) {
        args.push(this.parseExpr());
        while (this.isOp(",")) {
          this.next();
          args.push(this.parseExpr());
        }
      }
      const close = this.expectOp(")", "separate arguments with commas and close the call with )");
      return { kind: "call", name: String(first.value), nameSpan: first.span, args, span: join(first.span, close.span) };
    }
    const parts = [String(first.value)];
    const partSpans = [first.span];
    while (this.isOp(".")) {
      this.next();
      const tok = this.peek();
      if (tok.kind !== "ident") this.fail(`expected a field name after ., found ${describe(tok)}`, tok.span);
      this.next();
      parts.push(String(tok.value));
      partSpans.push(tok.span);
    }
    return { kind: "path", parts, partSpans, span: join(first.span, partSpans[partSpans.length - 1]!) };
  }
}

export function parse(text: string): ParseResult {
  const { tokens, diagnostics } = lex(text);
  const parser = new Parser(tokens);
  const file = parser.parseFile();
  return { file, diagnostics: [...diagnostics, ...parser.diagnostics] };
}

export function parseExpression(text: string): { expr: ExprNode | null; diagnostics: Diagnostic[] } {
  const { tokens, diagnostics } = lex(text);
  const parser = new Parser(tokens);
  try {
    const expr = parser.parseExpr();
    const rest = parser.current();
    if (rest.kind !== "eof") {
      diagnostics.push({ severity: "error", code: "E101", message: `unexpected ${describe(rest)}`, span: rest.span });
    }
    return { expr, diagnostics };
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    return { expr: null, diagnostics: [...diagnostics, e.diagnostic] };
  }
}
