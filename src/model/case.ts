import type { FieldType, Schema } from "./schema.ts";

export type Value = number | string | boolean | null | Value[];

export type Entity = Record<string, Value>;

export type Case = Record<string, Entity>;

export interface Applicant {
  id: string;
  age: number;
  dateOfBirth: string | null;
  income: number | null;
  dependents: number;
  residenceYears: number;
  housing: string;
  hasTelephone: boolean;
  documents: string[];
}

export interface LoanCase {
  applicant: Applicant;
  employment: { tenure: string; jobType: string };
  accounts: { checking: string; savings: string };
  bureau: {
    score: number | null;
    history: string;
    existingCredits: number;
    otherPlans: string;
    delinquencies: number | null;
  };
  loan: {
    amount: number;
    termMonths: number;
    purpose: string;
    installmentBurden: number;
    collateral: string;
    guarantor: string;
    applicationDate: string | null;
  };
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (m === null) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

function checkValue(schema: Schema, path: string, type: FieldType, value: unknown, problems: string[]): void {
  switch (type.kind) {
    case "number":
    case "money":
      if (typeof value !== "number" || !Number.isFinite(value)) problems.push(`${path}: expected ${type.kind}`);
      return;
    case "string":
      if (typeof value !== "string") problems.push(`${path}: expected string`);
      return;
    case "boolean":
      if (typeof value !== "boolean") problems.push(`${path}: expected boolean`);
      return;
    case "date":
      if (typeof value !== "string" || !isIsoDate(value)) problems.push(`${path}: expected date as YYYY-MM-DD`);
      return;
    case "enum": {
      const values = schema.enums[type.name]?.values ?? [];
      if (typeof value !== "string" || !values.includes(value)) {
        problems.push(`${path}: expected one of ${values.join(", ")}`);
      }
      return;
    }
    case "list":
      if (!Array.isArray(value)) {
        problems.push(`${path}: expected list`);
        return;
      }
      value.forEach((item, i) => checkValue(schema, `${path}[${i}]`, type.element, item, problems));
      return;
  }
}

export function validateCase(schema: Schema, input: unknown): string[] {
  const problems: string[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) return ["case: expected object"];
  const record = input as Record<string, unknown>;
  for (const [root, entityName] of Object.entries(schema.roots)) {
    if (root === schema.output) continue;
    const entity = schema.entities[entityName]!;
    const raw = record[root];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      problems.push(`${root}: expected object`);
      continue;
    }
    const obj = raw as Record<string, unknown>;
    for (const f of entity.fields) {
      const v = obj[f.name];
      if (v === undefined || v === null) {
        if (!f.nullable) problems.push(`${root}.${f.name}: required`);
        continue;
      }
      checkValue(schema, `${root}.${f.name}`, f.type, v, problems);
    }
    for (const key of Object.keys(obj)) {
      if (!entity.fields.some((f) => f.name === key)) problems.push(`${root}.${key}: not in schema`);
    }
  }
  for (const key of Object.keys(record)) {
    if (schema.roots[key] === undefined) problems.push(`${key}: not in schema`);
    else if (key === schema.output) problems.push(`${key}: is the decision output and cannot be supplied as input`);
  }
  return problems;
}
