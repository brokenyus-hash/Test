import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMock } from "./mock-anthropic.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tavern-test-"));
process.env.DATA_DIR = tmp;
let mock, server, base;
const j = (r) => r.json();
const get = (u) => fetch(base + u).then(j);
const post = (u, b) => fetch(base + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) }).then(j);
const put = (u, b) => fetch(base + u, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) }).then(j);
const del = (u) => fetch(base + u, { method: "DELETE" }).then(j);

/** Consume an SSE POST into a list of [event, data]. */
async function sse(u, b) {
  const r = await fetch(base + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) });
  const raw = await r.text();
  assert.equal(r.status, 200, raw);
  return raw.split("\n\n").filter((c) => c.startsWith("event:")).map((c) => {
    const ev = c.match(/^event: (.*)$/m)[1];
    const data = JSON.parse(c.match(/^data: (.*)$/m)[1]);
    return [ev, data];
  });
}

before(async () => {
  mock = await startMock();
  process.env.ANTHROPIC_BASE_URL = mock.url;
  const { app } = await import("../server/app.js");
  server = await new Promise((res) => { const s = app.listen(0, "127.0.0.1", () => res(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await mock.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

let charId, personaId, worldId, chatId;

test("settings: defaults, api key masking", async () => {
  const s = await get("/api/settings");
  assert.equal(s.settings.model, "claude-opus-5");
  assert.equal(s.hasApiKey, false);
  const r = await put("/api/settings", { apiKey: "sk-ant-test-1234567890", effort: "high", contextBudget: 24000 });
  assert.equal(r.hasApiKey, true);
  const s2 = await get("/api/settings");
  assert.equal(s2.settings.effort, "high");
  assert.match(s2.apiKeyMasked, /^sk-ant-tes…7890$/);
});

test("characters / personas / worlds CRUD + import/export", async () => {
  const c = await post("/api/characters", { name: "Mira", tagline: "Salt-priest", description: "A priestess of the tide", greeting: "*She turns.* \"You're late, {{user}}.\"", alt_greetings: ["*A different opening for {{user}}.*"], avatar: "🧝‍♀️", color: "#8b5cf6", tags: ["fantasy"] });
  charId = c.id;
  assert.equal(c.name, "Mira");
  const p = await post("/api/personas", { name: "Kael", description: "A smuggler", avatar: "🙂", is_default: 1 });
  personaId = p.id;
  assert.equal((await get("/api/personas"))[0].is_default, 1);
  const w = await post("/api/worlds", { name: "Drowned Kingdom", description: "Tides rule", entries: [
    { name: "Salt priests", keywords: ["priest", "salt"], content: "They trade in memories.", always_on: false, priority: 5 },
    { name: "Core", keywords: [], content: "The tide reveals ruins twice a day.", always_on: true, priority: 0 },
  ] });
  worldId = w.id;
  const upd = await put(`/api/characters/${charId}`, { world_id: worldId, likes: ["rain"] });
  assert.equal(upd.world_id, worldId);
  assert.deepEqual(upd.likes, ["rain"]);
  const dup = await post(`/api/characters/${charId}/duplicate`);
  assert.equal(dup.name, "Mira (copy)");
  await del(`/api/characters/${dup.id}`);
  const exp = await get(`/api/characters/${charId}/export`);
  assert.equal(exp.format, "tavern-ai-character-v1");
  assert.equal(exp.id, undefined);
  const imp = await post("/api/characters/import", { spec: "chara_card_v2", data: { name: "Tavern Import", description: "d", personality: "p", first_mes: "hi {{user}}", mes_example: "<START>\n{{user}}: hey\n{{char}}: yo", tags: ["st"] } });
  assert.equal(imp.name, "Tavern Import");
  assert.equal(imp.greeting, "hi {{user}}");
  assert.equal(imp.example_dialogue.includes("<START>"), false);
  await del(`/api/characters/${imp.id}`);
  assert.equal((await get("/api/characters")).length, 1);
});

test("chat creation substitutes placeholders and honours greeting choice", async () => {
  const chat = await post("/api/chats", { character_id: charId, persona_id: personaId, greeting_index: 1 });
  chatId = chat.id;
  assert.equal(chat.world_id, worldId, "inherits the character's world");
  assert.equal(chat.title, "Chat with Mira");
  const d = await get(`/api/chats/${chatId}`);
  assert.equal(d.messages.length, 1);
  assert.equal(d.messages[0].role, "assistant");
  assert.equal(d.messages[0].active, 1);
  assert.equal(d.messages[0].alternatives[1], "*A different opening for Kael.*");
  assert.equal(d.messages[0].alternatives[0].includes("Kael"), true);
  assert.equal(d.world.name, "Drowned Kingdom");
});

test("reply streams, persists, tracks world state and memory", async () => {
  const before = mock.requests.length;
  const events = await sse(`/api/ai/chats/${chatId}/reply`, { text: "I step inside, shaking rain off my coat. \"I heard the salt priests want to talk.\"" });
  const names = events.map((e) => e[0]);
  assert.ok(names.includes("user_message"));
  assert.ok(names.includes("delta"));
  assert.ok(names.includes("done"));
  assert.ok(names.includes("state"), `expected state event, got ${names.join(",")}`);
  const done = events.find((e) => e[0] === "done")[1];
  assert.match(done.message.alternatives[0], /mock character/);
  assert.equal(done.usage.output, 40);
  assert.ok(done.stats.loreTriggered.includes("Salt priests"), "keyword lore triggered");

  // Inspect what was sent to the API.
  const replyReq = mock.requests.slice(before).find((r) => r.body.stream);
  assert.equal(replyReq.body.model, "claude-opus-5");
  assert.deepEqual(replyReq.body.thinking, { type: "adaptive" });
  assert.equal(replyReq.body.output_config.effort, "high");
  assert.equal(replyReq.body.fallbacks, "default");
  assert.match(replyReq.headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
  const sys = replyReq.body.system[0];
  assert.deepEqual(sys.cache_control, { type: "ephemeral" });
  assert.match(sys.text, /You are Mira/);
  assert.match(sys.text, /Kael/);
  assert.match(sys.text, /The tide reveals ruins twice a day/, "always-on lore in system prompt");
  assert.equal(sys.text.includes("They trade in memories"), false, "triggered lore is NOT in the cached system prompt");
  const msgs = replyReq.body.messages;
  assert.equal(msgs[0].role, "user", "first message must be user");
  const last = msgs[msgs.length - 1];
  assert.equal(last.role, "system", "dynamic context goes in a mid-conversation system message");
  assert.match(last.content, /They trade in memories/);
  const lastUser = [...msgs].reverse().find((m) => m.role === "user");
  assert.deepEqual(lastUser.content.at(-1).cache_control, { type: "ephemeral" });

  const d = await get(`/api/chats/${chatId}`);
  assert.equal(d.messages.length, 3);
  assert.ok(d.chat.state.time, "state extracted");
  assert.equal(d.chat.memory.length, 1);
  assert.ok(d.timeline.length >= 2, "timeline has events and facts");
});

test("regenerate adds an alternative; swipe; continue extends", async () => {
  const d = await get(`/api/chats/${chatId}`);
  const lastA = d.messages.at(-1);
  const ev = await sse(`/api/ai/chats/${chatId}/reply`, { mode: "regen", target_message_id: lastA.id });
  const done = ev.find((e) => e[0] === "done")[1];
  assert.equal(done.message.id, lastA.id);
  assert.equal(done.message.alternatives.length, 2);
  assert.equal(done.message.active, 1);
  const sw = await put(`/api/messages/${lastA.id}`, { active: 0 });
  assert.equal(sw.active, 0);
  const ev2 = await sse(`/api/ai/chats/${chatId}/reply`, { mode: "continue" });
  const done2 = ev2.find((e) => e[0] === "done")[1];
  assert.equal(done2.message.id, lastA.id);
  assert.ok(done2.message.alternatives[0].length > lastA.alternatives[0].length);
  assert.equal((await get(`/api/chats/${chatId}`)).messages.length, 3, "continue does not add a message");
});

test("narrator directions, suggestions, impersonation, generation", async () => {
  const ev = await sse(`/api/ai/chats/${chatId}/direct`, { kind: "time", detail: "Three hours pass" });
  const um = ev.find((e) => e[0] === "user_message")[1].message;
  assert.equal(um.kind, "direction");
  assert.match(um.alternatives[0], /Three hours pass/);
  const sug = await post(`/api/ai/chats/${chatId}/suggest`);
  assert.ok(sug.suggestions.length >= 3);
  const imp = await post(`/api/ai/chats/${chatId}/impersonate`, { hint: "be bold" });
  assert.ok(imp.text.length > 10);
  const gen = await post("/api/ai/generate/character", { prompt: "a tired bounty hunter" });
  assert.ok(gen.name && gen.greeting && gen.likes.length >= 3);
  const fld = await post("/api/ai/generate/field", { character: gen, field: "backstory" });
  assert.ok(fld.text);
  const world = await post("/api/ai/generate/world", { prompt: "drowned kingdom" });
  assert.ok(world.entries.length >= 6);
});

test("rolling summary folds old messages when over budget", async () => {
  await put("/api/settings", { contextBudget: 10, keepRecent: 2 });
  const ev = await sse(`/api/ai/chats/${chatId}/reply`, { text: "\"Tell me about the tide.\"" });
  const sum = ev.find((e) => e[0] === "summary");
  assert.ok(sum, "summary event emitted");
  const d = await get(`/api/chats/${chatId}`);
  assert.ok(d.chat.summary.length > 0);
  assert.ok(d.chat.summary_seq >= 0);
  const stats = ev.find((e) => e[0] === "status" && e[1].stats)[1].stats;
  assert.ok(stats.summarizedMessages > 0);
  await put("/api/settings", { contextBudget: 24000, keepRecent: 10 });
});

test("branch, edit, delete cascade, export, search", async () => {
  const d = await get(`/api/chats/${chatId}`);
  const mid = d.messages[1].id;
  const br = await post(`/api/chats/${chatId}/branch`, { message_id: mid });
  assert.match(br.title, /\(branch\)$/);
  const bd = await get(`/api/chats/${br.id}`);
  assert.equal(bd.messages.length, 2);
  assert.equal(bd.chat.summary, "", "summary dropped because it covered later messages");
  const ed = await put(`/api/messages/${mid}`, { text: "edited text about the unicorn" });
  assert.equal(ed.edited, true);
  const hits = await get("/api/search?q=unicorn");
  assert.equal(hits.length, 1);
  const md = await fetch(`${base}/api/chats/${chatId}/export?format=md`).then((r) => r.text());
  assert.match(md, /^# /);
  assert.match(md, /\*\*Kael:\*\*/);
  await del(`/api/messages/${d.messages[2].id}?cascade=1`);
  assert.equal((await get(`/api/chats/${chatId}`)).messages.length, 2);
  const list = await get("/api/chats");
  assert.equal(list.length, 2);
  await del(`/api/chats/${br.id}`);
  assert.equal((await get("/api/chats")).length, 1);
  const reset = await post(`/api/chats/${chatId}/reset-memory`);
  assert.equal(reset.state, null);
});

test("xAI (Grok) provider: streaming, reasoning, structured state, live model list", async () => {
  await put("/api/settings", { provider: "xai", xaiKey: "xai-test-key", xaiBaseUrl: mock.url + "/v1", showThinking: true, effort: "low" });
  const cfg = await get("/api/settings");
  assert.equal(cfg.settings.activeModel, "grok-4.6");
  assert.equal(cfg.hasApiKey, true);
  assert.match(cfg.xaiKeyMasked, /^xai-test-k…-key$/);
  const models = await get("/api/providers/xai/models");
  assert.deepEqual(models.map((m) => m.id), ["grok-4.6", "grok-4.3"], "imagine models filtered out");

  const before = mock.requests.length;
  const chat = await post("/api/chats", { character_id: charId, persona_id: personaId });
  const ev = await sse(`/api/ai/chats/${chat.id}/reply`, { text: "\"Do the salt priests still trade in memories?\"" });
  const names = ev.map((e) => e[0]);
  assert.ok(names.includes("thinking"), "reasoning streamed");
  assert.ok(names.includes("delta") && names.includes("done") && names.includes("state"));
  const done = ev.find((e) => e[0] === "done")[1];
  assert.equal(done.usage.model, "grok-4.6");
  assert.equal(done.usage.cache_read, 100);
  assert.match(done.message.thinking, /thinking about it/);
  const reqs = mock.requests.slice(before).filter((r) => r.url.startsWith("/v1/chat/completions"));
  const replyReq = reqs.find((r) => r.body.stream);
  assert.equal(replyReq.headers.authorization, "Bearer xai-test-key");
  assert.equal(replyReq.body.reasoning_effort, "low");
  assert.equal(replyReq.body.messages[0].role, "system");
  assert.match(replyReq.body.messages[0].content, /You are Mira/);
  assert.equal(replyReq.body.messages.at(-1).role, "system", "dynamic context as trailing system message");
  assert.match(replyReq.body.messages.at(-1).content, /They trade in memories/);
  const stateReq = reqs.find((r) => r.body.response_format);
  assert.equal(stateReq.body.model, "grok-4.3", "utility model used for state extraction");
  assert.equal(stateReq.body.response_format.json_schema.strict, true);
  assert.equal(stateReq.body.response_format.json_schema.schema.additionalProperties, false);
  const gen = await post("/api/ai/generate/character", { prompt: "a grok-made rogue" });
  assert.ok(gen.name && gen.likes.length >= 3);
  await del(`/api/chats/${chat.id}`);
  await put("/api/settings", { provider: "anthropic", xaiKey: "", showThinking: false });
});

test("missing api key gives a clear error", async () => {
  await put("/api/settings", { apiKey: "" });
  const r = await fetch(`${base}/api/ai/chats/${chatId}/reply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /API key/);
});

test("static app is served", async () => {
  const html = await fetch(base + "/").then((r) => r.text());
  assert.match(html, /Tavern/);
  const js = await fetch(base + "/js/app.js").then((r) => r.text());
  assert.match(js, /navigate/);
});
