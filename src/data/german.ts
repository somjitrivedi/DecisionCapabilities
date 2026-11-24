import { readFileSync } from "node:fs";
import type { LoanCase } from "../model/case.ts";

export type Label = "good" | "bad";

export interface DatasetRow {
  extId: string;
  case: LoanCase;
  label: Label | null;
}

const CODES: Record<string, Record<string, string>> = {
  checking: { A11: "overdrawn", A12: "low", A13: "healthy", A14: "none" },
  history: { A30: "no_credits", A31: "all_paid_this_bank", A32: "existing_paid", A33: "past_delays", A34: "critical" },
  purpose: {
    A40: "car_new",
    A41: "car_used",
    A42: "furniture",
    A43: "electronics",
    A44: "appliances",
    A45: "repairs",
    A46: "education",
    A47: "vacation",
    A48: "retraining",
    A49: "business",
    A410: "other",
  },
  savings: { A61: "very_low", A62: "low", A63: "medium", A64: "high", A65: "none" },
  tenure: { A71: "unemployed", A72: "under_1y", A73: "1_to_4y", A74: "4_to_7y", A75: "7y_plus" },
  guarantor: { A101: "none", A102: "co_applicant", A103: "guarantor" },
  collateral: { A121: "real_estate", A122: "savings_insurance", A123: "car_or_other", A124: "none" },
  otherPlans: { A141: "bank", A142: "stores", A143: "none" },
  housing: { A151: "rent", A152: "own", A153: "free" },
  jobType: { A171: "unskilled_nonresident", A172: "unskilled", A173: "skilled", A174: "highly_skilled" },
  telephone: { A191: "no", A192: "yes" },
};

export const GERMAN_DEFAULT_PATH = "data/german/german.data";

function code(table: keyof typeof CODES, raw: string, line: number): string {
  const v = CODES[table]![raw];
  if (v === undefined) throw new Error(`german.data line ${line}: unknown ${table} code ${raw}`);
  return v;
}

function int(raw: string, line: number, what: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`german.data line ${line}: ${what} is not a whole number: ${raw}`);
  return n;
}

export function parseGerman(text: string): DatasetRow[] {
  const rows: DatasetRow[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const line = index + 1;
    const trimmed = rawLine.trim();
    if (trimmed === "") return;
    const f = trimmed.split(/\s+/);
    if (f.length !== 21) throw new Error(`german.data line ${line}: expected 21 fields, found ${f.length}`);
    const extId = `G${String(rows.length + 1).padStart(4, "0")}`;
    const labelCode = int(f[20]!, line, "label");
    if (labelCode !== 1 && labelCode !== 2) throw new Error(`german.data line ${line}: label must be 1 or 2`);
    rows.push({
      extId,
      label: labelCode === 1 ? "good" : "bad",
      case: {
        applicant: {
          id: extId,
          age: int(f[12]!, line, "age"),
          dateOfBirth: null,
          income: null,
          dependents: int(f[17]!, line, "people liable"),
          residenceYears: int(f[10]!, line, "residence"),
          housing: code("housing", f[14]!, line),
          hasTelephone: code("telephone", f[18]!, line) === "yes",
          documents: [],
        },
        employment: { tenure: code("tenure", f[6]!, line), jobType: code("jobType", f[16]!, line) },
        accounts: { checking: code("checking", f[0]!, line), savings: code("savings", f[5]!, line) },
        bureau: {
          score: null,
          history: code("history", f[2]!, line),
          existingCredits: int(f[15]!, line, "existing credits"),
          otherPlans: code("otherPlans", f[13]!, line),
          delinquencies: null,
        },
        loan: {
          amount: int(f[4]!, line, "amount"),
          termMonths: int(f[1]!, line, "duration"),
          purpose: code("purpose", f[3]!, line),
          installmentBurden: int(f[7]!, line, "installment rate"),
          collateral: code("collateral", f[11]!, line),
          guarantor: code("guarantor", f[9]!, line),
          applicationDate: null,
        },
      },
    });
  });
  return rows;
}

export function loadGermanFile(path = GERMAN_DEFAULT_PATH): DatasetRow[] {
  return parseGerman(readFileSync(path, "utf8"));
}
