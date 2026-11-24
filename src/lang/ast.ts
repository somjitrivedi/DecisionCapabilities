import type { Outcome } from "../ir/ir.ts";
import type { Span } from "./diagnostics.ts";

export type BinaryOp = "and" | "or" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "+" | "-" | "*" | "/" | "??";

export type ExprNode =
  | { kind: "number"; value: number; span: Span }
  | { kind: "string"; value: string; span: Span }
  | { kind: "bool"; value: boolean; span: Span }
  | { kind: "null"; span: Span }
  | { kind: "date"; value: string; span: Span }
  | { kind: "list"; items: ExprNode[]; span: Span }
  | { kind: "path"; parts: string[]; partSpans: Span[]; span: Span }
  | { kind: "unary"; op: "-" | "not"; arg: ExprNode; span: Span }
  | { kind: "binary"; op: BinaryOp; left: ExprNode; right: ExprNode; opSpan: Span; span: Span }
  | { kind: "between"; arg: ExprNode; low: ExprNode; high: ExprNode; negated: boolean; span: Span }
  | { kind: "in"; arg: ExprNode; list: ExprNode; negated: boolean; span: Span }
  | { kind: "isNull"; arg: ExprNode; negated: boolean; span: Span }
  | { kind: "call"; name: string; nameSpan: Span; args: ExprNode[]; span: Span };

export type ActionNode =
  | { kind: "outcome"; outcome: Outcome; reason: string | null; span: Span }
  | { kind: "reason"; code: string; span: Span }
  | { kind: "set"; target: ExprNode & { kind: "path" }; value: ExprNode; span: Span };

export interface ConstDecl {
  name: string;
  nameSpan: Span;
  value: ExprNode;
}

export interface RuleDecl {
  name: string;
  nameSpan: Span;
  priority: number;
  condition: ExprNode;
  then: ActionNode[];
  else: ActionNode[];
  span: Span;
}

export interface FileNode {
  name: string;
  nameSpan: Span;
  defaultOutcome: Outcome | null;
  consts: ConstDecl[];
  rules: RuleDecl[];
}
