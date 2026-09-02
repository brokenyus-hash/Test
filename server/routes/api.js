// REST API: auth, per-user settings, characters, personas, worlds, roleplays (+cast), messages, timeline, search.
import { Router } from "express";
import * as db from "../db.js";
import { DEFAULTS, SECRET_KEYS, settings } from "../claude.js";
import { PROVIDERS, modelsFor, liveModels, hasCredentials } from "../provider.js";
import { hashPassword, verifyPassword, validUsername, validPassword, issueSession, clearSession, requireUser, throttle, publicUser, signupAllowed } from "../auth.js";
import { resolveCast, stripCast } from "../ai.js";

export const api = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const notFound = (res) => res.status(404).json({ error: "Not found" });

// ---------- auth (public) ----------
api.get("/auth/me", (req, res) => res.json({ user: publicUser(req.user), signupAllowed: signupAllowed() }));
api.post("/auth/register", throttle, (req, res) => {
  const { username, password } = req.body || {};
  if (!signupAllowed()) return res.status(403).json({ error: "Sign-ups are closed on this server." });
  if (!validUsername(username)) return res.status(400).json({ error: "Username: 2-32 letters, numbers, . _ or -" });
  if (!validPassword(password)) return res.status(400).json({ error: "Password must be at least 6 characters." });
  if (db.users.byName(username)) return res.status(409).json({ error: "That username is taken." });
  const { salt, hash } = hashPassword(password);
  const u = db.users.create({ username, password_hash: hash, salt, is_admin: db.users.count() === 0 ? 1 : 0 });
  db.personas.create({ name: username, description: "", avatar: "🙂", color: "#60a5fa", is_default: 1 }, u.id);
  issueSession(res, req, u.id);
  res.status(201).json({ user: publicUser(u) });
});
api.post("/auth/login", throttle, (req, res) => {
  const { username, password } = req.body || {};
  const u = username && db.users.byName(String(username));
  if (!u || !verifyPassword(String(password || ""), u.salt, u.password_hash)) return res.status(401).json({ error: "Wrong username or password." });
  issueSession(res, req, u.id);
  res.json({ user: publicUser(u) });
});
api.post("/auth/logout", (req, res) => { clearSession(res, req); res.json({ ok: true }); });
api.post("/auth/password", requireUser, (req, res) => {
  const { current, next } = req.body || {};
  if (!verifyPassword(String(current || ""), req.user.salt, req.user.password_hash)) return res.status(401).json({ error: "Current password is wrong." });
  if (!validPassword(next)) return res.status(400).json({ error: "New password must be at least 6 characters." });
  const { salt, hash } = hashPassword(next);
  db.users.setPassword(req.user.id, hash, salt);
  db.sessions.removeAllFor(req.user.id);
  issueSession(res, req, req.user.id);
  res.json({ ok: true });
});

// Everything below needs a signed-in user.
api.use(requireUser);
const U = (req) => req.user.id;

// ---------- settings (per user) ----------
const mask = (k) => (k ? k.slice(0, 10) + "…" + k.slice(-4) : "");
api.get("/settings", (req, res) => {
  const s = settings(req.user);
  const us = req.user.settings || {};
  const { anthropicKey, xaiKey, ...safe } = s;
  res.json({
    settings: safe, defaults: DEFAULTS, providers: PROVIDERS,
    models: modelsFor(s.provider), modelsByProvider: { anthropic: modelsFor("anthropic"), xai: modelsFor("xai") },
    hasApiKey: hasCredentials(s),
    credentials: { anthropic: hasCredentials(s, "anthropic"), xai: hasCredentials(s, "xai") },
    apiKeyMasked: us.apiKey ? mask(us.apiKey) : (s.anthropicKeySource === "env" ? "(server key)" : ""),
    xaiKeyMasked: us.xaiKey ? mask(us.xaiKey) : (s.xaiKeySource === "env" ? "(server key)" : ""),
  });
});
api.put("/settings", (req, res) => {
  const patch = {};
  for (const [k, v] of Object.entries(req.body || {})) {
    if (SECRET_KEYS.includes(k)) patch[k] = v == null ? "" : String(v).trim();
    else if (k in DEFAULTS) patch[k] = v;
  }
  const u = db.users.updateSettings(U(req), patch);
  const s = settings(u);
  res.json({ ok: true, hasApiKey: hasCredentials(s) });
});
api.get("/providers/:id/models", wrap(async (req, res) => res.json(await liveModels(settings(req.user), req.params.id))));

// ---------- generic CRUD ----------
function crud(path, store) {
  api.get(`/${path}`, (req, res) => res.json(store.list(U(req))));
  api.get(`/${path}/:id`, (req, res) => { const d = store.get(req.params.id, U(req)); d ? res.json(d) : notFound(res); });
  api.post(`/${path}`, (req, res) => res.status(201).json(store.create(req.body || {}, U(req))));
  api.put(`/${path}/:id`, (req, res) => { const d = store.update(req.params.id, req.body || {}, U(req)); d ? res.json(d) : notFound(res); });
  api.delete(`/${path}/:id`, (req, res) => (store.remove(req.params.id, U(req)) ? res.json({ ok: true }) : notFound(res)));
}
crud("characters", db.characters);
crud("worlds", db.worlds);
crud("personas", db.personas);

api.post("/personas/:id/default", (req, res) => {
  if (!db.personas.get(req.params.id, U(req))) return notFound(res);
  db.db.prepare("UPDATE personas SET is_default=0 WHERE user_id=?").run(U(req));
  db.db.prepare("UPDATE personas SET is_default=1 WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});
api.post("/characters/:id/duplicate", (req, res) => {
  const c = db.characters.get(req.params.id, U(req));
  if (!c) return notFound(res);
  const { id, user_id, created_at, updated_at, ...rest } = c;
  res.status(201).json(db.characters.create({ ...rest, name: `${c.name} (copy)` }, U(req)));
});
api.post("/characters/import", (req, res) => {
  const raw = req.body || {};
  let card = raw;
  if (raw.spec === "chara_card_v2" || raw.spec === "chara_card_v3") card = fromTavernCard(raw.data || {});
  else if (raw.first_mes || raw.mes_example) card = fromTavernCard(raw);
  const { id, user_id, created_at, updated_at, ...rest } = card;
  res.status(201).json(db.characters.create(rest, U(req)));
});
function fromTavernCard(d) {
  return {
    name: d.name || "Imported", tagline: d.creator_notes?.split("\n")[0]?.slice(0, 120) || "", description: d.description || "",
    personality: d.personality || "", scenario: d.scenario || "", greeting: d.first_mes || "", alt_greetings: d.alternate_greetings || [],
    example_dialogue: (d.mes_example || "").replaceAll("<START>", "").trim(), tags: d.tags || [], avatar: "🎭", color: "#8b5cf6",
  };
}
api.get("/characters/:id/export", (req, res) => {
  const c = db.characters.get(req.params.id, U(req));
  if (!c) return notFound(res);
  const { id, user_id, created_at, updated_at, ...rest } = c;
  res.setHeader("Content-Disposition", `attachment; filename="${c.name.replace(/[^\w.-]+/g, "_")}.json"`);
  res.json({ format: "tavern-ai-character-v1", ...rest });
});

// ---------- roleplays ----------
const subName = (t, cast, persona) => (t || "").replaceAll("{{char}}", cast[0]?.name || "").replaceAll("{{user}}", persona?.name || "you");

api.get("/chats", (req, res) => {
  const rows = db.chats.list(U(req));
  for (const c of rows) c.cast = stripCast(resolveCast(c, U(req)));
  res.json(rows);
});
api.post("/chats", (req, res) => {
  const b = req.body || {};
  const ids = Array.isArray(b.character_ids) ? b.character_ids : (b.character_id ? [b.character_id] : []);
  const chars = ids.map((id) => db.characters.get(id, U(req))).filter(Boolean);
  const defaultPersona = db.personas.list(U(req)).find((p) => p.is_default) || db.personas.list(U(req))[0];
  const persona = (b.persona_id && db.personas.get(b.persona_id, U(req))) || defaultPersona;
  const cast = chars.map((c, i) => ({ character_id: c.id, name: c.name, status: "present", role: i === 0 ? "lead" : "supporting" }));
  const ensemble = cast.length > 1 || !!b.narrator_enabled;
  const chat = db.chats.create({
    title: b.title || (chars.length > 1 ? `Story with ${chars.map((c) => c.name).join(" & ")}` : chars[0] ? `Chat with ${chars[0].name}` : "New roleplay"),
    character_id: chars[0]?.id || null, persona_id: persona?.id || null,
    world_id: b.world_id || chars.find((c) => c.world_id)?.world_id || null,
    cast, narrator_enabled: ensemble, premise: b.premise || "", settings: b.settings || {},
    state: null, memory: [], summary: "", summary_seq: -1, director_note: "",
  }, U(req));
  // Opening: custom opening text, else the lead character's greeting.
  const lead = chars[0];
  const greetings = [lead?.greeting, ...(lead?.alt_greetings || [])].filter((g) => g && g.trim());
  let opening = null, speaker = null;
  if (b.opening && b.opening.trim()) { opening = b.opening.trim(); speaker = { name: "Narrator", kind: "narrator", avatar: "📜", color: "#475569" }; }
  else if (greetings.length && b.skip_greeting !== true) {
    const idx = b.greeting_index != null && greetings[b.greeting_index] ? b.greeting_index : 0;
    opening = greetings[idx]; speaker = { name: lead.name, kind: "character", character_id: lead.id, avatar: lead.avatar, color: lead.color };
  }
  if (opening) {
    const alts = speaker.kind === "narrator" ? [subName(opening, cast, persona)] : greetings.map((g) => subName(g, cast, persona));
    db.messages.add(chat.id, { role: "assistant", text: subName(opening, cast, persona), alternatives: alts, active: Math.max(0, alts.indexOf(subName(opening, cast, persona))), is_greeting: true, speaker });
  }
  res.status(201).json(db.chats.get(chat.id, U(req)));
});
api.get("/chats/:id", (req, res) => {
  const chat = db.chats.get(req.params.id, U(req));
  if (!chat) return notFound(res);
  const cast = resolveCast(chat, U(req));
  res.json({
    chat: { ...chat, cast: stripCast(cast) },
    cast: cast.map(({ character, ...m }) => ({ ...m, tagline: character?.tagline || m.brief || "" })),
    messages: db.messages.list(chat.id), timeline: db.timeline.list(chat.id),
    character: cast[0]?.character || null,
    persona: chat.persona_id ? db.personas.get(chat.persona_id, U(req)) : null,
    world: chat.world_id ? db.worlds.get(chat.world_id, U(req)) : null,
  });
});
api.put("/chats/:id", (req, res) => {
  const allowed = ["title", "persona_id", "world_id", "pinned", "settings", "director_note", "memory", "state", "summary", "summary_seq", "premise", "narrator_enabled", "cast"];
  const patch = {};
  for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
  const c = db.chats.update(req.params.id, patch, { touch: false, userId: U(req) });
  c ? res.json(c) : notFound(res);
});
api.delete("/chats/:id", (req, res) => (db.chats.remove(req.params.id, U(req)) ? res.json({ ok: true }) : notFound(res)));

// Cast management
api.post("/chats/:id/cast", (req, res) => {
  const chat = db.chats.get(req.params.id, U(req));
  if (!chat) return notFound(res);
  const cast = stripCast(resolveCast(chat, U(req)));
  const b = req.body || {};
  let entry;
  if (b.character_id) {
    const c = db.characters.get(b.character_id, U(req));
    if (!c) return res.status(400).json({ error: "Character not found" });
    if (cast.some((m) => m.character_id === c.id)) return res.status(409).json({ error: `${c.name} is already in the story` });
    entry = { character_id: c.id, name: c.name, status: b.status || "nearby", role: "supporting" };
  } else if (b.name) {
    if (cast.some((m) => m.name.toLowerCase() === b.name.toLowerCase())) return res.status(409).json({ error: "Name already in cast" });
    entry = { character_id: null, name: b.name.trim(), status: b.status || "nearby", role: "guest", generated: true, brief: b.brief || "", avatar: b.avatar || "✨", color: b.color || "#f59e0b" };
  } else return res.status(400).json({ error: "character_id or name required" });
  cast.push(entry);
  db.chats.update(chat.id, { cast, narrator_enabled: true }, { touch: false, userId: U(req) });
  res.status(201).json({ cast: stripCast(resolveCast(db.chats.get(chat.id, U(req)), U(req))) });
});
api.put("/chats/:id/cast/:name", (req, res) => {
  const chat = db.chats.get(req.params.id, U(req));
  if (!chat) return notFound(res);
  const cast = stripCast(resolveCast(chat, U(req)));
  const m = cast.find((x) => x.name.toLowerCase() === req.params.name.toLowerCase());
  if (!m) return notFound(res);
  const b = req.body || {};
  if (b.status) m.status = b.status;
  if (b.role) m.role = b.role;
  if (b.character_id) { const c = db.characters.get(b.character_id, U(req)); if (c) { m.character_id = c.id; m.generated = false; m.name = c.name; delete m.brief; } }
  if (typeof b.notes === "string") m.notes = b.notes;
  db.chats.update(chat.id, { cast }, { touch: false, userId: U(req) });
  res.json({ cast });
});
api.delete("/chats/:id/cast/:name", (req, res) => {
  const chat = db.chats.get(req.params.id, U(req));
  if (!chat) return notFound(res);
  const cast = stripCast(resolveCast(chat, U(req))).filter((x) => x.name.toLowerCase() !== req.params.name.toLowerCase());
  db.chats.update(chat.id, { cast, character_id: cast[0]?.character_id || chat.character_id }, { touch: false, userId: U(req) });
  res.json({ cast });
});

api.post("/chats/:id/branch", (req, res) => {
  const chat = db.chats.get(req.params.id, U(req));
  if (!chat) return notFound(res);
  const upto = req.body?.message_id ? db.messages.get(req.body.message_id) : null;
  const msgs = db.messages.list(chat.id).filter((m) => !upto || m.seq <= upto.seq);
  const { id, user_id, created_at, updated_at, message_count, preview, preview_speaker, ...rest } = chat;
  const nc = db.transaction(() => {
    const created = db.chats.create({ ...rest, title: `${chat.title} (branch)` }, U(req));
    if ((chat.summary_seq ?? -1) > (upto?.seq ?? 1e9)) db.chats.update(created.id, { summary: "", summary_seq: -1 }, { touch: false });
    for (const m of msgs) { const { id: _i, chat_id, seq, created_at: _c, role, ...data } = m; db.messages.add(created.id, { role, text: data.alternatives?.[data.active ?? 0] ?? "", ...data }); }
    for (const t of db.timeline.list(chat.id)) if (!upto || !t.message_id || msgs.some((m) => m.id === t.message_id)) db.timeline.add(created.id, { kind: t.kind, text: t.text, data: t.data });
    return db.chats.get(created.id, U(req));
  });
  res.status(201).json(nc);
});
api.post("/chats/:id/reset-memory", (req, res) => {
  const c = db.chats.update(req.params.id, { state: null, memory: [], summary: "", summary_seq: -1 }, { touch: false, userId: U(req) });
  if (!c) return notFound(res);
  db.timeline.clear(c.id);
  res.json(c);
});
api.get("/chats/:id/export", (req, res) => {
  const chat = db.chats.get(req.params.id, U(req));
  if (!chat) return notFound(res);
  const messages = db.messages.list(chat.id);
  const persona = chat.persona_id ? db.personas.get(chat.persona_id, U(req)) : null;
  const cast = stripCast(resolveCast(chat, U(req)));
  if (req.query.format === "md") {
    const lines = [`# ${chat.title}`, ""];
    for (const m of messages) lines.push(`**${m.role === "assistant" ? (m.speaker?.name || cast[0]?.name || "Narrator") : (persona?.name || "You")}:** ${m.alternatives?.[m.active ?? 0] ?? ""}`, "");
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${chat.title.replace(/[^\w.-]+/g, "_")}.md"`);
    return res.send(lines.join("\n"));
  }
  res.setHeader("Content-Disposition", `attachment; filename="${chat.title.replace(/[^\w.-]+/g, "_")}.json"`);
  res.json({ format: "tavern-ai-roleplay-v2", chat: { ...chat, cast }, messages, timeline: db.timeline.list(chat.id), persona });
});

// ---------- messages ----------
const ownMessage = (req) => { const m = db.messages.get(req.params.id); return m && db.chats.get(m.chat_id, U(req)) ? m : null; };
api.post("/chats/:id/messages", (req, res) => {
  const chat = db.chats.get(req.params.id, U(req));
  if (!chat) return notFound(res);
  const { role = "user", text, kind, hidden } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: "text required" });
  res.status(201).json(db.messages.add(chat.id, { role, text: text.trim(), kind, hidden: !!hidden }));
});
api.put("/messages/:id", (req, res) => {
  const m = ownMessage(req);
  if (!m) return notFound(res);
  const patch = {};
  if (typeof req.body?.text === "string") { const alts = [...(m.alternatives || [""])]; alts[m.active ?? 0] = req.body.text; patch.alternatives = alts; patch.edited = true; }
  if (typeof req.body?.active === "number") patch.active = Math.max(0, Math.min(req.body.active, (m.alternatives || []).length - 1));
  if (typeof req.body?.hidden === "boolean") patch.hidden = req.body.hidden;
  if (typeof req.body?.bookmark === "boolean") patch.bookmark = req.body.bookmark;
  res.json(db.messages.update(m.id, patch));
});
api.delete("/messages/:id", (req, res) => {
  const m = ownMessage(req);
  if (!m) return notFound(res);
  const cascade = req.query.cascade === "1";
  db.transaction(() => {
    const ids = cascade ? db.messages.list(m.chat_id).filter((x) => x.seq >= m.seq).map((x) => x.id) : [m.id];
    db.timeline.removeForMessages(m.chat_id, ids);
    if (cascade) db.messages.removeAfter(m.chat_id, m.seq - 1); else db.messages.remove(m.id);
    const chat = db.chats.get(m.chat_id);
    if ((chat.summary_seq ?? -1) >= m.seq) db.chats.update(chat.id, { summary: "", summary_seq: -1 }, { touch: false });
  });
  res.json({ ok: true });
});

// ---------- timeline / search / stats ----------
api.post("/chats/:id/timeline", (req, res) => {
  if (!db.chats.get(req.params.id, U(req))) return notFound(res);
  const { kind = "note", text } = req.body || {};
  if (!text) return res.status(400).json({ error: "text required" });
  db.timeline.add(req.params.id, { kind, text });
  res.json(db.timeline.list(req.params.id));
});
api.delete("/chats/:id/timeline/:tid", (req, res) => {
  if (!db.chats.get(req.params.id, U(req))) return notFound(res);
  db.timeline.remove(req.params.tid, req.params.id);
  res.json({ ok: true });
});
api.get("/search", (req, res) => {
  const q = String(req.query.q || "").trim();
  res.json(q ? db.messages.search(U(req), q) : []);
});
api.get("/stats", (req, res) => {
  const count = (t) => db.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id=?`).get(U(req)).n;
  res.json({ characters: count("characters"), personas: count("personas"), worlds: count("worlds"), roleplays: count("chats") });
});
