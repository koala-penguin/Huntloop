export function formatUsd(amount: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: amount > 0 && amount < 0.01 ? 4 : 2,
  }).format(amount);
}

export interface SalaryLike {
  text: string | null;
  min: number | null;
  max: number | null;
  currency: string | null;
  basis: string;
}

/** The salary as one line: the posting's own words (or the formatted range), plus the basis unless the words already say it. */
export function salaryLine(salary: SalaryLike | null, locale: string, basisLabel: (basis: string) => string): string | null {
  if (!salary) return null;
  const range = salary.min || salary.max ? [salary.min, salary.max].filter((v): v is number => v !== null) : [];
  const text = (salary.text ?? (range.length ? `${salary.currency ?? ""} ${range.map((v) => new Intl.NumberFormat(locale).format(v)).join(" – ")}` : "")).trim();
  if (!text) return null;
  if (salary.basis === "unknown" || /\b(super|package|base)\b/i.test(text)) return text;
  return `${text} · ${basisLabel(salary.basis)}`;
}
