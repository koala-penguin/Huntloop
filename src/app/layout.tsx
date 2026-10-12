import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { AppShell } from "@/components/shell/app-shell";
import { CountryNamesProvider } from "@/components/i18n/country-names";
import { countryOptions } from "@/shared/countries";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common");
  return { title: t("appName"), description: t("tagline") };
}

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const locale = await getLocale();
  return (
    <html lang={locale} className="h-full antialiased">
      <body className="min-h-full">
        <NextIntlClientProvider>
          <CountryNamesProvider options={countryOptions(locale)}>
            <AppShell>{children}</AppShell>
          </CountryNamesProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
