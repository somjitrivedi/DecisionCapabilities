export interface YMD {
  y: number;
  m: number;
  d: number;
}

export function parseDate(value: string): YMD {
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  return { y, m, d };
}

export function epochDays(value: string): number {
  const { y, m, d } = parseDate(value);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

export function yearsBetween(from: string, to: string): number {
  const a = parseDate(from);
  const b = parseDate(to);
  let years = b.y - a.y;
  if (b.m < a.m || (b.m === a.m && b.d < a.d)) years -= 1;
  return years;
}

export function monthsBetween(from: string, to: string): number {
  const a = parseDate(from);
  const b = parseDate(to);
  let months = (b.y - a.y) * 12 + (b.m - a.m);
  if (b.d < a.d) months -= 1;
  return months;
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
