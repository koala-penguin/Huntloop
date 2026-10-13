"use client";

import type { ComponentProps } from "react";
import { useCountryNames } from "@/components/i18n/country-names";
import { Select } from "./form";

type Props = Omit<ComponentProps<typeof Select>, "value" | "onChange" | "children"> & {
  value: string | null;
  onChange: (code: string | null) => void;
  /** Label of the empty option; omit to require a choice. */
  emptyLabel?: string;
  exclude?: string[];
};

export function CountrySelect({ value, onChange, emptyLabel, exclude, ...props }: Props) {
  const { order, name } = useCountryNames();
  const codes = order.filter((code) => !exclude?.includes(code) || code === value);
  return (
    <Select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} {...props}>
      {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
      {codes.map((code) => (
        <option key={code} value={code}>
          {name(code)}
        </option>
      ))}
    </Select>
  );
}
