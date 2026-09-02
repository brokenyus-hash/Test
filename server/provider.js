// Provider dispatch: Anthropic (Claude) or xAI (Grok). Everything in ai.js goes through here.
import { getSetting } from "./db.js";
import * as claude from "./claude.js";
import * as xai from "./providers/xai.js";

export const PROVIDERS = [
  { id: "anthropic", label: "Anthropic — Claude" },
  { id: "xai", label: "xAI — Grok" },
];

const xaiCfg = () => ({ apiKey: getSetting("xaiKey") || process.env.XAI_API_KEY, baseUrl: getSetting("xaiBaseUrl") || process.env.XAI_BASE_URL || xai.XAI_DEFAULT_BASE });

export function hasCredentials(provider = claude.settings().provider) {
  return provider === "xai" ? !!xaiCfg().apiKey : claude.hasCredentials();
}

export function modelsFor(provider) {
  return provider === "xai" ? xai.XAI_FALLBACK_MODELS : claude.MODELS;
}

export async function liveModels(provider) {
  if (provider === "xai") {
    try { return await xai.listModels(xaiCfg()); } catch { return xai.XAI_FALLBACK_MODELS; }
  }
  return claude.MODELS;
}

/** Stream a reply. Returns { text, thinking, usage, stopReason, note }. */
export async function streamText(p) {
  if (p.provider === "xai") {
    const r = await xai.streamText({ ...xaiCfg(), ...p });
    return { ...r, note: r.stopReason === "refusal" ? "The model declined to continue this scene." : null };
  }
  return claude.streamText(p);
}

export function structured(p) {
  if (p.provider === "xai") return xai.structured({ ...xaiCfg(), ...p });
  return claude.structured(p);
}

export function complete(p) {
  if (p.provider === "xai") return xai.complete({ ...xaiCfg(), ...p });
  return claude.complete(p);
}

export function describeError(err) {
  return xai.describeXaiError(err) || claude.describeError(err);
}
