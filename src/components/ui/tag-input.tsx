"use client";

import { useId, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

interface TagInputProps {
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  suggestions?: string[];
  removeLabel: (tag: string) => string;
  id?: string;
  className?: string;
  "aria-label"?: string;
}

/** Chips for short lists (skills, titles, cities). Enter or comma adds; Backspace on empty removes the last one. */
export function TagInput({ value, onChange, placeholder, suggestions, removeLabel, id, className, ...aria }: TagInputProps) {
  const [draft, setDraft] = useState("");
  const listId = useId();

  const add = (raw: string) => {
    const parts = raw
      .split(/[,\n]/)
      .map((p) => p.trim())
      .filter(Boolean)
      .filter((p) => !value.some((v) => v.toLowerCase() === p.toLowerCase()));
    if (parts.length) onChange([...value, ...parts]);
    setDraft("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === "Enter" || e.key === ",") && draft.trim()) {
      e.preventDefault();
      add(draft);
    } else if (e.key === "Backspace" && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div className={cn("flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1.5", className)}>
      {value.map((tag) => (
        <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-xs">
          {tag}
          <button type="button" className="rounded-full hover:text-danger" aria-label={removeLabel(tag)} onClick={() => onChange(value.filter((v) => v !== tag))}>
            <X className="size-3" aria-hidden />
          </button>
        </span>
      ))}
      <input
        id={id}
        className="min-w-24 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
        value={draft}
        placeholder={value.length ? undefined : placeholder}
        list={suggestions?.length ? listId : undefined}
        onChange={(e) => {
          const next = e.target.value;
          if (next.endsWith(",")) add(next);
          else setDraft(next);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => draft.trim() && add(draft)}
        {...aria}
      />
      {suggestions?.length ? (
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      ) : null}
    </div>
  );
}
