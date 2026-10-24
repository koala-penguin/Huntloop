export type AiErrorCode =
  | "refusal"
  | "max_tokens"
  | "invalid_output"
  | "budget"
  | "api"
  /** The Claude Code CLI isn't installed (or not where HUNTLOOP_CLAUDE_PATH points). */
  | "cli_missing"
  /** The Claude Code CLI isn't signed in. */
  | "cli_login"
  /** The Claude subscription's usage limit is reached; `detail.resetsAt` says when it resets. */
  | "subscription_limit"
  /** The chosen model isn't available on this plan or key. */
  | "model_unavailable"
  /** A chat thread's Claude Code session can't be continued (e.g. it was saved under an older working folder). */
  | "session_expired";

export class AiError extends Error {
  constructor(
    public readonly code: AiErrorCode,
    message: string,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = "AiError";
  }
}
