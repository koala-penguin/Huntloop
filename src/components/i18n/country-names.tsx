"use client";

import { createContext, useContext, type ReactNode } from "react";

interface CountryNames {
  /** Codes in picker order (focus markets first, then alphabetical). */
  order: string[];
  names: Record<string, string>;
}

const Context = createContext<CountryNames>({ order: [], names: {} });

/**
 * Country names are computed once on the server and shared with client components, because
 * Node's and the browser's Intl data can differ — rendering them in both places breaks hydration.
 */
export function CountryNamesProvider({ options, children }: { options: Array<{ code: string; name: string }>; children: ReactNode }) {
  return (
    <Context.Provider value={{ order: options.map((o) => o.code), names: Object.fromEntries(options.map((o) => [o.code, o.name])) }}>
      {children}
    </Context.Provider>
  );
}

export function useCountryNames() {
  const ctx = useContext(Context);
  return {
    order: ctx.order,
    name: (code: string) => ctx.names[code] ?? code,
  };
}
