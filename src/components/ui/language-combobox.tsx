"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/cn";
import { Input } from "./form";

/** ISO 639-1 languages people commonly list on a CV. Names come from the browser's own data. */
const LANGUAGE_CODES = [
  "af", "am", "ar", "az", "be", "bg", "bn", "bs", "ca", "cs", "cy", "da", "de", "el", "en", "eo", "es", "et", "eu", "fa", "fi", "fil", "fj", "fr", "ga", "gd", "gl", "gu", "ha", "he",
  "hi", "hr", "ht", "hu", "hy", "id", "ig", "is", "it", "ja", "jv", "ka", "kk", "km", "kn", "ko", "ku", "ky", "la", "lb", "lo", "lt", "lv", "mg", "mi", "mk", "ml", "mn", "mr", "ms",
  "mt", "my", "ne", "nl", "no", "ny", "pa", "pl", "ps", "pt", "ro", "ru", "rw", "sd", "si", "sk", "sl", "sm", "sn", "so", "sq", "sr", "st", "su", "sv", "sw", "ta", "te", "tg", "th",
  "ti", "tk", "to", "tr", "tt", "ug", "uk", "ur", "uz", "vi", "xh", "yi", "yo", "zh", "zu", "yue", "haw", "asl", "nzs", "bfi",
];

interface Option {
  code: string;
  /** The name stored and shown, in the list's language. */
  label: string;
  /** Other names it can be found by (the page's language and English). */
  also: string[];
}

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

function namesIn(locale: string): (code: string) => string | null {
  try {
    const names = new Intl.DisplayNames([locale, "en"], { type: "language", fallback: "none" });
    return (code) => names.of(code) ?? null;
  } catch {
    return () => null;
  }
}

/**
 * A text field that suggests languages as you type (ARIA combobox with a list). Any text is
 * allowed; picking a suggestion fills in its name in `listLocale` (the CV's language).
 */
export function LanguageCombobox({
  id,
  value,
  onChange,
  listLocale,
  placeholder,
  labelId,
  "aria-label": ariaLabel,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** The language of the stored names; defaults to the page's. */
  listLocale?: string;
  placeholder?: string;
  /** The id of the field's visible label, which also names the list (else `aria-label` does). */
  labelId?: string;
  "aria-label"?: string;
}) {
  const t = useTranslations("interview.languages");
  const uiLocale = useLocale();
  const locale = listLocale ?? uiLocale;
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listRef = useRef<HTMLUListElement>(null);

  const options = useMemo<Option[]>(() => {
    const own = namesIn(locale);
    const ui = namesIn(uiLocale);
    const en = namesIn("en");
    const seen = new Set<string>();
    const out: Option[] = [];
    for (const code of LANGUAGE_CODES) {
      const label = own(code) ?? en(code) ?? code;
      if (label === code || seen.has(label)) continue;
      seen.add(label);
      out.push({ code, label, also: [ui(code), en(code)].filter((n): n is string => !!n && n !== label) });
    }
    return out.sort((a, b) => a.label.localeCompare(b.label, locale));
  }, [locale, uiLocale]);

  const matches = useMemo(() => {
    const q = fold(value);
    if (!q) return options;
    const names = (o: Option) => [o.label, ...o.also].map(fold);
    const prefix = options.filter((o) => names(o).some((n) => n.startsWith(q) || n.split(/[\s(]+/).some((w) => w.startsWith(q))));
    const inner = options.filter((o) => !prefix.includes(o) && names(o).some((n) => n.includes(q)));
    return [...prefix, ...inner].slice(0, 12);
  }, [options, value]);

  const expanded = open && matches.length > 0;
  const optionId = (i: number) => `${listId}-opt-${i}`;

  useEffect(() => {
    if (!expanded || active < 0) return;
    document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
    // optionId only depends on listId, which never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, expanded]);

  const pick = (option: Option) => {
    onChange(option.label);
    setOpen(false);
    setActive(-1);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp": {
        e.preventDefault();
        if (!expanded) {
          setOpen(true);
          if (!e.altKey) setActive(e.key === "ArrowDown" ? 0 : matches.length - 1);
          return;
        }
        if (e.altKey) return;
        const step = e.key === "ArrowDown" ? 1 : -1;
        setActive((a) => (a < 0 ? (step > 0 ? 0 : matches.length - 1) : (a + step + matches.length) % matches.length));
        return;
      }
      case "Home":
      case "End":
        if (!expanded || active < 0) return;
        e.preventDefault();
        setActive(e.key === "Home" ? 0 : matches.length - 1);
        return;
      case "Enter":
        if (expanded && active >= 0 && matches[active]) {
          e.preventDefault();
          pick(matches[active]);
        } else setOpen(false);
        return;
      case "Escape":
        if (expanded) {
          e.preventDefault();
          setOpen(false);
          setActive(-1);
        } else if (value) {
          e.preventDefault();
          onChange("");
        }
        return;
      case "Tab":
        setOpen(false);
        return;
    }
  };

  return (
    <div className="relative">
      <Input
        id={id}
        role="combobox"
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        aria-activedescendant={expanded && active >= 0 ? optionId(active) : undefined}
        autoComplete="off"
        value={value}
        placeholder={placeholder ?? t("placeholder")}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(false)}
        onBlur={() => {
          setOpen(false);
          setActive(-1);
        }}
        onKeyDown={onKeyDown}
      />
      {expanded && (
        <ul ref={listRef} id={listId} role="listbox" aria-label={ariaLabel} aria-labelledby={ariaLabel ? undefined : labelId} className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-md border border-border bg-surface py-1 shadow-lg">
          {matches.map((o, i) => (
            <li
              key={o.code}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              className={cn("flex min-h-10 cursor-pointer items-center border-l-2 px-3 text-sm", i === active ? "border-accent bg-accent-soft font-medium" : "border-transparent hover:bg-accent-soft")}
              // Before the input's blur, so the click lands.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(o);
              }}
            >
              {o.label}
            </li>
          ))}
        </ul>
      )}
      <span role="status" className="sr-only">
        {open ? (matches.length ? t("matches", { count: matches.length }) : t("noMatch")) : ""}
      </span>
    </div>
  );
}
