import type { Tier } from "@/shared/schemas/job";
import { cn } from "@/lib/cn";

const TONES: Record<Tier, string> = {
  strong: "border-tier-strong text-tier-strong",
  good: "border-tier-good text-tier-good",
  stretch: "border-tier-stretch text-tier-stretch",
  long_shot: "border-tier-longshot text-tier-longshot",
};

/** Interview Chance tier. The label comes from the caller's translations. */
export function TierBadge({ tier, label, large }: { tier: Tier; label: string; large?: boolean }) {
  return (
    <span
      data-tier={tier}
      className={cn("inline-flex items-center rounded-full border-2 font-semibold whitespace-nowrap", large ? "px-3 py-1 text-base" : "px-2 py-0.5 text-xs", TONES[tier])}
    >
      {label}
    </span>
  );
}
