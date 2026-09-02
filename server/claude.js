// Claude client + shared helpers (model settings, token estimation, structured calls).
import Anthropic from "@anthropic-ai/sdk";

export const DEFAULTS = {
  provider: "anthropic",     // anthropic | xai
  model: "claude-opus-5",
  utilityModel: "claude-opus-5",
  xaiModel: "grok-4.6",
  xaiUtilityModel: "grok-4.3",
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

/** Provider to use when none was chosen in Settings: PROVIDER env, else whichever key the environment has. */
function defaultProvider() {
  const env = (process.env.PROVIDER || "").toLowerCase();
  if (env === "xai" || env === "anthropic") return env;
  const hasAnthropic = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  const hasXai = !!process.env.XAI_API_KEY;
  if (hasXai && !hasAnthropic) return "xai";
  return "anthropic";
}

export const SECRET_KEYS = ["apiKey", "xaiKey", "xaiBaseUrl"];

/**
 * Effective settings for a user: defaults <- environment <- the user's saved settings.
 * Includes resolved credentials (anthropicKey / xaiKey / xaiBaseUrl) and active models.
 */
export function settings(user) {
  const us = user?.settings || {};
  const s = { ...DEFAULTS, provider: defaultProvider() };
  for (const k of Object.keys(DEFAULTS)) {
    const v = us[k];
    if (v !== null && v !== undefined && v !== "") s[k] = v;
  }
  s.anthropicKey = us.apiKey || process.env.ANTHROPIC_API_KEY || null;
  s.anthropicKeySource = us.apiKey ? "user" : process.env.ANTHROPIC_API_KEY ? "env" : null;
  s.xaiKey = us.xaiKey || process.env.XAI_API_KEY || null;
  s.xaiKeySource = us.xaiKey ? "user" : process.env.XAI_API_KEY ? "env" : null;
  s.xaiBaseUrl = us.xaiBaseUrl || process.env.XAI_BASE_URL || null;
  return resolveModels(s);
}

/** Fill activeModel / activeUtilityModel from the selected provider (chat overrides may replace activeModel). */
export function resolveModels(s) {
  const xai = s.provider === "xai";
  s.activeModel = xai ? s.xaiModel : s.model;
  s.activeUtilityModel = xai ? s.xaiUtilityModel : s.utilityModel;
  return s;
}

export function hasCredentials(s) {
  return !!(s.anthropicKey || process.env.ANTHROPIC_AUTH_TOKEN);
}

export function client(s) {
  return new Anthropic({ apiKey: s?.anthropicKey || undefined, maxRetries: 2 });
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
export async function structured({ s, schema, system, messages, model, effort, maxTokens = 8000 }) {
  const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
  const m = model || s.activeUtilityModel;
  const c = client(s);
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
export async function complete({ s, system, messages, model, effort, maxTokens = 4000 }) {
  const m = model || s.activeUtilityModel;
  const c = client(s);
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

/**
 * Stream a reply through the Messages API. Returns { text, thinking, usage, stopReason, note }.
 * Uses the beta endpoint with server-side refusal fallbacks when enabled and supported.
 */
export async function streamText({ s, model, system, messages, maxTokens, effort, showThinking, fallbacks, signal, onDelta, onThinking }) {
  const c = client(s);
  const fb = fallbackParams(model, fallbacks);
  const params = {
    model, max_tokens: maxTokens, system, messages,
    ...reasoningParams(model, effort, showThinking), ...(fb || {}),
  };
  let text = "", thinking = "";
  const stream = fb ? c.beta.messages.stream(params, { signal }) : c.messages.stream(params, { signal });
  try {
    for await (const ev of stream) {
      if (ev.type === "content_block_delta") {
        if (ev.delta.type === "text_delta") { text += ev.delta.text; onDelta?.(ev.delta.text); }
        else if (ev.delta.type === "thinking_delta" && ev.delta.thinking) { thinking += ev.delta.thinking; onThinking?.(ev.delta.thinking); }
      }
    }
  } catch (e) {
    if (!signal?.aborted) throw e;
  }
  let final = null;
  try { final = await stream.finalMessage(); } catch (e) { if (!signal?.aborted) throw e; }
  const usage = final?.usage ? {
    input: final.usage.input_tokens, output: final.usage.output_tokens,
    cache_read: final.usage.cache_read_input_tokens, cache_write: final.usage.cache_creation_input_tokens,
    model: final.model,
  } : null;
  const stopReason = final?.stop_reason || (signal?.aborted ? "aborted" : "end_turn");
  const note = stopReason === "refusal" ? (final?.stop_details?.explanation || "The model declined to continue this scene.") : null;
  return { text, thinking, usage, stopReason, note };
}

export function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "Invalid or missing API key. Add one in Settings.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the API. Wait a moment and try again.";
  if (err instanceof Anthropic.BadRequestError) return `Bad request: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return "Could not reach the Claude API (network).";
  if (err instanceof Anthropic.APIError) return `API error ${err.status}: ${err.message}`;
  return err?.message || String(err);
}
