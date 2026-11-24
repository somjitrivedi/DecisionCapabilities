import { field, t, type Schema } from "./schema.ts";

export const underwritingSchema: Schema = {
  name: "PersonalLoan",
  enums: {
    Housing: { name: "Housing", values: ["rent", "own", "free"] },
    EmploymentTenure: {
      name: "EmploymentTenure",
      values: ["unemployed", "under_1y", "1_to_4y", "4_to_7y", "7y_plus"],
    },
    JobType: { name: "JobType", values: ["unskilled_nonresident", "unskilled", "skilled", "highly_skilled"] },
    CheckingStatus: { name: "CheckingStatus", values: ["overdrawn", "low", "healthy", "none"] },
    SavingsBand: { name: "SavingsBand", values: ["very_low", "low", "medium", "high", "none"] },
    CreditHistory: {
      name: "CreditHistory",
      values: ["no_credits", "all_paid_this_bank", "existing_paid", "past_delays", "critical"],
    },
    OtherPlans: { name: "OtherPlans", values: ["bank", "stores", "none"] },
    LoanPurpose: {
      name: "LoanPurpose",
      values: [
        "car_new",
        "car_used",
        "furniture",
        "electronics",
        "appliances",
        "repairs",
        "education",
        "vacation",
        "retraining",
        "business",
        "other",
      ],
    },
    Collateral: { name: "Collateral", values: ["real_estate", "savings_insurance", "car_or_other", "none"] },
    Guarantor: { name: "Guarantor", values: ["none", "co_applicant", "guarantor"] },
    DocumentType: { name: "DocumentType", values: ["id_proof", "income_proof", "address_proof", "bank_statement"] },
    RiskGrade: { name: "RiskGrade", values: ["A", "B", "C", "D", "E"] },
  },
  entities: {
    Applicant: {
      name: "Applicant",
      writable: false,
      fields: [
        field("id", t.string, false, "Application identifier"),
        field("age", t.number, false, "Age in whole years at application"),
        field("dateOfBirth", t.date, true, "Date of birth when captured"),
        field("income", t.money, true, "Verified gross annual income"),
        field("dependents", t.number, false, "People financially dependent on the applicant"),
        field("residenceYears", t.number, false, "Years at current residence"),
        field("housing", t.enumOf("Housing"), false, "Housing situation"),
        field("hasTelephone", t.boolean, false, "Registered telephone on file"),
        field("documents", t.listOf(t.enumOf("DocumentType")), false, "Documents received"),
      ],
    },
    Employment: {
      name: "Employment",
      writable: false,
      fields: [
        field("tenure", t.enumOf("EmploymentTenure"), false, "Time with current employer"),
        field("jobType", t.enumOf("JobType"), false, "Skill level of current job"),
      ],
    },
    Accounts: {
      name: "Accounts",
      writable: false,
      fields: [
        field("checking", t.enumOf("CheckingStatus"), false, "Checking account balance band"),
        field("savings", t.enumOf("SavingsBand"), false, "Savings balance band"),
      ],
    },
    Bureau: {
      name: "Bureau",
      writable: false,
      fields: [
        field("score", t.number, true, "Bureau score when pulled"),
        field("history", t.enumOf("CreditHistory"), false, "Repayment history"),
        field("existingCredits", t.number, false, "Open credits at this bank"),
        field("otherPlans", t.enumOf("OtherPlans"), false, "Other installment plans"),
        field("delinquencies", t.number, true, "Delinquent accounts in last 24 months"),
      ],
    },
    Loan: {
      name: "Loan",
      writable: false,
      fields: [
        field("amount", t.money, false, "Requested principal"),
        field("termMonths", t.number, false, "Requested term in months"),
        field("purpose", t.enumOf("LoanPurpose"), false, "Purpose of the loan"),
        field("installmentBurden", t.number, false, "Installment as share of disposable income, band 1 to 4"),
        field("collateral", t.enumOf("Collateral"), false, "Most valuable pledged property"),
        field("guarantor", t.enumOf("Guarantor"), false, "Other party liable for the loan"),
        field("applicationDate", t.date, true, "Date the application was submitted"),
      ],
    },
    Decision: {
      name: "Decision",
      writable: true,
      fields: [
        field("riskGrade", t.enumOf("RiskGrade"), true, "Assigned risk grade"),
        field("apr", t.number, true, "Offered annual percentage rate"),
        field("maxAmount", t.money, true, "Maximum approved principal"),
        field("maxTermMonths", t.number, true, "Maximum approved term"),
        field("manualReview", t.boolean, true, "Flag for a second-line review"),
      ],
    },
  },
  roots: {
    applicant: "Applicant",
    employment: "Employment",
    accounts: "Accounts",
    bureau: "Bureau",
    loan: "Loan",
    decision: "Decision",
  },
  output: "decision",
};
