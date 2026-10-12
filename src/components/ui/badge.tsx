import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

const badgeVariants = cva("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", {
  variants: {
    tone: {
      neutral: "bg-accent-soft text-foreground",
      accent: "bg-accent text-accent-foreground",
      warning: "bg-warning-soft text-warning",
      danger: "bg-danger-soft text-danger",
      outline: "border border-border text-muted",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export function Badge({ className, tone, ...props }: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export function Alert({ className, tone = "warning", ...props }: ComponentProps<"div"> & { tone?: "warning" | "danger" | "neutral" }) {
  const tones = {
    warning: "border-warning/40 bg-warning-soft text-warning",
    danger: "border-danger/40 bg-danger-soft text-danger",
    neutral: "border-border bg-accent-soft text-foreground",
  };
  return <div role="status" className={cn("rounded-md border px-4 py-3 text-sm", tones[tone], className)} {...props} />;
}
