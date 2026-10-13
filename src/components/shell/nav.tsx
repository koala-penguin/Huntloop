"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { BriefcaseBusiness, Kanban, LayoutDashboard, Menu, Search, Settings, UserRound, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

interface NavItem {
  href: string;
  key: "dashboard" | "search" | "jobs" | "pipeline" | "profile" | "settings";
  icon: LucideIcon;
}

const ITEMS: NavItem[] = [
  { href: "/", key: "dashboard", icon: LayoutDashboard },
  { href: "/search", key: "search", icon: Search },
  { href: "/jobs", key: "jobs", icon: BriefcaseBusiness },
  { href: "/pipeline", key: "pipeline", icon: Kanban },
  { href: "/profile", key: "profile", icon: UserRound },
  { href: "/settings", key: "settings", icon: Settings },
];

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

export function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  return (
    <nav aria-label={t("main")} className="flex flex-col gap-1 px-3 pb-4">
      {ITEMS.map(({ href, key, icon: Icon }) => {
        const active = isActive(pathname, href);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm",
              active ? "bg-accent-soft font-medium" : "text-muted hover:bg-accent-soft hover:text-foreground",
            )}
          >
            <Icon className="size-4" aria-hidden />
            {t(key)}
          </Link>
        );
      })}
    </nav>
  );
}

export function MobileNav({ appName }: { appName: string }) {
  const t = useTranslations("common");
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-border bg-surface md:hidden">
      <div className="flex items-center justify-between px-4 py-3">
        <p className="font-semibold">{appName}</p>
        <button
          type="button"
          className="rounded-md p-2 hover:bg-accent-soft"
          aria-expanded={open}
          aria-label={open ? t("closeMenu") : t("openMenu")}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <X className="size-5" aria-hidden /> : <Menu className="size-5" aria-hidden />}
        </button>
      </div>
      {open && <NavLinks onNavigate={() => setOpen(false)} />}
    </div>
  );
}
