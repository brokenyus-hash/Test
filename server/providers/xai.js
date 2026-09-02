// xAI (Grok) provider via the OpenAI-compatible chat completions API.
import { z } from "zod";

export const XAI_DEFAULT_BASE = "https://api.x.ai/v1";
export const XAI_FALLBACK_MODELS = [
  { id: "grok-4.6", label: "Grok 4.6 (recommended)" },
  { id: "grok-4.5", label: "Grok 4.5" },
  { id: "grok-4.3", label: "Grok 4.3 (fast, cheaper)" },
  { id: "grok-4.20-0309-reasoning", label: "Grok 4.20 reasoning" },
  { id: "grok-4.20-0309-non-reasoning", label: "Grok 4.20 non-reasoning" },
];

export class XaiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function headers(apiKey) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
}

async function request(path, body, { apiKey, baseUrl, signal }) {
  const res = await fetch(`${(baseUrl || XAI_DEFAULT_BASE).replace(/\/$/, "")}${path}`, {
    method: body ? "POST" : "GET",
    headers: headers(apiKey),
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = j.error?.message || j.error || j.message || JSON.stringify(j); } catch { /* ignore */ }
    throw new XaiError(res.status, typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return res;
}

/** Convert Anthropic-shaped system + messages into OpenAI-style messages. */
export function toOpenAIMessages(system, messages) {
  const out = [];
  const sysText = Array.isArray(system) ? system.map((b) => b.text).join("\n\n") : system;
  if (sysText) out.push({ role: "system", content: sysText });
  for (const m of messages) {
    const content = Array.isArray(m.content) ? m.content.map((c) => c.text ?? "").join("\n\n") : m.content;
    out.push({ role: m.role, content });
  }
  return out;
}

function effortParam(model, effort) {
  if (!effort || /non-reasoning/.test(model)) return {};
  if (effort === "low") return { reasoning_effort: "low" };
  if (effort === "medium") return {};
  return { reasoning_effort: "high" };
}

const usageOf = (u) => u ? {
  input: u.prompt_tokens, output: u.completion_tokens,
  cache_read: u.prompt_tokens_details?.cached_tokens || 0, cache_write: 0,
  reasoning: u.completion_tokens_details?.reasoning_tokens || 0,
} : null;

/** Stream a chat completion. Calls onDelta(text) / onThinking(text). */
export async function streamText({ apiKey, baseUrl, model, system, messages, maxTokens, effort, showThinking, signal, onDelta, onThinking }) {
  const body = {
    model, stream: true, stream_options: { include_usage: true }, max_tokens: maxTokens,
    messages: toOpenAIMessages(system, messages), ...effortParam(model, effort),
  };
  const res = await request("/chat/completions", body, { apiKey, baseUrl, signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", text = "", thinking = "", usage = null, finish = null, servedModel = model;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let j; try { j = JSON.parse(data); } catch { continue; }
        if (j.model) servedModel = j.model;
        if (j.usage) usage = usageOf(j.usage);
        const ch = j.choices?.[0];
        if (!ch) continue;
        if (ch.delta?.content) { text += ch.delta.content; onDelta?.(ch.delta.content); }
        if (ch.delta?.reasoning_content && showThinking) { thinking += ch.delta.reasoning_content; onThinking?.(ch.delta.reasoning_content); }
        if (ch.finish_reason) finish = ch.finish_reason;
      }
    }
  } catch (e) {
    if (!signal?.aborted) throw e;
  }
  return { text, thinking, usage: usage ? { ...usage, model: servedModel } : { model: servedModel }, stopReason: finish === "length" ? "max_tokens" : finish === "content_filter" ? "refusal" : "end_turn" };
}

export async function complete({ apiKey, baseUrl, model, system, messages, maxTokens, effort }) {
  const res = await request("/chat/completions", {
    model, max_tokens: maxTokens, messages: toOpenAIMessages(system, messages), ...effortParam(model, effort),
  }, { apiKey, baseUrl });
  const j = await res.json();
  const ch = j.choices?.[0];
  if (ch?.finish_reason === "content_filter") throw new Error("Model refused: content filtered");
  return { text: ch?.message?.content || "", usage: usageOf(j.usage) };
}

/** Structured output via json_schema response_format, validated with the Zod schema. */
export async function structured({ apiKey, baseUrl, model, system, messages, maxTokens, effort, schema }) {
  const jsonSchema = z.toJSONSchema(schema);
  delete jsonSchema.$schema;
  const base = { model, max_tokens: maxTokens, messages: toOpenAIMessages(system, messages), ...effortParam(model, effort) };
  let res;
  try {
    res = await request("/chat/completions", { ...base, response_format: { type: "json_schema", json_schema: { name: "output", strict: true, schema: jsonSchema } } }, { apiKey, baseUrl });
  } catch (e) {
    if (!(e instanceof XaiError) || e.status !== 400) throw e;
    // Some schema features are rejected in strict mode; retry non-strict with the schema in the prompt.
    const msgs = base.messages.concat([{ role: "system", content: `Respond with JSON only, matching this JSON schema exactly:\n${JSON.stringify(jsonSchema)}` }]);
    res = await request("/chat/completions", { ...base, messages: msgs, response_format: { type: "json_object" } }, { apiKey, baseUrl });
  }
  const j = await res.json();
  const raw = j.choices?.[0]?.message?.content || "";
  let parsed;
  try { parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { throw new Error("Model returned unparseable JSON"); }
  const v = schema.safeParse(parsed);
  if (!v.success) throw new Error(`Model output failed validation: ${v.error.issues.slice(0, 3).map((i) => i.path.join(".") + " " + i.message).join("; ")}`);
  return { data: v.data, usage: usageOf(j.usage) };
}

export async function listModels({ apiKey, baseUrl }) {
  const res = await request("/models", null, { apiKey, baseUrl });
  const j = await res.json();
  const ids = (j.data || []).map((m) => m.id).filter((id) => /^grok-/.test(id) && !/imagine|build|multi-agent/.test(id));
  ids.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return ids.map((id) => ({ id, label: XAI_FALLBACK_MODELS.find((m) => m.id === id)?.label || id }));
}

export function describeXaiError(err) {
  if (!(err instanceof XaiError)) return null;
  if (err.status === 401 || err.status === 403) return "Invalid or missing xAI API key. Add one in Settings.";
  if (err.status === 429) return "Rate limited by xAI. Wait a moment and try again.";
  if (err.status === 400) return `xAI rejected the request: ${err.message}`;
  return `xAI error ${err.status}: ${err.message}`;
}
