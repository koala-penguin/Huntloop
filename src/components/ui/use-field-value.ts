"use client";

import { useEffect, useRef, useState } from "react";

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/**
 * State for a controlled text field (or select) that keeps what was typed before the page's scripts
 * ran. React doesn't see input from before it hydrates: the text is in the field but not in state, so
 * a button that depends on it stays disabled, and submitting would send the old value. On mount the
 * field's own value is taken over. Pass the returned ref to the field.
 */
export function useFieldValue<E extends Field = HTMLInputElement>(initial = "") {
  const [value, setValue] = useState(initial);
  const ref = useRef<E>(null);
  const rendered = useRef(initial);
  useEffect(() => {
    const typed = ref.current?.value;
    if (typed !== undefined && typed !== rendered.current) setValue(typed);
  }, []);
  return [value, setValue, ref] as const;
}
