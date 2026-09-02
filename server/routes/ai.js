// AI endpoints: SSE turns + long-running generation jobs (all per signed-in user).
import { Router } from "express";
import * as db from "../db.js";
import { settings } from "../claude.js";
import { hasCredentials, describeError } from "../provider.js";
import { requireUser } from "../auth.js";
import * as ai from "../ai.js";
import { NARRATOR } from "../prompt.js";
import { parseCommand, splitName, COMMANDS } from "../commands.js";

export const aiRoutes = Router();
aiRoutes.use(requireUser);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const needKey = (req, res) => {
  const s = settings(req.user);
  if (hasCredentials(s)) return false;
  res.status(400).json({ error: `No API key for ${s.provider === "xai" ? "xAI (Grok)" : "Anthropic (Claude)"}. Add one in Settings.`, code: "no_key" });
  return true;
};

/** Server-Sent Events over a POST body, with keep-alive pings. */
function sse(res) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  const emit = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  const ping = setInterval(() => { if (!res.writableEnded) res.write(": ping\n\n"); }, 15000);
  const end = () => { clearInterval(ping); if (!res.writableEnded) res.end(); };
  return { emit, end };
}

const abortOnClose = (req, res) => {
  const ac = new AbortController();
  res.on("close", () => { if (!res.writableFinished) ac.abort(); });
  return ac.signal;
};

// POST /api/ai/chats/:id/reply  { text?, mode?: reply|regen|continue, target_message_id?, instruction?, kind?, speaker? }
// A text starting with "/" is a typed command (see ../commands.js) and is handled by runCommand.
aiRoutes.post("/chats/:id/reply", wrap(async (req, res) => {
  if (needKey(req, res)) return;
  const chat = db.chats.get(req.params.id, req.user.id);
  if (!chat) return res.status(404).json({ error: "Roleplay not found" });
  let { text, mode = "reply", target_message_id = null, instruction = null, kind, speaker = null } = req.body || {};
  const cmd = mode === "reply" ? parseCommand(text) : null;
  if (cmd?.cmd === "ooc") text = `(OOC: ${cmd.arg})`;
  else if (cmd) return runCommand(req, res, chat, cmd);
  let userMessage = null;
  if (mode === "reply" && text && text.trim()) userMessage = db.messages.add(chat.id, { role: "user", text: text.trim(), kind });
  const { emit, end } = sse(res);
  if (userMessage) emit("user_message", { message: userMessage });
  try { await ai.runTurn({ chatId: chat.id, user: req.user, emit, signal: abortOnClose(req, res), mode, targetMessageId: target_message_id, instruction, speakerName: speaker }); }
  catch (e) { console.error("[reply]", e); emit("error", { error: describeError(e) }); }
  finally { end(); }
}));

/** Save a stage direction as a bracketed user line, then run the turn with it as a hard instruction. */
async function runDirection(req, res, chat, { direction, speaker = null, before = null }) {
  const m = db.messages.add(chat.id, { role: "user", text: direction, kind: "direction" });
  const { emit, end } = sse(res);
  before?.(emit);
  emit("user_message", { message: m });
  const instruction = `Stage direction from the user for this reply. Make it happen now, in the story's tone; do not skip, delay, or refuse it: ${direction}`;
  try { await ai.runTurn({ chatId: chat.id, user: req.user, emit, signal: abortOnClose(req, res), instruction, speakerName: speaker }); }
  catch (e) { emit("error", { error: describeError(e) }); }
  finally { end(); }
}
const narrated = (kind) => (kind === "narrate" || kind === "time" || kind === "scene" ? "Narrator" : null);

// Narrator tools: time skip / twist / scene change / narration
aiRoutes.post("/chats/:id/direct", wrap(async (req, res) => {
  if (needKey(req, res)) return;
  const chat = db.chats.get(req.params.id, req.user.id);
  if (!chat) return res.status(404).json({ error: "Roleplay not found" });
  const { kind, detail } = req.body || {};
  const direction = ai.narratorDirection(kind, detail);
  if (!direction) return res.status(400).json({ error: "kind required" });
  return runDirection(req, res, chat, { direction, speaker: narrated(kind) });
}));

aiRoutes.get("/commands", (req, res) => res.json({ commands: COMMANDS }));

// Typed commands from the composer. Exact name first, then prefix ("Jess" -> "Jessica Hale").
const findCast = (cast, name) => {
  const n = (name || "").trim().toLowerCase();
  return n ? cast.find((m) => m.name.toLowerCase() === n) || cast.find((m) => m.name.toLowerCase().startsWith(n)) : null;
};
async function runCommand(req, res, chat, { cmd, name, arg }) {
  const bad = (error) => res.status(400).json({ error, commands: COMMANDS });
  const userId = req.user.id;
  const cast = ai.stripCast(ai.resolveCast(chat, userId));
  const castEvent = (emit, newcomer = null) => emit("cast", { cast: ai.stripCast(ai.resolveCast(db.chats.get(chat.id, userId), userId)), newcomer });
  const plain = async (fn) => { const { emit, end } = sse(res); try { await fn(emit); } catch (e) { emit("error", { error: describeError(e) }); } finally { end(); } };
  switch (cmd) {
    case "help": return bad("Type a command, e.g. /force She kisses you. Commands: " + COMMANDS.map((c) => c.usage.split(" ")[0]).join(" "));
    case "unknown": return bad(`Unknown command /${name}. Type /help for the list.`);
    case "force": case "narrate": case "time": case "scene": case "twist": {
      const kind = cmd === "twist" ? "event" : cmd;
      if (!arg && kind !== "event") return bad(`Usage: /${cmd} <what happens>`);
      return runDirection(req, res, chat, { direction: ai.narratorDirection(kind, arg), speaker: narrated(kind) });
    }
    case "steer":
      if (!arg) return bad("Usage: /steer <instruction for the next reply>");
      return plain((emit) => ai.runTurn({ chatId: chat.id, user: req.user, emit, signal: abortOnClose(req, res), instruction: arg }));
    case "enter": {
      const { name: who, rest } = splitName(arg);
      if (!who) return bad("Usage: /enter <Name>: <who they are>");
      let m = findCast(cast, who), newcomer = null;
      if (m) m.status = "present";
      else {
        const known = db.characters.list(userId).find((c) => c.name.toLowerCase() === who.toLowerCase());
        m = known ? { character_id: known.id, name: known.name, status: "present", role: "supporting" }
          : { character_id: null, name: who, status: "present", role: "guest", generated: true, brief: rest, avatar: "✨", color: "#f59e0b" };
        cast.push(m); newcomer = m;
      }
      db.chats.update(chat.id, { cast, narrator_enabled: true }, { touch: false, userId });
      const direction = `Narrator: ${m.name} enters the scene right now${rest ? ` (${rest})` : ""}. Introduce them and let them act.`;
      return runDirection(req, res, chat, { direction, speaker: "Narrator", before: (emit) => castEvent(emit, newcomer) });
    }
    case "leave": {
      const m = findCast(cast, arg);
      if (!m) return bad(arg ? `Nobody called "${arg}" is in the cast.` : "Usage: /leave <Name>");
      m.status = "gone";
      db.chats.update(chat.id, { cast }, { touch: false, userId });
      return runDirection(req, res, chat, { direction: `Narrator: ${m.name} leaves the scene now and is gone from the story.`, speaker: "Narrator", before: castEvent });
    }
    case "say": {
      const { name: who, rest } = splitName(arg);
      if (!who || !rest) return bad("Usage: /say <Name>: <their line>   (or /say Narrator: <text>)");
      const isN = who.toLowerCase() === "narrator";
      const m = isN ? null : findCast(cast, who);
      if (!isN && !m) return bad(`Nobody called "${who}" is in the cast. Use /enter ${who} first.`);
      const full = isN ? NARRATOR : ai.resolveCast(chat, userId).find((x) => x.name === m.name);
      const speaker = { name: full.name, kind: full.kind, character_id: full.character_id || null, avatar: full.avatar, color: full.color };
      const saved = db.messages.add(chat.id, { role: "assistant", text: rest, speaker });
      return plain((emit) => { emit("speaker", speaker); emit("done", { message: saved }); });
    }
    case "note": {
      const note = /^(off|clear|none|-)?$/i.test(arg) ? "" : arg;
      db.chats.update(chat.id, { director_note: note }, { touch: false, userId });
      return plain((emit) => emit("note", { director_note: note }));
    }
    default: return bad("Unknown command. Type /help for the list.");
  }
}

/** Long-running jobs answer over SSE too (status/result/error) so proxies never cut them. */
const job = (fn) => wrap(async (req, res) => {
  if (needKey(req, res)) return;
  let ready;
  try { ready = await fn.validate?.(req); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const { emit, end } = sse(res);
  try { emit("result", await fn(req, emit, ready)); }
  catch (e) { console.error("[job]", e); emit("error", { error: describeError(e) }); }
  finally { end(); }
});
const bad = (message) => Object.assign(new Error(message), { status: 400 });
const S = (req) => settings(req.user);

aiRoutes.post("/chats/:id/suggest", job(async (req) => ({ suggestions: await ai.suggestActions(req.params.id, req.user) })));
aiRoutes.post("/chats/:id/impersonate", job(async (req) => ({ text: await ai.impersonate(req.params.id, req.user, req.body?.hint) })));
aiRoutes.post("/chats/:id/summarize", job(async (req, emit) => {
  const ctx = ai.loadChatContext(req.params.id, req.user);
  ctx.s.contextBudget = 0;
  const summary = await ai.maybeSummarize({ ...ctx, s: { ...ctx.s, autoSummarize: true } }, emit);
  return { summary: summary ?? ctx.chat.summary, chat: db.chats.get(req.params.id, req.user.id) };
}));
aiRoutes.post("/chats/:id/refresh-state", job(async (req, emit) => {
  const ctx = ai.loadChatContext(req.params.id, req.user);
  const msgs = ctx.history;
  const lastA = [...msgs].reverse().find((m) => m.role === "assistant");
  const lastU = [...msgs].reverse().find((m) => m.role === "user" && (!lastA || m.seq < lastA.seq));
  const t = (m) => (m ? m.alternatives?.[m.active ?? 0] ?? "" : "");
  const r = await ai.extractState({ ...ctx, s: { ...ctx.s, autoState: true } }, t(lastU), `${lastA?.speaker?.name || ctx.cast[0]?.name || "Narrator"}: ${t(lastA) || "(no reply yet)"}`, emit);
  return { state: r.state, memory: r.memory, timeline: db.timeline.list(req.params.id), cast: ai.stripCast(ctx.cast) };
}));
aiRoutes.post("/chats/:id/title", job(async (req) => ({ title: await ai.autoTitle(req.params.id, req.user) })));

// Promote a generated newcomer / bystander into a full character (saved to the library and linked in the cast).
aiRoutes.post("/chats/:id/cast/:name/promote", job(async (req, emit) => {
  const ctx = ai.loadChatContext(req.params.id, req.user);
  const m = ctx.cast.find((x) => x.name.toLowerCase() === req.params.name.toLowerCase());
  const npc = m || (ctx.chat.state?.present_npcs || []).find((n) => n.name.toLowerCase() === req.params.name.toLowerCase());
  if (!npc) throw Object.assign(new Error("No such newcomer"), { status: 404 });
  emit("status", { text: `Writing a full card for ${npc.name}…` });
  const card = await ai.promoteNpc(ctx.s, { name: npc.name, brief: m?.brief || `${npc.role || ""}. ${npc.disposition || ""}`, context: ctx.chat.summary || ctx.chat.premise || "" });
  const created = db.characters.create({ ...card, name: npc.name }, req.user.id);
  const cast = ai.stripCast(ctx.cast);
  const entry = cast.find((x) => x.name.toLowerCase() === npc.name.toLowerCase());
  if (entry) { entry.character_id = created.id; entry.generated = false; delete entry.brief; entry.avatar = created.avatar; entry.color = created.color; }
  else cast.push({ character_id: created.id, name: created.name, status: "present", role: "supporting" });
  db.chats.update(ctx.chat.id, { cast, narrator_enabled: true }, { touch: false, userId: req.user.id });
  return { character: created, cast };
}));

// Generators
const genCharacter = async (req, emit) => { emit("status", { text: "Designing the character…" }); return ai.generateCharacter(S(req), req.body?.prompt, req.body?.existing); };
genCharacter.validate = (req) => { if (!req.body?.prompt && !req.body?.existing) throw bad("prompt required"); };
aiRoutes.post("/generate/character", job(genCharacter));
const genField = async (req) => ({ text: await ai.enhanceField(S(req), req.body?.character || {}, req.body.field, req.body?.guidance) });
genField.validate = (req) => { if (!req.body?.field) throw bad("field required"); };
aiRoutes.post("/generate/field", job(genField));
const genWorld = async (req, emit) => { emit("status", { text: "Building the world…" }); return ai.generateWorld(S(req), req.body.prompt); };
genWorld.validate = (req) => { if (!req.body?.prompt) throw bad("prompt required"); };
aiRoutes.post("/generate/world", job(genWorld));
const genPremise = async (req, emit) => {
  emit("status", { text: "Drafting the story…" });
  const ids = req.body.character_ids || [];
  const cast = ids.map((id) => db.characters.get(id, req.user.id)).filter(Boolean).map((c) => ({ name: c.name, character: c }));
  const persona = req.body.persona_id ? db.personas.get(req.body.persona_id, req.user.id) : null;
  const world = req.body.world_id ? db.worlds.get(req.body.world_id, req.user.id) : null;
  return ai.generatePremise(S(req), { cast, persona, world, idea: req.body.idea });
};
genPremise.validate = (req) => { if (!Array.isArray(req.body?.character_ids) || !req.body.character_ids.length) throw bad("character_ids required"); };
aiRoutes.post("/generate/premise", job(genPremise));
