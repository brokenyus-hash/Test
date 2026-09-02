// AI endpoints: SSE streaming replies + generation helpers.
import { Router } from "express";
import * as db from "../db.js";
import { hasCredentials, describeError } from "../provider.js";
import { settings } from "../claude.js";
import * as ai from "../ai.js";

export const aiRoutes = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const needKey = (res) => {
  const s = settings();
  if (hasCredentials(s.provider)) return false;
  res.status(400).json({ error: `No API key configured for ${s.provider === "xai" ? "xAI (Grok)" : "Anthropic (Claude)"}. Open Settings and add one.` });
  return true;
};

/** Server-Sent Events over a POST body. */
function sse(res) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  const emit = (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const ping = setInterval(() => { if (!res.writableEnded) res.write(": ping\n\n"); }, 15000);
  const end = () => { clearInterval(ping); if (!res.writableEnded) res.end(); };
  return { emit, end };
}

// POST /api/ai/chats/:id/reply  { text?, mode?: reply|regen|continue, target_message_id?, instruction?, kind? }
aiRoutes.post("/chats/:id/reply", wrap(async (req, res) => {
  if (needKey(res)) return;
  const chat = db.chats.get(req.params.id);
  if (!chat) return res.status(404).json({ error: "Chat not found" });
  const { text, mode = "reply", target_message_id = null, instruction = null, kind } = req.body || {};

  let userMessage = null;
  if (mode === "reply" && text && text.trim()) {
    userMessage = db.messages.add(chat.id, { role: "user", text: text.trim(), kind });
  }
  const { emit, end } = sse(res);
  if (userMessage) emit("user_message", { message: userMessage });
  const ac = new AbortController();
  // Abort the model call only if the client goes away before we finish writing.
  res.on("close", () => { if (!res.writableFinished) ac.abort(); });
  try {
    await ai.streamReply({ chatId: chat.id, emit, signal: ac.signal, mode, targetMessageId: target_message_id, instruction });
  } catch (e) {
    console.error("[reply]", e);
    emit("error", { error: describeError(e) });
  } finally {
    end();
  }
}));

// Narrator tools: time skip / random event / scene change / narration -> creates a direction message and streams reply
aiRoutes.post("/chats/:id/direct", wrap(async (req, res) => {
  if (needKey(res)) return;
  const chat = db.chats.get(req.params.id);
  if (!chat) return res.status(404).json({ error: "Chat not found" });
  const { kind, detail } = req.body || {};
  const direction = ai.narratorDirection(kind, detail);
  if (!direction) return res.status(400).json({ error: "kind required" });
  const m = db.messages.add(chat.id, { role: "user", text: direction, kind: "direction" });
  const { emit, end } = sse(res);
  emit("user_message", { message: m });
  const ac = new AbortController();
  // Abort the model call only if the client goes away before we finish writing.
  res.on("close", () => { if (!res.writableFinished) ac.abort(); });
  try { await ai.streamReply({ chatId: chat.id, emit, signal: ac.signal }); }
  catch (e) { emit("error", { error: describeError(e) }); }
  finally { end(); }
}));

/**
 * Long-running AI jobs answer over SSE too: headers go out immediately and a ping every
 * 15 s keeps proxies (Render/Cloudflare ~100 s idle limit) from cutting the connection.
 * Events: status, result, error. `fn` may throw a { status, message } for validation errors.
 */
const job = (fn) => wrap(async (req, res) => {
  if (needKey(res)) return;
  let ready;
  try { ready = await fn.validate?.(req); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const { emit, end } = sse(res);
  try { emit("result", await fn(req, emit, ready)); }
  catch (e) { console.error("[job]", e); emit("error", { error: describeError(e) }); }
  finally { end(); }
});
const bad = (message) => Object.assign(new Error(message), { status: 400 });

aiRoutes.post("/chats/:id/suggest", job(async (req) => ({ suggestions: await ai.suggestActions(req.params.id) })));
aiRoutes.post("/chats/:id/impersonate", job(async (req) => ({ text: await ai.impersonate(req.params.id, req.body?.hint) })));
aiRoutes.post("/chats/:id/summarize", job(async (req, emit) => {
  const ctx = ai.loadChatContext(req.params.id);
  ctx.s.contextBudget = 0; // force: summarize everything except the last keepRecent messages
  const summary = await ai.maybeSummarize({ ...ctx, s: { ...ctx.s, autoSummarize: true } }, emit);
  return { summary: summary ?? ctx.chat.summary, chat: db.chats.get(req.params.id) };
}));
aiRoutes.post("/chats/:id/refresh-state", job(async (req, emit) => {
  const ctx = ai.loadChatContext(req.params.id);
  const msgs = ctx.history;
  const lastA = [...msgs].reverse().find((m) => m.role === "assistant");
  const lastU = [...msgs].reverse().find((m) => m.role === "user" && (!lastA || m.seq < lastA.seq));
  const t = (m) => (m ? m.alternatives?.[m.active ?? 0] ?? "" : "");
  const r = await ai.extractState({ ...ctx, s: { ...ctx.s, autoState: true } }, t(lastU), t(lastA) || "(no reply yet)", emit);
  return { state: r.state, memory: r.memory, timeline: db.timeline.list(req.params.id) };
}));
aiRoutes.post("/chats/:id/title", job(async (req) => ({ title: await ai.autoTitle(req.params.id) })));

// Character / world generation
const genCharacter = async (req, emit) => {
  emit("status", { text: "Designing the character…" });
  return ai.generateCharacter(req.body?.prompt, req.body?.existing);
};
genCharacter.validate = (req) => { if (!req.body?.prompt && !req.body?.existing) throw bad("prompt required"); };
aiRoutes.post("/generate/character", job(genCharacter));

const genField = async (req) => ({ text: await ai.enhanceField(req.body?.character || {}, req.body.field, req.body?.guidance) });
genField.validate = (req) => { if (!req.body?.field) throw bad("field required"); };
aiRoutes.post("/generate/field", job(genField));

const genWorld = async (req, emit) => { emit("status", { text: "Building the world…" }); return ai.generateWorld(req.body.prompt); };
genWorld.validate = (req) => { if (!req.body?.prompt) throw bad("prompt required"); };
aiRoutes.post("/generate/world", job(genWorld));
