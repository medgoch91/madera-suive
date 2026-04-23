// Formatting + date helpers, Africa/Casablanca timezone

export const TZ = 'Africa/Casablanca';

export function fmtMoney(n: number | string | null | undefined): string {
  const v = Number(n) || 0;
  return v.toLocaleString('fr-MA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function todayCasa(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
}

export function hourCasa(): number {
  return Number(new Date().toLocaleString('en-GB', { hour: 'numeric', hour12: false, timeZone: TZ }));
}

export function safeNum(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = String(v).trim();
  if (!s) return 0;
  // Strip non-numeric prefix (e.g. "CHK-0042")
  const m = s.match(/(-?\d+(?:\.\d+)?)$/);
  if (m) return Number(m[1]) || 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}
