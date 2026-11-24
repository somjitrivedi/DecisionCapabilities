import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { GERMAN_DEFAULT_PATH, loadGermanFile } from "./data/german.ts";
import { evaluate } from "./ir/interpreter.ts";
import { OUTCOMES, type DecisionResult, type RuleSet } from "./ir/ir.ts";
import { todayIso } from "./ir/dates.ts";
import { compile, formatAll } from "./lang/compile.ts";
import { validateCase, type Case } from "./model/case.ts";
import { underwritingSchema } from "./model/underwriting.ts";
import { Store } from "./store/store.ts";

const USAGE = `usage: dc <command> [options]

commands:
  load german [--file <path>]           load the German Credit dataset into the store
  check <file.rules>                    parse and type-check a ruleset
  ir <file.rules>                       print the compiled IR as JSON
  eval <file.rules> <case.json>         decide one case and print the result
  run <file.rules> --dataset <name>     decide every application in a dataset and summarise

options:
  --db <path>       SQLite store (default decisioncapabilities.db)
  --today <date>    evaluation date as YYYY-MM-DD (default today)
  --trace           include the per-rule trace in eval output`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function compileFile(path: string, printWarnings: boolean): { ruleset: RuleSet; source: string; hash: string } {
  const source = readFileSync(path, "utf8");
  const result = compile(source, underwritingSchema);
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  const shown = printWarnings ? result.diagnostics : errors;
  if (shown.length > 0) process.stderr.write(`${formatAll(shown, source, path)}\n\n`);
  if (result.ruleset === null) {
    process.stderr.write(`${errors.length} error(s); ${path} was not compiled\n`);
    process.exit(1);
  }
  return { ruleset: result.ruleset, source, hash: result.sourceHash };
}

function pct(n: number, total: number): string {
  return total === 0 ? "-" : `${((100 * n) / total).toFixed(1)}%`;
}

function main(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      db: { type: "string", default: "decisioncapabilities.db" },
      today: { type: "string" },
      dataset: { type: "string" },
      file: { type: "string" },
      trace: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, ...args] = positionals;
  if (values.help || command === undefined) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const today = values.today ?? todayIso();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) fail("--today must be YYYY-MM-DD");
  switch (command) {
    case "load": {
      if (args[0] !== "german") fail("only the german dataset can be loaded: dc load german");
      const file = values.file ?? GERMAN_DEFAULT_PATH;
      const rows = loadGermanFile(file);
      for (const r of rows) {
        const problems = validateCase(underwritingSchema, r.case);
        if (problems.length > 0) fail(`${r.extId}: ${problems.join("; ")}`);
      }
      const store = new Store(values.db);
      store.replaceDataset("german", file, rows);
      store.close();
      const bad = rows.filter((r) => r.label === "bad").length;
      process.stdout.write(`loaded ${rows.length} applications into dataset german (${bad} bad, ${rows.length - bad} good)\n`);
      return;
    }
    case "check": {
      const path = args[0] ?? fail("usage: dc check <file.rules>");
      const source = readFileSync(path, "utf8");
      const result = compile(source, underwritingSchema);
      if (result.diagnostics.length > 0) process.stdout.write(`${formatAll(result.diagnostics, source, path)}\n\n`);
      const errors = result.diagnostics.filter((d) => d.severity === "error").length;
      const warnings = result.diagnostics.length - errors;
      const rules = result.ruleset?.rules.length ?? 0;
      process.stdout.write(
        errors === 0
          ? `${basename(path)}: ok, ${rules} rules, ${warnings} warning(s)\n`
          : `${basename(path)}: ${errors} error(s), ${warnings} warning(s)\n`,
      );
      process.exitCode = errors === 0 ? 0 : 1;
      return;
    }
    case "ir": {
      const path = args[0] ?? fail("usage: dc ir <file.rules>");
      const { ruleset } = compileFile(path, false);
      process.stdout.write(`${JSON.stringify(ruleset, null, 2)}\n`);
      return;
    }
    case "eval": {
      const [rulesPath, casePath] = args;
      if (rulesPath === undefined || casePath === undefined) fail("usage: dc eval <file.rules> <case.json>");
      const { ruleset } = compileFile(rulesPath, false);
      const input = JSON.parse(readFileSync(casePath, "utf8")) as unknown;
      const problems = validateCase(underwritingSchema, input);
      if (problems.length > 0) fail(`invalid case:\n  ${problems.join("\n  ")}`);
      const result = evaluate(ruleset, input as Case, { today });
      const shown: Partial<DecisionResult> = { ...result };
      if (!values.trace) delete shown.trace;
      process.stdout.write(`${JSON.stringify(shown, null, 2)}\n`);
      return;
    }
    case "run": {
      const path = args[0] ?? fail("usage: dc run <file.rules> --dataset <name>");
      const datasetName = values.dataset ?? fail("--dataset is required");
      const { ruleset, source, hash } = compileFile(path, false);
      const store = new Store(values.db);
      const datasetId = store.datasetId(datasetName) ?? fail(`dataset ${datasetName} is not loaded; run: dc load ${datasetName}`);
      const apps = store.applications(datasetId);
      const started = performance.now();
      const results = apps.map((a) => ({ applicationId: a.id, result: evaluate(ruleset, a.case, { today }) }));
      const elapsed = performance.now() - started;
      const rulesetId = store.saveRuleset(ruleset.name, hash, source);
      const runId = store.saveRun(rulesetId, datasetId, today, elapsed, results);
      const s = store.summarize(runId);
      store.close();
      const lines = [
        `run ${runId}: ${ruleset.name} (${ruleset.rules.length} rules) on ${datasetName}, ${s.total} applications`,
        `interpreter: ${elapsed.toFixed(1)} ms, ${Math.round((s.total / elapsed) * 1000).toLocaleString("en-US")} decisions/s`,
        "",
        "outcome    count   share   bad rate",
        ...OUTCOMES.map((o) => {
          const br = s.badRateByOutcome[o];
          return `${o.padEnd(9)} ${String(s.byOutcome[o]).padStart(6)}  ${pct(s.byOutcome[o], s.total).padStart(6)}   ${br === null ? "-" : `${(br * 100).toFixed(1)}%`}`;
        }),
        "",
        "top reasons:",
        ...s.topReasons.map((r) => `  ${r.code.padEnd(28)} ${r.count}`),
      ];
      process.stdout.write(`${lines.join("\n")}\n`);
      return;
    }
    default:
      fail(`unknown command ${command}\n\n${USAGE}`);
  }
}

main(process.argv.slice(2));
