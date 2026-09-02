// Persistence layer: Node's built-in SQLite (node:sqlite), no native deps.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(here, "..", "data");
fs.mkdirSync(dataDir, { recursive: true });
export const dbPath = path.join(dataDir, "tavern.sqlite");
export const db = new DatabaseSync(dbPath);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS personas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS worlds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  character_id TEXT,
  persona_id TEXT,
  world_id TEXT,
  data TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, seq);

CREATE TABLE IF NOT EXISTS timeline (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  message_id TEXT,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  data TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_timeline_chat ON timeline(chat_id, created_at);
`);

export const now = () => Date.now();
export const uid = () => randomUUID();
const J = (s) => (s == null ? null : JSON.parse(s));

// ---------- settings ----------
export function getSetting(key, fallback = null) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? JSON.parse(row.value) : fallback;
}
export function setSetting(key, value) {
  db.prepare(
    "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(key, JSON.stringify(value));
}
export function allSettings() {
  const out = {};
  for (const r of db.prepare("SELECT key,value FROM settings").all()) out[r.key] = JSON.parse(r.value);
  return out;
}

// ---------- generic JSON-document tables ----------
function makeDocStore(table, extraCols = []) {
  const rowToDoc = (r) => {
    if (!r) return null;
    const doc = { ...J(r.data), id: r.id, name: r.name, created_at: r.created_at, updated_at: r.updated_at };
    for (const c of extraCols) doc[c] = r[c];
    return doc;
  };
  return {
    list() {
      return db.prepare(`SELECT * FROM ${table} ORDER BY updated_at DESC`).all().map(rowToDoc);
    },
    get(id) {
      return rowToDoc(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id));
    },
    create(doc) {
      const id = doc.id || uid();
      const t = now();
      const { id: _i, name, created_at, updated_at, ...rest } = doc;
      const extras = {};
      for (const c of extraCols) { extras[c] = rest[c] ?? 0; delete rest[c]; }
      const cols = ["id", "name", "data", "created_at", "updated_at", ...extraCols];
      const vals = [id, name || "Untitled", JSON.stringify(rest), t, t, ...extraCols.map((c) => extras[c])];
      db.prepare(`INSERT INTO ${table}(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})`).run(...vals);
      return this.get(id);
    },
    update(id, patch) {
      const cur = this.get(id);
      if (!cur) return null;
      const merged = { ...cur, ...patch, id, created_at: cur.created_at };
      const { id: _i, name, created_at, updated_at, ...rest } = merged;
      const extras = {};
      for (const c of extraCols) { extras[c] = rest[c] ?? 0; delete rest[c]; }
      const sets = ["name=?", "data=?", "updated_at=?", ...extraCols.map((c) => `${c}=?`)];
      db.prepare(`UPDATE ${table} SET ${sets.join(",")} WHERE id=?`).run(
        name || "Untitled", JSON.stringify(rest), now(), ...extraCols.map((c) => extras[c]), id,
      );
      return this.get(id);
    },
    remove(id) {
      return db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id).changes > 0;
    },
  };
}

export const characters = makeDocStore("characters");
export const personas = makeDocStore("personas", ["is_default"]);
export const worlds = makeDocStore("worlds");

// ---------- chats ----------
const chatRow = (r) => {
  if (!r) return null;
  return {
    ...J(r.data),
    id: r.id, title: r.title, character_id: r.character_id, persona_id: r.persona_id, world_id: r.world_id,
    pinned: !!r.pinned, created_at: r.created_at, updated_at: r.updated_at,
  };
};
export const chats = {
  list() {
    return db
      .prepare(`SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.chat_id=c.id) AS message_count,
               (SELECT data FROM messages m WHERE m.chat_id=c.id ORDER BY seq DESC LIMIT 1) AS last_data
               FROM chats c ORDER BY pinned DESC, updated_at DESC`)
      .all()
      .map((r) => {
        const c = chatRow(r);
        c.message_count = r.message_count;
        const last = J(r.last_data);
        c.preview = last ? (last.alternatives?.[last.active ?? 0] ?? "").slice(0, 140) : "";
        return c;
      });
  },
  get(id) { return chatRow(db.prepare("SELECT * FROM chats WHERE id=?").get(id)); },
  create(doc) {
    const id = doc.id || uid();
    const t = now();
    const { id: _i, title, character_id, persona_id, world_id, pinned, created_at, updated_at, ...rest } = doc;
    db.prepare(`INSERT INTO chats(id,title,character_id,persona_id,world_id,data,pinned,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?)`).run(
      id, title || "New chat", character_id || null, persona_id || null, world_id || null,
      JSON.stringify(rest), pinned ? 1 : 0, t, t,
    );
    return this.get(id);
  },
  update(id, patch, { touch = true } = {}) {
    const cur = this.get(id);
    if (!cur) return null;
    const merged = { ...cur, ...patch };
    const { id: _i, title, character_id, persona_id, world_id, pinned, created_at, updated_at, message_count, preview, ...rest } = merged;
    db.prepare(`UPDATE chats SET title=?,character_id=?,persona_id=?,world_id=?,data=?,pinned=?,updated_at=? WHERE id=?`).run(
      title || "New chat", character_id || null, persona_id || null, world_id || null,
      JSON.stringify(rest), pinned ? 1 : 0, touch ? now() : cur.updated_at, id,
    );
    return this.get(id);
  },
  remove(id) { return db.prepare("DELETE FROM chats WHERE id=?").run(id).changes > 0; },
};

// ---------- messages ----------
const msgRow = (r) => (r ? { ...J(r.data), id: r.id, chat_id: r.chat_id, seq: r.seq, role: r.role, created_at: r.created_at } : null);
export const messages = {
  list(chatId) {
    return db.prepare("SELECT * FROM messages WHERE chat_id=? ORDER BY seq ASC").all(chatId).map(msgRow);
  },
  get(id) { return msgRow(db.prepare("SELECT * FROM messages WHERE id=?").get(id)); },
  nextSeq(chatId) {
    const r = db.prepare("SELECT MAX(seq) AS m FROM messages WHERE chat_id=?").get(chatId);
    return (r?.m ?? -1) + 1;
  },
  add(chatId, { role, text, ...rest }) {
    const id = uid();
    const data = { alternatives: [text ?? ""], active: 0, ...rest };
    db.prepare("INSERT INTO messages(id,chat_id,seq,role,data,created_at) VALUES(?,?,?,?,?,?)").run(
      id, chatId, this.nextSeq(chatId), role, JSON.stringify(data), now(),
    );
    db.prepare("UPDATE chats SET updated_at=? WHERE id=?").run(now(), chatId);
    return this.get(id);
  },
  update(id, patch) {
    const cur = this.get(id);
    if (!cur) return null;
    const { id: _i, chat_id, seq, role, created_at, ...rest } = { ...cur, ...patch };
    db.prepare("UPDATE messages SET data=? WHERE id=?").run(JSON.stringify(rest), id);
    return this.get(id);
  },
  remove(id) { return db.prepare("DELETE FROM messages WHERE id=?").run(id).changes > 0; },
  removeAfter(chatId, seq) {
    return db.prepare("DELETE FROM messages WHERE chat_id=? AND seq>?").run(chatId, seq).changes;
  },
  search(q, limit = 50) {
    return db
      .prepare(`SELECT m.*, c.title AS chat_title FROM messages m JOIN chats c ON c.id=m.chat_id
                WHERE m.data LIKE ? ORDER BY m.created_at DESC LIMIT ?`)
      .all(`%${q.replace(/[%_]/g, "\\$&")}%`, limit)
      .map((r) => ({ ...msgRow(r), chat_title: r.chat_title }));
  },
};

// ---------- timeline ----------
export const timeline = {
  list(chatId) {
    return db.prepare("SELECT * FROM timeline WHERE chat_id=? ORDER BY created_at ASC").all(chatId)
      .map((r) => ({ ...r, data: J(r.data) }));
  },
  add(chatId, { message_id = null, kind, text, data = null }) {
    const id = uid();
    db.prepare("INSERT INTO timeline(id,chat_id,message_id,kind,text,data,created_at) VALUES(?,?,?,?,?,?,?)").run(
      id, chatId, message_id, kind, text, data ? JSON.stringify(data) : null, now(),
    );
    return id;
  },
  removeForMessages(chatId, messageIds) {
    if (!messageIds.length) return 0;
    const q = messageIds.map(() => "?").join(",");
    return db.prepare(`DELETE FROM timeline WHERE chat_id=? AND message_id IN (${q})`).run(chatId, ...messageIds).changes;
  },
  clear(chatId) { return db.prepare("DELETE FROM timeline WHERE chat_id=?").run(chatId).changes; },
};

export const transaction = (fn) => {
  db.exec("BEGIN");
  try { const r = fn(); db.exec("COMMIT"); return r; }
  catch (e) { db.exec("ROLLBACK"); throw e; }
};
