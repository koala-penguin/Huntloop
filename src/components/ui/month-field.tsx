"use client";

import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { Input, Select } from "./form";

const split = (value: string) => ({ year: value.slice(0, 4), month: value.slice(5, 7) });
const join = (month: string, year: string) => (/^\d{4}$/.test(year) ? (month ? `${year}-${month}` : year) : "");

/**
 * A date as a month and a year, or a year alone: a month picker and a year box under one legend.
 * Gives "", "YYYY" or "YYYY-MM". A month without a year gives "" and shows as invalid. Not the
 * browser's month input, which can't hold a year on its own.
 */
export function MonthField({
  legend,
  value,
  onChange,
  idPrefix,
  required = false,
  invalid = false,
  disabled = false,
  describedBy,
  className,
}: {
  legend: string;
  value: string;
  onChange: (value: string) => void;
  idPrefix: string;
  required?: boolean;
  invalid?: boolean;
  disabled?: boolean;
  describedBy?: string;
  className?: string;
}) {
  const t = useTranslations("cvBuilder.month");
  const locale = useLocale();
  const months = useMemo(() => {
    const format = new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" });
    return Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1).padStart(2, "0"), label: format.format(new Date(Date.UTC(2020, i, 1))) }));
  }, [locale]);
  const [local, setLocal] = useState(() => split(value));
  // A value set from outside (a new card, a reset) replaces what was being typed.
  if (value && join(local.month, local.year) !== value) setLocal(split(value));
  const shown = disabled ? { month: "", year: "" } : local;
  const set = (next: { month: string; year: string }) => {
    setLocal(next);
    onChange(join(next.month, next.year));
  };
  const bad = invalid || (!disabled && !!shown.month && !/^\d{4}$/.test(shown.year));
  return (
    <fieldset className={cn("flex min-w-0 flex-col gap-1.5", className)} disabled={disabled}>
      <legend className="mb-1.5 text-sm font-medium">{legend}</legend>
      <div className="flex gap-2">
        <Select
          id={`${idPrefix}-month`}
          className="h-10 min-w-0 flex-1"
          aria-label={`${legend}: ${t("month")}`}
          aria-invalid={bad || undefined}
          aria-describedby={describedBy}
          value={shown.month}
          onChange={(e) => set({ ...local, month: e.target.value })}
        >
          <option value="">{t("none")}</option>
          {months.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </Select>
        <Input
          id={`${idPrefix}-year`}
          className="h-10 w-24"
          inputMode="numeric"
          pattern="\d{4}"
          maxLength={4}
          placeholder={t("yearPlaceholder")}
          aria-label={`${legend}: ${t("year")}`}
          aria-required={required || undefined}
          aria-invalid={bad || undefined}
          aria-describedby={describedBy}
          value={shown.year}
          onChange={(e) => set({ ...local, year: e.target.value.replace(/\D/g, "").slice(0, 4) })}
        />
      </div>
    </fieldset>
  );
}
