// Provider dispatch: Anthropic (Claude) or xAI (Grok). Everything in ai.js goes through here.
// Every call takes `s` = the caller's resolved settings (see claude.js settings()).
import * as claude from "./claude.js";
import * as xai from "./providers/xai.js";

export const PROVIDERS = [
  { id: "anthropic", label: "Anthropic — Claude" },
  { id: "xai", label: "xAI — Grok" },
];

const xaiCfg = (s) => ({ apiKey: s.xaiKey, baseUrl: s.xaiBaseUrl || xai.XAI_DEFAULT_BASE });

export function hasCredentials(s, provider = s.provider) {
  return provider === "xai" ? !!s.xaiKey : claude.hasCredentials(s);
}

export function modelsFor(provider) {
  return provider === "xai" ? xai.XAI_FALLBACK_MODELS : claude.MODELS;
}

export async function liveModels(s, provider) {
  if (provider === "xai") {
    try { return await xai.listModels(xaiCfg(s)); } catch { return xai.XAI_FALLBACK_MODELS; }
  }
  return claude.MODELS;
}

/** Stream a reply. Returns { text, thinking, usage, stopReason, note }. */
export async function streamText(p) {
  if (p.s.provider === "xai") {
    const r = await xai.streamText({ ...xaiCfg(p.s), ...p });
    return { ...r, note: r.stopReason === "refusal" ? "The model declined to continue this scene." : null };
  }
  return claude.streamText(p);
}

export function structured(p) {
  if (p.s.provider === "xai") return xai.structured({ ...xaiCfg(p.s), ...p });
  return claude.structured(p);
}

export function complete(p) {
  if (p.s.provider === "xai") return xai.complete({ ...xaiCfg(p.s), ...p });
  return claude.complete(p);
}

export function describeError(err) {
  return xai.describeXaiError(err) || claude.describeError(err);
}
