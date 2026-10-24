"use client";

import { useTranslations } from "next-intl";
import type { ProgressNoteLike } from "@/shared/progress-note";

/** Renders task progress notes: structured ones from the `browserNotes` catalog, plain text as is. */
export function useProgressNoteText(): (note: ProgressNoteLike) => string {
  const t = useTranslations("browserNotes");
  return (note) => {
    if (typeof note === "string") return note;
    // A note written by another Huntloop version may use a key this one doesn't know.
    return t.has(note.key as never) ? t(note.key as never, note.params as never) : note.key;
  };
}
