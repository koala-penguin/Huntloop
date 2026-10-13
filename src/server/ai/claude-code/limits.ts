/**
 * The Claude subscription's usage limits as the CLI reports them (`rate_limit_event`): kept in
 * memory so the usage page can show them and background work can wait for a reset.
 */
export interface UsageWindow {
  /** 0–1 share of the window used. */
  utilization: number | null;
  resetsAt: Date | null;
}

export interface SubscriptionUsage {
  /** "allowed", "allowed_warning" or "rejected" (limit reached). */
  status: string;
  resetsAt: Date | null;
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  updatedAt: Date;
}

interface LimitState {
  usage?: SubscriptionUsage;
}

const state = ((globalThis as unknown as { huntloopSubscription?: LimitState }).huntloopSubscription ??= {});

const date = (epochSeconds: unknown): Date | null => (typeof epochSeconds === "number" && epochSeconds > 0 ? new Date(epochSeconds * 1000) : null);

function window(raw: unknown): UsageWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as { utilization?: unknown; resetsAt?: unknown };
  return { utilization: typeof w.utilization === "number" ? w.utilization : null, resetsAt: date(w.resetsAt) };
}

export function recordRateLimit(info: unknown, now = new Date()): SubscriptionUsage | null {
  if (!info || typeof info !== "object") return null;
  const raw = info as { status?: unknown; resetsAt?: unknown; unifiedWindows?: { five_hour?: unknown; seven_day?: unknown } };
  const usage: SubscriptionUsage = {
    status: typeof raw.status === "string" ? raw.status : "allowed",
    resetsAt: date(raw.resetsAt),
    fiveHour: window(raw.unifiedWindows?.five_hour),
    sevenDay: window(raw.unifiedWindows?.seven_day),
    updatedAt: now,
  };
  state.usage = usage;
  return usage;
}

/** A limit error without a usable event still pauses background work for a while. */
export function recordLimitReached(resetsAt: Date | null, now = new Date()): void {
  state.usage = {
    ...(state.usage ?? { fiveHour: null, sevenDay: null }),
    status: "rejected",
    resetsAt: resetsAt ?? new Date(now.getTime() + 30 * 60_000),
    updatedAt: now,
  };
}

export function subscriptionUsage(): SubscriptionUsage | null {
  return state.usage ?? null;
}

/** When the limit was reached and hasn't reset yet: the reset time. */
export function subscriptionLimitedUntil(now = new Date()): Date | null {
  const usage = state.usage;
  if (!usage || usage.status !== "rejected") return null;
  return usage.resetsAt && usage.resetsAt > now ? usage.resetsAt : null;
}

/** Close to a limit: background work (daily searches) holds off, like at the budget warning. */
export function subscriptionNearLimit(warnAtPercent: number, now = new Date()): boolean {
  const usage = state.usage;
  if (!usage) return false;
  if (subscriptionLimitedUntil(now)) return true;
  if (usage.status === "allowed_warning") return true;
  return [usage.fiveHour, usage.sevenDay].some((w) => w?.utilization !== null && w?.utilization !== undefined && w.utilization * 100 >= warnAtPercent && (!w.resetsAt || w.resetsAt > now));
}

/** For tests. */
export function resetSubscriptionUsage(): void {
  state.usage = undefined;
}
