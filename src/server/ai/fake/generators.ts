/**
 * Demo-mode responses for each AI task. Each generator derives its answer from the request so
 * the rest of the pipeline (quote checks, scoring, rendering) behaves as it would with Claude.
 * Tasks without a generator get a generic demo reply (chat) or an error (structured output).
 */
import "./generators/extract-profile";
