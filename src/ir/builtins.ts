import type { Value } from "../model/case.ts";
import { epochDays, monthsBetween, yearsBetween } from "./dates.ts";
import { T, assignable, isNumeric, numericUnify, show, type Type } from "./types.ts";

export interface EvalContext {
  today: string;
}

export interface ArgProblem {
  arg: number;
  message: string;
}

export interface Builtin {
  name: string;
  signature: string;
  minArgs: number;
  maxArgs: number;
  expect?: (index: number, args: Type[]) => Type | undefined;
  check: (args: Type[]) => Type | ArgProblem;
  run: (args: Value[], ctx: EvalContext) => Value;
}

const anyNullable = (args: Type[]): boolean => args.some((a) => a.nullable);

function numericArg(args: Type[], index: number): ArgProblem | null {
  const a = args[index]!;
  return isNumeric(a) ? null : { arg: index, message: `expected a number or money, found ${show(a)}` };
}

function dateArg(args: Type[], index: number): ArgProblem | null {
  const a = args[index]!;
  return a.kind === "date" || a.kind === "any" ? null : { arg: index, message: `expected a date, found ${show(a)}` };
}

function minMax(name: "min" | "max"): Builtin {
  return {
    name,
    signature: `${name}(a, b)`,
    minArgs: 2,
    maxArgs: 2,
    check(args) {
      const bad = numericArg(args, 0) ?? numericArg(args, 1);
      if (bad !== null) return bad;
      const u = numericUnify(args[0]!, args[1]!);
      return typeof u === "string" ? { arg: 1, message: u } : u;
    },
    run(args) {
      const [a, b] = args as [number, number];
      return name === "min" ? Math.min(a, b) : Math.max(a, b);
    },
  };
}

const list: Builtin[] = [
  minMax("min"),
  minMax("max"),
  {
    name: "abs",
    signature: "abs(x)",
    minArgs: 1,
    maxArgs: 1,
    check(args) {
      return numericArg(args, 0) ?? { ...args[0]!, flexible: false } as Type;
    },
    run(args) {
      return Math.abs(args[0] as number);
    },
  },
  {
    name: "round",
    signature: "round(x) or round(x, digits)",
    minArgs: 1,
    maxArgs: 2,
    check(args) {
      const bad = numericArg(args, 0);
      if (bad !== null) return bad;
      if (args.length === 2 && args[1]!.kind !== "number" && args[1]!.kind !== "any") {
        return { arg: 1, message: `digits must be a number, found ${show(args[1]!)}` };
      }
      return { ...args[0]!, nullable: anyNullable(args), flexible: false } as Type;
    },
    run(args) {
      const x = args[0] as number;
      const digits = args.length === 2 ? (args[1] as number) : 0;
      const f = 10 ** digits;
      return Math.round(x * f) / f;
    },
  },
  {
    name: "count",
    signature: "count(list)",
    minArgs: 1,
    maxArgs: 1,
    check(args) {
      const a = args[0]!;
      if (a.kind !== "list" && a.kind !== "any") return { arg: 0, message: `expected a list, found ${show(a)}` };
      return T.number(a.nullable);
    },
    run(args) {
      return (args[0] as Value[]).length;
    },
  },
  {
    name: "contains",
    signature: "contains(list, value)",
    minArgs: 2,
    maxArgs: 2,
    expect(index, args) {
      const l = args[0];
      return index === 1 && l !== undefined && l.kind === "list" ? l.element : undefined;
    },
    check(args) {
      const [l, v] = args as [Type, Type];
      if (l.kind !== "list" && l.kind !== "any") return { arg: 0, message: `expected a list, found ${show(l)}` };
      if (l.kind === "list" && !assignable(l.element, { ...v, nullable: false })) {
        return { arg: 1, message: `list holds ${show(l.element)}, but this value is ${show(v)}` };
      }
      return T.boolean(anyNullable(args));
    },
    run(args) {
      return (args[0] as Value[]).includes(args[1]!);
    },
  },
  {
    name: "age",
    signature: "age(date)",
    minArgs: 1,
    maxArgs: 1,
    check(args) {
      return dateArg(args, 0) ?? T.number(anyNullable(args));
    },
    run(args, ctx) {
      return yearsBetween(args[0] as string, ctx.today);
    },
  },
  {
    name: "monthsSince",
    signature: "monthsSince(date)",
    minArgs: 1,
    maxArgs: 1,
    check(args) {
      return dateArg(args, 0) ?? T.number(anyNullable(args));
    },
    run(args, ctx) {
      return monthsBetween(args[0] as string, ctx.today);
    },
  },
  {
    name: "daysBetween",
    signature: "daysBetween(from, to)",
    minArgs: 2,
    maxArgs: 2,
    check(args) {
      return dateArg(args, 0) ?? dateArg(args, 1) ?? T.number(anyNullable(args));
    },
    run(args) {
      return epochDays(args[1] as string) - epochDays(args[0] as string);
    },
  },
  {
    name: "today",
    signature: "today()",
    minArgs: 0,
    maxArgs: 0,
    check() {
      return T.date();
    },
    run(_args, ctx) {
      return ctx.today;
    },
  },
];

export const BUILTINS: ReadonlyMap<string, Builtin> = new Map(list.map((b) => [b.name, b]));
