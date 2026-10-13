"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

interface Day {
  date: string;
  costUsd: number;
  calls: number;
}

const W = 720;
const H = 200;
const PAD = { left: 48, right: 8, top: 12, bottom: 24 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

/** 0 → 1; 0.37 → 0.5; 3.2 → 5; 12 → 20: a clean top for the y axis. */
function niceMax(value: number): number {
  if (value <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(value));
  const n = value / exp;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * exp;
}

/** A column with a 4px rounded data end and a square base on the baseline. */
function column(x: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  const y = PAD.top + PLOT_H - h;
  const base = PAD.top + PLOT_H;
  return `M${x},${base} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${base} Z`;
}

/** Daily AI spend: one series, so no legend — the card title names it. Values are also in the table view. */
export function SpendChart({ days }: { days: Day[] }) {
  const t = useTranslations("usage.chart");
  const locale = useLocale();
  const [active, setActive] = useState<number | null>(null);
  const money = (v: number, digits = 2) => new Intl.NumberFormat(locale, { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
  const day = (iso: string, style: "short" | "long") =>
    new Intl.DateTimeFormat(locale, style === "short" ? { month: "short", day: "numeric", timeZone: "UTC" } : { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));

  const top = niceMax(Math.max(...days.map((d) => d.costUsd)));
  const ticks = [0, top / 2, top];
  const band = PLOT_W / days.length;
  const barW = Math.min(24, Math.max(2, band - 4));
  const labelEvery = Math.ceil(days.length / 6);
  const hovered = active !== null ? days[active] : null;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={t("aria", { days: days.length })}>
        {ticks.map((v) => {
          const y = PAD.top + PLOT_H - (v / top) * PLOT_H;
          return (
            <g key={v}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y} y2={y} stroke="var(--border)" strokeWidth={1} />
              <text x={PAD.left - 6} y={y} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--muted)" style={{ fontVariantNumeric: "tabular-nums" }}>
                {money(v, Number.isInteger(v) ? 0 : 2)}
              </text>
            </g>
          );
        })}
        {days.map((d, i) => {
          const x = PAD.left + i * band + (band - barW) / 2;
          const h = (d.costUsd / top) * PLOT_H;
          return (
            <g
              key={d.date}
              tabIndex={0}
              aria-label={t("bar", { date: day(d.date, "long"), cost: money(d.costUsd), calls: d.calls })}
              onPointerEnter={() => setActive(i)}
              onPointerLeave={() => setActive((a) => (a === i ? null : a))}
              onFocus={() => setActive(i)}
              onBlur={() => setActive((a) => (a === i ? null : a))}
              className="outline-none"
              data-day={d.date}
            >
              {/* The hit target is the whole band, not just the painted column. */}
              <rect x={PAD.left + i * band} y={PAD.top} width={band} height={PLOT_H} fill="transparent" />
              {h > 0.5 && <path d={column(x, barW, h)} fill="var(--chart-series)" opacity={active === null || active === i ? 1 : 0.55} />}
              {i % labelEvery === 0 && (
                <text x={PAD.left + i * band + band / 2} y={H - 6} textAnchor="middle" fontSize={11} fill="var(--muted)">
                  {day(d.date, "short")}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hovered && active !== null && (
        <div
          className="pointer-events-none absolute top-1 z-10 -translate-x-1/2 rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-sm"
          style={{ left: `${Math.min(88, Math.max(12, ((PAD.left + active * band + band / 2) / W) * 100))}%` }}
          role="status"
        >
          <p className="text-sm font-semibold" style={{ fontVariantNumeric: "tabular-nums" }}>
            {money(hovered.costUsd)}
          </p>
          <p className="text-muted">{day(hovered.date, "long")}</p>
          <p className="text-muted">{t("calls", { count: hovered.calls })}</p>
        </div>
      )}
    </div>
  );
}
