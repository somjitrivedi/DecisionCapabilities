export interface Span {
  start: number;
  end: number;
}

export type Severity = "error" | "warning";

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  span: Span;
  hint?: string;
}

export interface Position {
  line: number;
  col: number;
}

export class SourceMap {
  private readonly lineStarts: number[];

  readonly text: string;

  constructor(text: string) {
    this.text = text;
    this.lineStarts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) this.lineStarts.push(i + 1);
    }
  }

  position(offset: number): Position {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: offset - this.lineStarts[lo]! + 1 };
  }

  lineText(line: number): string {
    const start = this.lineStarts[line - 1] ?? this.text.length;
    const next = this.lineStarts[line];
    const end = next === undefined ? this.text.length : next - 1;
    return this.text.slice(start, end).replace(/\r$/, "");
  }
}

export function formatDiagnostic(d: Diagnostic, map: SourceMap, file: string): string {
  const pos = map.position(d.span.start);
  const lineText = map.lineText(pos.line);
  const endPos = map.position(Math.max(d.span.start, d.span.end - 1));
  const width = endPos.line === pos.line ? Math.max(1, endPos.col - pos.col + 1) : Math.max(1, lineText.length - pos.col + 1);
  const gutter = String(pos.line).length;
  const pad = " ".repeat(gutter);
  const out = [
    `${file}:${pos.line}:${pos.col}: ${d.severity} ${d.code}: ${d.message}`,
    ` ${pad} |`,
    ` ${pos.line} | ${lineText}`,
    ` ${pad} | ${" ".repeat(pos.col - 1)}${"^".repeat(width)}`,
  ];
  if (d.hint !== undefined) out.push(` ${pad} = hint: ${d.hint}`);
  return out.join("\n");
}

export function hasErrors(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}

export function editDistance(a: string, b: string): number {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  const prev = Array.from({ length: bl.length + 1 }, (_, i) => i);
  for (let i = 1; i <= al.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= bl.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (al[i - 1] === bl[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[bl.length]!;
}

export function closest(name: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestScore = Infinity;
  for (const c of candidates) {
    const d = editDistance(name, c);
    if (d < bestScore) {
      best = c;
      bestScore = d;
    }
  }
  const limit = Math.max(2, Math.floor(name.length / 3));
  return best !== undefined && bestScore <= limit ? best : undefined;
}
