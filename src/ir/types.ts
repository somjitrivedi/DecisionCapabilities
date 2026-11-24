import type { FieldType } from "../model/schema.ts";

export type BaseKind = "number" | "money" | "string" | "boolean" | "date" | "null" | "any";

export type Type =
  | { kind: BaseKind; nullable: boolean; flexible?: boolean }
  | { kind: "enum"; name: string; nullable: boolean }
  | { kind: "list"; element: Type; nullable: boolean };

export const T = {
  number: (nullable = false): Type => ({ kind: "number", nullable }),
  flexNumber: (): Type => ({ kind: "number", nullable: false, flexible: true }),
  money: (nullable = false): Type => ({ kind: "money", nullable }),
  string: (nullable = false): Type => ({ kind: "string", nullable }),
  boolean: (nullable = false): Type => ({ kind: "boolean", nullable }),
  date: (nullable = false): Type => ({ kind: "date", nullable }),
  null: (): Type => ({ kind: "null", nullable: true }),
  any: (): Type => ({ kind: "any", nullable: false }),
  enumOf: (name: string, nullable = false): Type => ({ kind: "enum", name, nullable }),
  listOf: (element: Type, nullable = false): Type => ({ kind: "list", element, nullable }),
};

export function fromFieldType(type: FieldType, nullable: boolean): Type {
  switch (type.kind) {
    case "enum":
      return T.enumOf(type.name, nullable);
    case "list":
      return T.listOf(fromFieldType(type.element, false), nullable);
    default:
      return { kind: type.kind, nullable };
  }
}

export function withNullable(type: Type, nullable: boolean): Type {
  return { ...type, nullable };
}

export function show(type: Type): string {
  switch (type.kind) {
    case "enum":
      return type.name;
    case "list":
      return `list of ${show(type.element)}`;
    default:
      return type.kind;
  }
}

export function isAny(type: Type): boolean {
  return type.kind === "any";
}

export function isNumeric(type: Type): boolean {
  return type.kind === "number" || type.kind === "money" || type.kind === "any";
}

export function isFlexible(type: Type): boolean {
  return type.kind === "number" && type.flexible === true;
}

export function sameType(a: Type, b: Type): boolean {
  if (a.kind === "any" || b.kind === "any") return true;
  if (a.kind !== b.kind) return false;
  if (a.kind === "enum" && b.kind === "enum") return a.name === b.name;
  if (a.kind === "list" && b.kind === "list") return sameType(a.element, b.element);
  return true;
}

export function assignable(target: Type, source: Type): boolean {
  if (source.kind === "any" || target.kind === "any") return true;
  if (source.kind === "null") return target.nullable;
  if (target.kind === "money" && isFlexible(source)) return true;
  return sameType(target, source);
}

export type ArithOp = "+" | "-" | "*" | "/";

export function arithmeticType(op: ArithOp, a: Type, b: Type): Type | string {
  const nullable = a.nullable || b.nullable;
  if (isAny(a) || isAny(b)) return T.any();
  if (!isNumeric(a) || !isNumeric(b)) {
    const bad = isNumeric(a) ? b : a;
    return `arithmetic needs numbers or money, but this operand is ${show(bad)}`;
  }
  const am = a.kind === "money";
  const bm = b.kind === "money";
  if (!am && !bm) {
    const t: Type = { kind: "number", nullable };
    if (isFlexible(a) && isFlexible(b)) t.flexible = true;
    return t;
  }
  switch (op) {
    case "+":
    case "-":
      if (am && bm) return T.money(nullable);
      if ((am && isFlexible(b)) || (bm && isFlexible(a))) return T.money(nullable);
      return `cannot ${op === "+" ? "add" : "subtract"} money and number`;
    case "*":
      if (am && bm) return "cannot multiply money by money";
      return T.money(nullable);
    case "/":
      if (am && bm) return T.number(nullable);
      if (am) return T.money(nullable);
      return "cannot divide a number by money";
  }
}

export function numericUnify(a: Type, b: Type): Type | string {
  const nullable = a.nullable || b.nullable;
  if (isAny(a) || isAny(b)) return T.any();
  if (!isNumeric(a) || !isNumeric(b)) return `expected numbers or money, found ${show(isNumeric(a) ? b : a)}`;
  if (a.kind === "money" || b.kind === "money") {
    if (a.kind === b.kind) return T.money(nullable);
    const other = a.kind === "money" ? b : a;
    if (isFlexible(other)) return T.money(nullable);
    return "money cannot be mixed with a number";
  }
  const t: Type = { kind: "number", nullable };
  if (isFlexible(a) && isFlexible(b)) t.flexible = true;
  return t;
}

export function orderable(a: Type, b: Type): string | null {
  if (isAny(a) || isAny(b)) return null;
  if (isNumeric(a) && isNumeric(b)) {
    const u = numericUnify(a, b);
    return typeof u === "string" ? u : null;
  }
  if (a.kind === "date" && b.kind === "date") return null;
  if (a.kind === "string" && b.kind === "string") return null;
  if (a.kind === "enum" || b.kind === "enum") return "enum values have no order; compare with = or use in [...]";
  if (a.kind !== b.kind) return `${show(a)} cannot be compared with ${show(b)}`;
  return `${show(a)} values cannot be ordered`;
}
