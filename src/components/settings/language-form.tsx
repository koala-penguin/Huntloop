"use client";

import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { LOCALES } from "@/i18n/locales";
import { Label, Select } from "@/components/ui/form";
import { setLocaleAction } from "@/app/settings/actions";

export function LanguageForm() {
  const t = useTranslations("settings");
  const locale = useLocale();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex max-w-xs flex-col gap-2">
      <Label htmlFor="app-language">{t("languageLabel")}</Label>
      <Select
        id="app-language"
        value={locale}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value;
          startTransition(async () => {
            await setLocaleAction(next);
            router.refresh();
          });
        }}
      >
        {LOCALES.map((l) => (
          <option key={l} value={l}>
            {t(`localeName.${l}`)}
          </option>
        ))}
      </Select>
    </div>
  );
}
