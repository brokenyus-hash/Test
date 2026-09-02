// Claude client + shared helpers (model settings, token estimation, structured calls).
import Anthropic from "@anthropic-ai/sdk";
import { getSetting } from "./db.js";

export const DEFAULTS = {
  model: "claude-opus-5",
  utilityModel: "claude-opus-5",
  effort: "medium",          // reply effort: low | medium | high | xhigh | max
  utilityEffort: "low",      // state extraction, summaries, suggestions
  fallbacks: true,           // server-side refusal fallbacks (beta)
  showThinking: false,       // stream summarized thinking to the UI
  maxTokens: 4096,           // per reply
  contextBudget: 24000,      // tokens of raw history before rolling summarization kicks in
  keepRecent: 10,            // messages never summarized away
  replyLength: "medium",     // short | medium | long | epic
  autoState: true,           // extract world state after each reply
  autoSummarize: true,
  autoSuggest: false,        // auto-generate action suggestions after each reply
  realism: "grounded",       // cinematic | grounded | brutal
  pov: "second",             // second | third
  tense: "present",          // present | past
  loreBudget: 2500,
};

export const MODELS = [
  { id: "claude-opus-5", label: "Claude Opus 5 (recommended)" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1 (most capable, premium)" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5 (fast, cheaper)" },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 (cheapest)" },
];

export function settings() {
  const s = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    const v = getSetting(k);
    if (v !== null && v !== undefined && v !== "") s[k] = v;
  }
  return s;
}

export function hasCredentials() {
  return !!(getSetting("apiKey") || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export function client() {
  const apiKey = getSetting("apiKey") || undefined; // undefined -> env / `ant auth login` profile
  return new Anthropic({ apiKey, maxRetries: 2 });
}

/** Rough token estimate (chars / 3.6) - good enough for budgeting; the API is the source of truth. */
export const estimateTokens = (text) => Math.ceil((text || "").length / 3.6);

/** Models that accept `{role:"system"}` messages mid-conversation and adaptive thinking config. */
export const supportsMidSystem = (model) =>
  /^claude-(opus-5|opus-4-8|fable|mythos)/.test(model);

/** Build the thinking/effort params appropriate for the chosen model. */
export function reasoningParams(model, effort, display) {
  const p = {};
  if (/^claude-(fable|mythos)/.test(model)) {
    // Thinking is always on; only display + effort are configurable.
    if (display) p.thinking = { type: "adaptive", display: "summarized" };
    p.output_config = { effort };
  } else if (/^claude-(opus-5|opus-4-[678]|sonnet-5|sonnet-4-6)/.test(model)) {
    p.thinking = display ? { type: "adaptive", display: "summarized" } : { type: "adaptive" };
    p.output_config = { effort: effort === "xhigh" && /4-6$/.test(model) ? "high" : effort };
  }
  // Older models (haiku 4.5 etc.): no thinking, no effort.
  return p;
}

/** Whether to route through the beta endpoint with server-side refusal fallbacks. */
export function fallbackParams(model, enabled) {
  if (!enabled) return null;
  if (!/^claude-(opus-5|fable|mythos)/.test(model)) return null;
  return { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };
}

/**
 * Structured JSON call. Uses messages.parse with a Zod output format.
 * Returns parsed object or throws.
 */
export async function structured({ schema, system, messages, model, effort, maxTokens = 8000 }) {
  const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
  const s = settings();
  const m = model || s.utilityModel;
  const c = client();
  const res = await c.messages.parse({
    model: m,
    max_tokens: maxTokens,
    system,
    messages,
    ...reasoningParams(m, effort || s.utilityEffort, false),
    output_config: { ...(reasoningParams(m, effort || s.utilityEffort, false).output_config || {}), format: zodOutputFormat(schema) },
  });
  if (res.stop_reason === "refusal") {
    const why = res.stop_details?.explanation || "declined by safety system";
    throw new Error(`Model refused: ${why}`);
  }
  if (!res.parsed_output) throw new Error("Model returned unparseable output");
  return { data: res.parsed_output, usage: res.usage };
}

/** Plain text call (non-streaming). */
export async function complete({ system, messages, model, effort, maxTokens = 4000 }) {
  const s = settings();
  const m = model || s.utilityModel;
  const c = client();
  const res = await c.messages.create({
    model: m,
    max_tokens: maxTokens,
    system,
    messages,
    ...reasoningParams(m, effort || s.utilityEffort, false),
  });
  if (res.stop_reason === "refusal") throw new Error(`Model refused: ${res.stop_details?.explanation || "declined"}`);
  return { text: res.content.filter((b) => b.type === "text").map((b) => b.text).join(""), usage: res.usage };
}

export function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "Invalid or missing API key. Add one in Settings.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the API. Wait a moment and try again.";
  if (err instanceof Anthropic.BadRequestError) return `Bad request: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return "Could not reach the Claude API (network).";
  if (err instanceof Anthropic.APIError) return `API error ${err.status}: ${err.message}`;
  return err?.message || String(err);
}
