// REST API: settings, characters, personas, worlds, chats, messages, timeline, search, import/export.
import { Router } from "express";
import * as db from "../db.js";
import { DEFAULTS, settings } from "../claude.js";
import { PROVIDERS, modelsFor, liveModels, hasCredentials } from "../provider.js";

export const api = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const notFound = (res) => res.status(404).json({ error: "Not found" });

// ---------- settings ----------
const mask = (k) => (k ? k.slice(0, 10) + "…" + k.slice(-4) : "");
api.get("/settings", (req, res) => {
  const s = settings();
  const key = db.getSetting("apiKey");
  const xaiKey = db.getSetting("xaiKey");
  res.json({
    settings: s,
    defaults: DEFAULTS,
    providers: PROVIDERS,
    models: modelsFor(s.provider),
    modelsByProvider: { anthropic: modelsFor("anthropic"), xai: modelsFor("xai") },
    hasApiKey: hasCredentials(s.provider),
    credentials: { anthropic: hasCredentials("anthropic"), xai: hasCredentials("xai") },
    apiKeyMasked: key ? mask(key) : (process.env.ANTHROPIC_API_KEY ? "(from environment)" : ""),
    xaiKeyMasked: xaiKey ? mask(xaiKey) : (process.env.XAI_API_KEY ? "(from environment)" : ""),
  });
});
api.put("/settings", (req, res) => {
  const body = req.body || {};
  for (const [k, v] of Object.entries(body)) {
    if (k === "apiKey" || k === "xaiKey" || k === "xaiBaseUrl") {
      if (v === null || v === "") db.db.prepare("DELETE FROM settings WHERE key=?").run(k);
      else db.setSetting(k, String(v).trim());
    } else if (k in DEFAULTS) db.setSetting(k, v);
  }
  const s = settings();
  res.json({ ok: true, settings: s, hasApiKey: hasCredentials(s.provider) });
});
api.get("/providers/:id/models", wrap(async (req, res) => res.json(await liveModels(req.params.id))));

// ---------- generic CRUD ----------
function crud(path, store, { onDelete } = {}) {
  api.get(`/${path}`, (req, res) => res.json(store.list()));
  api.get(`/${path}/:id`, (req, res) => { const d = store.get(req.params.id); d ? res.json(d) : notFound(res); });
  api.post(`/${path}`, (req, res) => res.status(201).json(store.create(req.body || {})));
  api.put(`/${path}/:id`, (req, res) => { const d = store.update(req.params.id, req.body || {}); d ? res.json(d) : notFound(res); });
  api.delete(`/${path}/:id`, (req, res) => { onDelete?.(req.params.id); store.remove(req.params.id) ? res.json({ ok: true }) : notFound(res); });
}
crud("characters", db.characters);
crud("worlds", db.worlds);
crud("personas", db.personas);

api.post("/personas/:id/default", (req, res) => {
  db.db.prepare("UPDATE personas SET is_default=0").run();
  db.db.prepare("UPDATE personas SET is_default=1 WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// Duplicate a character
api.post("/characters/:id/duplicate", (req, res) => {
  const c = db.characters.get(req.params.id);
  if (!c) return notFound(res);
  const { id, created_at, updated_at, ...rest } = c;
  res.status(201).json(db.characters.create({ ...rest, name: `${c.name} (copy)` }));
});

// Import a character card (native JSON or SillyTavern v2 card JSON)
api.post("/characters/import", (req, res) => {
  const raw = req.body || {};
  let card = raw;
  if (raw.spec === "chara_card_v2" || raw.spec === "chara_card_v3") card = fromTavernCard(raw.data || {});
  else if (raw.first_mes || raw.mes_example) card = fromTavernCard(raw);
  const { id, created_at, updated_at, ...rest } = card;
  res.status(201).json(db.characters.create(rest));
});
function fromTavernCard(d) {
  return {
    name: d.name || "Imported",
    tagline: d.creator_notes?.split("\n")[0]?.slice(0, 120) || "",
    description: d.description || "",
    personality: d.personality || "",
    scenario: d.scenario || "",
    greeting: d.first_mes || "",
    alt_greetings: d.alternate_greetings || [],
    example_dialogue: (d.mes_example || "").replaceAll("<START>", "").trim(),
    tags: d.tags || [],
    avatar: "🎭",
    color: "#8b5cf6",
    system_prompt_extra: d.system_prompt || "",
  };
}
api.get("/characters/:id/export", (req, res) => {
  const c = db.characters.get(req.params.id);
  if (!c) return notFound(res);
  const { id, created_at, updated_at, ...rest } = c;
  res.setHeader("Content-Disposition", `attachment; filename="${c.name.replace(/[^\w.-]+/g, "_")}.json"`);
  res.json({ format: "tavern-ai-character-v1", ...rest });
});

// ---------- chats ----------
api.get("/chats", (req, res) => res.json(db.chats.list()));
api.post("/chats", (req, res) => {
  const b = req.body || {};
  const character = b.character_id ? db.characters.get(b.character_id) : null;
  const defaultPersona = db.personas.list().find((p) => p.is_default) || db.personas.list()[0];
  const persona = b.persona_id ? db.personas.get(b.persona_id) : defaultPersona;
  const chat = db.chats.create({
    title: b.title || (character ? `Chat with ${character.name}` : "New chat"),
    character_id: character?.id || null,
    persona_id: persona?.id || null,
    world_id: b.world_id || character?.world_id || null,
    mode: b.mode || "character",
    scenario: b.scenario || "",
    settings: b.settings || {},
    state: null, memory: [], summary: "", summary_seq: -1, director_note: "",
  });
  // Opening message
  const greetings = [character?.greeting, ...(character?.alt_greetings || [])].filter((g) => g && g.trim());
  let greeting = null;
  if (b.greeting_index != null && greetings[b.greeting_index]) greeting = greetings[b.greeting_index];
  else if (greetings.length) greeting = greetings[0];
  if (greeting && b.skip_greeting !== true) {
    const charName = character?.name || "Narrator";
    const userName = persona?.name || "you";
    const txt = greeting.replaceAll("{{char}}", charName).replaceAll("{{user}}", userName);
    db.messages.add(chat.id, { role: "assistant", text: txt, alternatives: greetings.map((g) => g.replaceAll("{{char}}", charName).replaceAll("{{user}}", userName)), active: Math.max(0, greetings.indexOf(greeting)), is_greeting: true });
  }
  res.status(201).json(db.chats.get(chat.id));
});
api.get("/chats/:id", (req, res) => {
  const chat = db.chats.get(req.params.id);
  if (!chat) return notFound(res);
  res.json({
    chat,
    messages: db.messages.list(chat.id),
    timeline: db.timeline.list(chat.id),
    character: chat.character_id ? db.characters.get(chat.character_id) : null,
    persona: chat.persona_id ? db.personas.get(chat.persona_id) : null,
    world: chat.world_id ? db.worlds.get(chat.world_id) : null,
  });
});
api.put("/chats/:id", (req, res) => {
  const allowed = ["title", "persona_id", "world_id", "pinned", "settings", "director_note", "memory", "state", "summary", "summary_seq", "scenario", "mode"];
  const patch = {};
  for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
  const c = db.chats.update(req.params.id, patch, { touch: false });
  c ? res.json(c) : notFound(res);
});
api.delete("/chats/:id", (req, res) => (db.chats.remove(req.params.id) ? res.json({ ok: true }) : notFound(res)));

// Branch: copy chat + messages up to (and including) a message
api.post("/chats/:id/branch", (req, res) => {
  const chat = db.chats.get(req.params.id);
  if (!chat) return notFound(res);
  const upto = req.body?.message_id ? db.messages.get(req.body.message_id) : null;
  const msgs = db.messages.list(chat.id).filter((m) => !upto || m.seq <= upto.seq);
  const { id, created_at, updated_at, message_count, preview, ...rest } = chat;
  const nc = db.transaction(() => {
    const created = db.chats.create({ ...rest, title: `${chat.title} (branch)` });
    // Keep summary only if it covers messages we copied.
    if ((chat.summary_seq ?? -1) > (upto?.seq ?? 1e9)) db.chats.update(created.id, { summary: "", summary_seq: -1 }, { touch: false });
    for (const m of msgs) {
      const { id: _i, chat_id, seq, created_at: _c, role, ...data } = m;
      db.messages.add(created.id, { role, text: data.alternatives?.[data.active ?? 0] ?? "", ...data });
    }
    for (const t of db.timeline.list(chat.id)) {
      if (!upto || !t.message_id || msgs.some((m) => m.id === t.message_id)) db.timeline.add(created.id, { kind: t.kind, text: t.text, data: t.data });
    }
    return db.chats.get(created.id);
  });
  res.status(201).json(nc);
});

// Reset memory/state/summary for a chat
api.post("/chats/:id/reset-memory", (req, res) => {
  const c = db.chats.update(req.params.id, { state: null, memory: [], summary: "", summary_seq: -1 }, { touch: false });
  if (!c) return notFound(res);
  db.timeline.clear(c.id);
  res.json(c);
});

api.get("/chats/:id/export", (req, res) => {
  const chat = db.chats.get(req.params.id);
  if (!chat) return notFound(res);
  const messages = db.messages.list(chat.id);
  const character = chat.character_id ? db.characters.get(chat.character_id) : null;
  const persona = chat.persona_id ? db.personas.get(chat.persona_id) : null;
  if (req.query.format === "md") {
    const lines = [`# ${chat.title}`, ""];
    for (const m of messages) {
      const who = m.role === "assistant" ? (character?.name || "Narrator") : (persona?.name || "You");
      lines.push(`**${who}:** ${m.alternatives?.[m.active ?? 0] ?? ""}`, "");
    }
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${chat.title.replace(/[^\w.-]+/g, "_")}.md"`);
    return res.send(lines.join("\n"));
  }
  res.setHeader("Content-Disposition", `attachment; filename="${chat.title.replace(/[^\w.-]+/g, "_")}.json"`);
  res.json({ format: "tavern-ai-chat-v1", chat, messages, timeline: db.timeline.list(chat.id), character, persona });
});

// ---------- messages ----------
api.post("/chats/:id/messages", (req, res) => {
  const chat = db.chats.get(req.params.id);
  if (!chat) return notFound(res);
  const { role = "user", text, kind, hidden } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: "text required" });
  res.status(201).json(db.messages.add(chat.id, { role, text: text.trim(), kind, hidden: !!hidden }));
});
api.put("/messages/:id", (req, res) => {
  const m = db.messages.get(req.params.id);
  if (!m) return notFound(res);
  const patch = {};
  if (typeof req.body?.text === "string") {
    const alts = [...(m.alternatives || [""])];
    alts[m.active ?? 0] = req.body.text;
    patch.alternatives = alts;
    patch.edited = true;
  }
  if (typeof req.body?.active === "number") patch.active = Math.max(0, Math.min(req.body.active, (m.alternatives || []).length - 1));
  if (typeof req.body?.hidden === "boolean") patch.hidden = req.body.hidden;
  if (typeof req.body?.bookmark === "boolean") patch.bookmark = req.body.bookmark;
  res.json(db.messages.update(m.id, patch));
});
api.delete("/messages/:id", (req, res) => {
  const m = db.messages.get(req.params.id);
  if (!m) return notFound(res);
  const cascade = req.query.cascade === "1";
  db.transaction(() => {
    const ids = cascade ? db.messages.list(m.chat_id).filter((x) => x.seq >= m.seq).map((x) => x.id) : [m.id];
    db.timeline.removeForMessages(m.chat_id, ids);
    if (cascade) db.messages.removeAfter(m.chat_id, m.seq - 1);
    else db.messages.remove(m.id);
    // If the summary covered deleted messages, drop it so continuity is rebuilt.
    const chat = db.chats.get(m.chat_id);
    if ((chat.summary_seq ?? -1) >= m.seq) db.chats.update(chat.id, { summary: "", summary_seq: -1 }, { touch: false });
  });
  res.json({ ok: true });
});

// ---------- timeline / memory ----------
api.post("/chats/:id/timeline", (req, res) => {
  const { kind = "note", text } = req.body || {};
  if (!text) return res.status(400).json({ error: "text required" });
  db.timeline.add(req.params.id, { kind, text });
  res.json(db.timeline.list(req.params.id));
});
api.delete("/timeline/:id", (req, res) => { db.db.prepare("DELETE FROM timeline WHERE id=?").run(req.params.id); res.json({ ok: true }); });

// ---------- search ----------
api.get("/search", (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json([]);
  res.json(db.messages.search(q));
});

// ---------- stats ----------
api.get("/stats", (req, res) => {
  const count = (t) => db.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  res.json({ characters: count("characters"), personas: count("personas"), worlds: count("worlds"), chats: count("chats"), messages: count("messages") });
});
