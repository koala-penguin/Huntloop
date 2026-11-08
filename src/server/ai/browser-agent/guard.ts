/**
 * What the browsing agent may do in the user's browser. Claude only sees an allowlisted subset of
 * Chrome DevTools MCP tools, and every call is checked here first: navigation stays on allowed
 * sites, clicks never hit "apply / message / connect / sign in"-type controls, and typing only goes
 * into search fields. Anything else is refused with a reason Claude can read.
 */

export const AGENT_TOOLS = ["list_pages", "select_page", "new_page", "navigate_page", "close_page", "take_snapshot", "click", "fill", "press_key", "wait_for"] as const;
export type AgentTool = (typeof AGENT_TOOLS)[number];

export interface SnapshotElement {
  role: string;
  name: string;
  url: string | null;
}

/** uid → element, from a take_snapshot result (`uid=1_2 link "Name" url="…"`). */
export function parseSnapshot(text: string): Map<string, SnapshotElement> {
  const out = new Map<string, SnapshotElement>();
  for (const line of text.split("\n")) {
    const m = /^\s*uid=(\S+)\s+(\S+)(?:\s+"((?:[^"\\]|\\.)*)")?(.*)$/.exec(line);
    if (!m) continue;
    const url = /\burl="([^"]*)"/.exec(m[4] ?? "")?.[1] ?? null;
    out.set(m[1], { role: m[2], name: (m[3] ?? "").replace(/\\"/g, '"'), url });
  }
  return out;
}

/** Controls that would act on the user's behalf. English and Korean labels. */
const BLOCKED_LABEL =
  /\b(easy apply|apply|submit|send|message|inmail|connect|follow|unfollow|sign ?up|register|join now|log ?in|sign ?in|subscribe|buy|purchase|pay|checkout|delete|remove|save|saved|share|report|like|comment|repost|upload|download|install|create (an )?account|continue with (google|apple|linkedin|facebook))\b|지원|제출|메시지|팔로우|로그인|가입|구매|결제|삭제|저장|공유|신고/i;
const CLICKABLE_ROLES = new Set(["link", "button", "tab", "menuitem", "menuitemradio", "option", "combobox", "checkbox", "radio", "listitem", "treeitem", "switch", "StaticText", "heading", "gridcell", "cell", "row"]);
const SEARCH_FIELD = /search|keyword|what|job|title|role|position|where|location|suburb|city|state|postcode|zip|query|find|filter|검색|지역|직무|키워드/i;
const PRIVATE_FIELD = /password|e-?mail|phone|mobile|first name|last name|full name|address|card|cvv|birth|resume|cv\b|cover letter|비밀번호|이메일|전화|이름|주소/i;
const ALLOWED_KEYS = new Set(["Enter", "Escape", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "PageDown", "PageUp", "Home", "End"]);
/** Reads of the current page; they don't change what Enter would act on. */
const KEEPS_LAST_ACTION = new Set<AgentTool>(["take_snapshot", "wait_for", "list_pages"]);

export interface GuardState {
  /** Latest snapshot per page id (uids are only valid for the page they came from). */
  snapshots: Map<number, Map<string, SnapshotElement>>;
  /** Hosts the agent may open (suffix match: "seek.com.au" allows "www.seek.com.au"). */
  isAllowedHost: (host: string) => boolean;
  /**
   * The last approved call that changes the page or which page is selected. Enter is only allowed
   * right after a fill, so it submits the search just typed and nothing else.
   */
  lastAction?: AgentTool;
}

export type GuardDecision = { ok: true; input: Record<string, unknown> } | { ok: false; reason: string };

export function hostAllowList(hosts: Iterable<string>): (host: string) => boolean {
  const list = [...hosts].map((h) => h.toLowerCase().replace(/^www\./, "")).filter(Boolean);
  return (host) => {
    const h = host.toLowerCase().replace(/^www\./, "");
    return list.some((allowed) => h === allowed || h.endsWith(`.${allowed}`));
  };
}

function checkUrl(raw: unknown, state: GuardState): string | null {
  if (typeof raw !== "string") return "A URL is required.";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "That isn't a valid URL.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Only http(s) pages can be opened.";
  if (!state.isAllowedHost(url.hostname)) return `${url.hostname} isn't one of the sites you may browse for this task.`;
  return null;
}

function element(state: GuardState, input: Record<string, unknown>): SnapshotElement | string {
  const snapshot = state.snapshots.get(Number(input.pageId));
  if (!snapshot) return "Take a snapshot of this page first (take_snapshot), then use a uid from it.";
  return snapshot.get(String(input.uid ?? "")) ?? "That uid isn't in the latest snapshot of this page. Take a new snapshot.";
}

export function checkToolCall(name: string, rawInput: unknown, state: GuardState): GuardDecision {
  const decision = decide(name, rawInput, state);
  if (decision.ok && !KEEPS_LAST_ACTION.has(name as AgentTool)) state.lastAction = name as AgentTool;
  return decision;
}

function decide(name: string, rawInput: unknown, state: GuardState): GuardDecision {
  if (!(AGENT_TOOLS as readonly string[]).includes(name)) return { ok: false, reason: `The ${name} tool isn't available.` };
  const input = { ...((rawInput ?? {}) as Record<string, unknown>) };
  const deny = (reason: string): GuardDecision => ({ ok: false, reason });

  switch (name as AgentTool) {
    case "list_pages":
    case "select_page":
    case "close_page":
      return { ok: true, input };
    case "new_page": {
      const problem = checkUrl(input.url, state);
      if (problem) return deny(problem);
      delete input.isolatedContext;
      delete input.background;
      input.timeout = Math.min(Number(input.timeout) || 30_000, 30_000);
      return { ok: true, input };
    }
    case "navigate_page": {
      const type = input.type ?? (input.url ? "url" : undefined);
      if (type === "url") {
        const problem = checkUrl(input.url, state);
        if (problem) return deny(problem);
      } else if (!["back", "forward", "reload"].includes(String(type))) return deny("Use type url, back, forward or reload.");
      input.type = type;
      input.timeout = Math.min(Number(input.timeout) || 30_000, 30_000);
      return { ok: true, input };
    }
    case "take_snapshot":
      // Never write files; the snapshot comes back in the response.
      delete input.filePath;
      delete input.verbose;
      return { ok: true, input };
    case "click": {
      const el = element(state, input);
      if (typeof el === "string") return deny(el);
      if (!CLICKABLE_ROLES.has(el.role)) return deny(`Clicking a ${el.role} isn't allowed.`);
      if (BLOCKED_LABEL.test(el.name)) return deny(`"${el.name}" would act on the user's behalf (apply, message, sign in, save, …). Only browse and search.`);
      if (el.url) {
        const problem = checkUrl(el.url, state);
        if (problem) return deny(problem);
      }
      input.dblClick = false;
      return { ok: true, input };
    }
    case "fill": {
      const el = element(state, input);
      if (typeof el === "string") return deny(el);
      if (!["searchbox", "textbox", "combobox"].includes(el.role)) return deny("You can only type into search fields.");
      if (PRIVATE_FIELD.test(el.name)) return deny("Never type into account, contact or application fields.");
      if (el.role !== "searchbox" && !SEARCH_FIELD.test(el.name)) return deny(`"${el.name}" doesn't look like a job search field.`);
      const value = String(input.value ?? "");
      if (value.length > 120 || /@|\d{6,}|[\u0000-\u001f\u007f]/.test(value)) return deny("Only type short search terms (no contact details).");
      return { ok: true, input };
    }
    case "press_key": {
      const key = String(input.key);
      const refusal = "Only Enter right after typing into a search field, Escape, arrow and paging keys are allowed.";
      if (!ALLOWED_KEYS.has(key)) return deny(refusal);
      if (key === "Enter" && state.lastAction !== "fill") return deny(refusal);
      return { ok: true, input };
    }
    case "wait_for":
      input.timeout = Math.min(Number(input.timeout) || 10_000, 10_000);
      return { ok: true, input };
  }
}

/** "2: Title (https://…) [selected]" → 2. */
export function selectedPageId(listText: string): number | null {
  const m = /^(\d+):.*\[selected\]\s*$/m.exec(listText);
  return m ? Number(m[1]) : null;
}
