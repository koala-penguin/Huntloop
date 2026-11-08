/**
 * A progress line shown while a task runs. Notes Huntloop writes itself are a message key plus
 * values, rendered from the `browserNotes` catalog in the user's language; free text from Claude
 * (its own progress summaries) and notes stored by older versions stay plain strings.
 */
export interface ProgressNote {
  key: string;
  params?: Record<string, string | number>;
}

export type ProgressNoteLike = string | ProgressNote;

export function sameNote(a?: ProgressNoteLike, b?: ProgressNoteLike): boolean {
  if (a === undefined || b === undefined) return false;
  if (typeof a === "string" || typeof b === "string") return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}
