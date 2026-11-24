# DecisionCapabilties

A decision rules engine for personal-loan underwriting. Business users write readable rules and the engine type-checks them against a typed object model, compiles them to an intermediate representation (IR) and evaluates loan applications. Each decision comes back with an outcome, reason codes, computed outputs and a per-rule trace.

TypeScript run directly by Node 24 (type stripping), with storage in the built-in `node:sqlite`. There are no native dependencies.

## Quick start

```sh
npm install
npm run typecheck
npm test
npm run load:german
npm run check:rules
npm run run:german
node src/cli.ts eval rules/personal-loan.rules examples/applicant.json --trace
```

| Command | What it does |
|---|---|
| `dc load german [--file]` | Loads German Credit into the SQLite store (`decisioncapabilties.db`) |
| `dc check <file.rules>` | Parses and type-checks a ruleset; exits 1 on errors |
| `dc ir <file.rules>` | Prints the compiled IR as JSON |
| `dc eval <file.rules> <case.json>` | Decides one application |
| `dc run <file.rules> --dataset german` | Decides every stored application, saves the run and prints outcome share and bad rate |

All commands accept `--db <path>` and `--today YYYY-MM-DD`.

## Layout

```
src/model      object model: schema descriptor, underwriting schema, case validation
src/ir         IR types, type algebra, built-in functions, reference interpreter
src/lang       lexer, parser, AST, type checker (lowers to IR), diagnostics
src/data       German Credit loader
src/store      SQLite store: datasets, applications, rulesets, runs, decisions
src/cli.ts     command line
rules          personal-loan.rules (51 rules)
examples       sample application
data/german    UCI Statlog German Credit
test           node:test suites
```

## Object model

Each case has five input roots and one writable output root:

| Root | Fields |
|---|---|
| `applicant` | id, age, dateOfBirth?, income? (money), dependents, residenceYears, housing, hasTelephone, documents (list of DocumentType) |
| `employment` | tenure, jobType |
| `accounts` | checking, savings |
| `bureau` | score?, history, existingCredits, otherPlans, delinquencies? |
| `loan` | amount (money), termMonths, purpose, installmentBurden, collateral, guarantor, applicationDate? |
| `decision` (output) | riskGrade?, apr?, maxAmount? (money), maxTermMonths?, manualReview? |

`?` marks a field that can be null. Enum fields accept only their declared values. Dates are `YYYY-MM-DD` strings.

## Rule language

```
ruleset PersonalLoanUnderwriting
default approve

const MIN_ANNUAL_INCOME = 30_000

rule LowIncome priority 100:
  if applicant.income is not null and applicant.income < MIN_ANNUAL_INCOME
  then decline reason "LOW_INCOME"

rule TermCap priority 15:
  if decision.riskGrade in ["D", "E"]
  then set decision.maxTermMonths = 36
  else set decision.maxTermMonths = 60
```

### Grammar

```
file      = "ruleset" name [ "default" outcome ] { const | rule }
const     = "const" ident "=" expr
rule      = "rule" name [ "priority" int ] [ ":" ] "if" expr "then" actions [ "else" actions ]
actions   = action { "," action }
action    = outcome [ "reason" string ] | "reason" string | "set" path "=" expr
outcome   = "approve" | "refer" | "decline"
expr      = or
or        = and { "or" and }
and       = not { "and" not }
not       = "not" not | predicate
predicate = coalesce [ cmp coalesce | ["not"] "between" coalesce "and" coalesce
                     | ["not"] "in" coalesce | "is" ["not"] "null" ]
coalesce  = additive { "??" additive }
additive  = term { ("+" | "-") term }
term      = unary { ("*" | "/") unary }
unary     = "-" unary | primary
primary   = number | string | @YYYY-MM-DD | true | false | null | "[" exprs "]"
          | "(" expr ")" | ident "(" exprs ")" | ident { "." ident }
cmp       = "=" | "==" | "!=" | "<>" | "<" | "<=" | ">" | ">="
```

Keywords are case-insensitive, and identifiers are case-sensitive. A keyword can still name a rule when a `:`, `priority` or `if` follows it. Numbers accept digit-group underscores (`30_000`). Comparisons cannot be chained.

### Types

| Type | Notes |
|---|---|
| number | plain quantity |
| money | combines with money; a bare numeric literal or constant adapts to money; money ÷ money gives number; money × money and money + number are errors |
| string, boolean, date | dates order chronologically |
| enum | compared with `=`/`in` against quoted values, which are checked against the enum; enums have no order |
| list | homogeneous; used with `in`, `contains`, `count` |

### Nulls

Logic is three-valued (true, false, unknown). Comparing or doing arithmetic with null gives unknown. `and`/`or` follow Kleene logic. A rule's `then` runs only when its condition is true, its `else` only when false, and neither when unknown. The checker warns (W301) when a nullable input is tested unguarded. `x is not null and ...` and `x is null or ...` narrow `x` for the rest of the expression and for the rule's actions. `x ?? fallback` supplies a default. Division by zero gives unknown.

### Functions

`min(a, b)`, `max(a, b)`, `abs(x)`, `round(x[, digits])`, `count(list)`, `contains(list, value)`, `age(date)`, `monthsSince(date)`, `daysBetween(from, to)`, `today()`. Each returns null if any argument is null. `today()` is the evaluation date.

### Diagnostics

Every message carries a file, line and column, an underline, and usually a hint:

```
rules.rules:4:6: error E201: applicant.income is money, not string
   |
 4 |   if applicant.income = "high" then decline
   |      ^^^^^^^^^^^^^^^^^^^^^^^^^
   = hint: compare with a number without quotes, such as 30000
```

| Code | Meaning |
|---|---|
| E001–E004 | lexical: bad character (`&&`, `!`, `'`, `;` get hints), unterminated string, bad date, malformed number |
| E101, E102 | syntax error; duplicate rule name |
| E201 | incompatible comparison or list membership |
| E202, E203, E214 | unknown field, entity or name, with "did you mean" |
| E204–E206 | unknown function, wrong arity, wrong argument type |
| E207 | condition is not a true/false test |
| E208 | value not in the enum, with "did you mean" |
| E209 | `= null` used instead of `is null` |
| E210, E211 | `set` on an input, or with a mismatched type |
| E212 | arithmetic type error |
| E213, E217 | duplicate or clashing constant; constant not computable at compile time |
| E215, E216 | mixed or null list items; bad `between` bounds |
| W301–W306 | unguarded nullable, useless `??`, useless null test, reason not UPPER_SNAKE_CASE, several outcomes in one branch, empty `between` |

## IR (version 1)

The checker lowers the source to a JSON-serialisable `RuleSet`.

```
RuleSet  { irVersion, name, schema, defaultOutcome, rules: Rule[] }
Rule     { id, priority, order, line, condition: Expr, then: Action[], else: Action[] }
Action   = { kind: "outcome", outcome, reason | null }
         | { kind: "reason", code }
         | { kind: "set", field, value: Expr }
Expr     = lit | field{root, field} | list | not | and/or{args} | cmp | arith | neg
         | between | in | isNull | coalesce | call{fn, args}
```

Every `Expr` node carries its resolved `type` (`kind`, `nullable`, enum `name` or list `element`). Constants and literal arithmetic are folded, `not in` and `not between` become `not` over the positive form, and nested `and`/`or` are flattened.

### Execution (sequential mode)

1. Rules run in descending `priority`, then source order.
2. `set` writes to `decision`, and later rules can read what earlier ones wrote.
3. The final outcome is the most severe fired outcome (decline > refer > approve), or the ruleset default if none fired (`refer` when no default is given).
4. `reasons` keeps reason codes attached to the final outcome plus standalone `reason` actions. Reasons attached to an outcome that was overridden are dropped from `reasons` but remain visible through `fired` and the trace.

The result is `{ ruleset, outcome, reasons[{code, rule, outcome}], outputs, fired[], trace[{rule, result, branch}] }`.

## Baseline on German Credit

With `--today 2026-11-24`, all 1,000 applications:

| Outcome | Count | Bad rate |
|---|---|---|
| approve | 526 | 19.0% |
| refer | 120 | 37.5% |
| decline | 354 | 43.8% |

The dataset's base bad rate is 30%. The reference interpreter decides about 58,000 applications per second on one core.

## Data

`data/german/german.data` is the Statlog (German Credit Data) dataset by Hans Hofmann, from the UCI Machine Learning Repository, licensed CC BY 4.0 (doi:10.24432/C5NC77). The loader maps its coded attributes onto the object model. It drops the personal-status/sex and foreign-worker attributes. Income, bureau score, delinquencies, dates and documents are absent from the dataset and load as null or empty.
