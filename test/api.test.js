import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMock } from "./mock-anthropic.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tavern-test-"));
process.env.DATA_DIR = tmp;
delete process.env.ANTHROPIC_API_KEY; delete process.env.XAI_API_KEY; delete process.env.PROVIDER;
let mock, server, base;

/** Tiny cookie-aware client so we can act as several users. */
function client() {
  let cookie = "";
  const call = async (method, u, body) => {
    const r = await fetch(base + u, { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    return r;
  };
  const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
  const c = {
    get: (u) => call("GET", u).then(j), post: (u, b = {}) => call("POST", u, b).then(j), put: (u, b = {}) => call("PUT", u, b).then(j), del: (u) => call("DELETE", u).then(j),
    raw: call,
    async sse(u, b) {
      const r = await call("POST", u, b || {});
      const raw = await r.text();
      assert.equal(r.status, 200, raw);
      return raw.split("\n\n").filter((c) => c.startsWith("event:")).map((c) => [c.match(/^event: (.*)$/m)[1], JSON.parse(c.match(/^data: (.*)$/m)[1])]);
    },
    async job(u, b) { const ev = await c.sse(u, b); const err = ev.find((e) => e[0] === "error"); if (err) throw new Error(err[1].error); return ev.find((e) => e[0] === "result")[1]; },
  };
  return c;
}
const alice = client(), bob = client();

before(async () => {
  mock = await startMock();
  process.env.ANTHROPIC_BASE_URL = mock.url;
  const { app } = await import("../server/app.js");
  server = await new Promise((res) => { const s = app.listen(0, "127.0.0.1", () => res(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await mock.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

let charId, char2Id, personaId, worldId, chatId;

test("auth: register, me, logout, login, validation, rate limiting", async () => {
  const r0 = await alice.raw("GET", "/api/characters");
  assert.equal(r0.status, 401);
  const bad = await alice.raw("POST", "/api/auth/register", { username: "a", password: "123456" });
  assert.equal(bad.status, 400);
  const reg = await alice.raw("POST", "/api/auth/register", { username: "alice", password: "secret1" });
  assert.equal(reg.status, 201);
  assert.match(reg.headers.get("set-cookie"), /tavern_session=.*HttpOnly/);
  const me = await alice.get("/api/auth/me");
  assert.equal(me.user.username, "alice");
  assert.equal(me.user.is_admin, true, "first user is admin");
  assert.equal((await alice.get("/api/personas")).length, 1, "a default persona is created");
  await alice.post("/api/auth/logout");
  assert.equal((await alice.raw("GET", "/api/characters")).status, 401);
  const dup = await bob.raw("POST", "/api/auth/register", { username: "ALICE", password: "secret1" });
  assert.equal(dup.status, 409, "usernames are case-insensitive");
  const wrong = await alice.raw("POST", "/api/auth/login", { username: "alice", password: "nope" });
  assert.equal(wrong.status, 401);
  const login = await alice.raw("POST", "/api/auth/login", { username: "alice", password: "secret1" });
  assert.equal(login.status, 200);
  assert.equal((await bob.raw("POST", "/api/auth/register", { username: "bob", password: "secret2" })).status, 201);
  assert.equal((await bob.get("/api/auth/me")).user.is_admin, false);
});

test("settings are per user; keys never leak", async () => {
  await alice.put("/api/settings", { apiKey: "sk-ant-alice-key-000000", effort: "high", contextBudget: 24000 });
  const a = await alice.get("/api/settings");
  assert.equal(a.hasApiKey, true);
  assert.equal(a.settings.effort, "high");
  assert.equal(a.settings.anthropicKey, undefined, "raw key not returned");
  assert.match(a.apiKeyMasked, /^sk-ant-ali…0000$/);
  const b = await bob.get("/api/settings");
  assert.equal(b.hasApiKey, false, "bob has no key");
  assert.equal(b.settings.effort, "medium");
});

test("characters / personas / worlds are private to their owner", async () => {
  const c = await alice.post("/api/characters", { name: "Mira", tagline: "Salt-priest", description: "A priestess of the tide", greeting: "*She turns.* \"You're late, {{user}}.\"", alt_greetings: ["*A different opening for {{user}}.*"], avatar: "🧝‍♀️", color: "#8b5cf6", tags: ["fantasy"] });
  charId = c.id;
  const c2 = await alice.post("/api/characters", { name: "Bram", tagline: "Harbourmaster with debts", description: "Gruff, honest, tired", speech_style: "short sentences", avatar: "⚓", color: "#0ea5e9" });
  char2Id = c2.id;
  personaId = (await alice.get("/api/personas"))[0].id;
  await alice.put(`/api/personas/${personaId}`, { name: "Kael", description: "A smuggler" });
  const w = await alice.post("/api/worlds", { name: "Drowned Kingdom", description: "Tides rule", entries: [
    { name: "Salt priests", keywords: ["priest", "salt"], content: "They trade in memories.", always_on: false, priority: 5 },
    { name: "Core", keywords: [], content: "The tide reveals ruins twice a day.", always_on: true, priority: 0 },
  ] });
  worldId = w.id;
  assert.equal((await bob.get("/api/characters")).length, 0, "bob sees none of alice's characters");
  assert.equal((await bob.raw("GET", `/api/characters/${charId}`)).status, 404);
  assert.equal((await bob.raw("PUT", `/api/characters/${charId}`, { name: "hacked" })).status, 404);
  assert.equal((await bob.raw("DELETE", `/api/characters/${charId}`)).status, 404);
  assert.equal((await alice.get(`/api/characters/${charId}`)).name, "Mira");
  const dup = await alice.post(`/api/characters/${charId}/duplicate`);
  assert.equal(dup.name, "Mira (copy)");
  await alice.del(`/api/characters/${dup.id}`);
  const imp = await alice.post("/api/characters/import", { spec: "chara_card_v2", data: { name: "Import", first_mes: "hi {{user}}", mes_example: "<START>\nx" } });
  assert.equal(imp.greeting, "hi {{user}}");
  await alice.del(`/api/characters/${imp.id}`);
});

test("single-character roleplay: greeting, streamed reply, prompt shape, state", async () => {
  const chat = await alice.post("/api/chats", { character_ids: [charId], persona_id: personaId, world_id: worldId, greeting_index: 1 });
  chatId = chat.id;
  assert.equal(chat.title, "Chat with Mira");
  assert.equal(chat.cast.length, 1);
  const d = await alice.get(`/api/chats/${chatId}`);
  assert.equal(d.messages[0].speaker.name, "Mira");
  assert.equal(d.messages[0].alternatives[1], "*A different opening for Kael.*");
  assert.equal((await bob.raw("GET", `/api/chats/${chatId}`)).status, 404, "bob cannot open alice's roleplay");

  const before = mock.requests.length;
  const ev = await alice.sse(`/api/ai/chats/${chatId}/reply`, { text: "\"I heard the salt priests want to talk.\"" });
  const names = ev.map((e) => e[0]);
  assert.deepEqual(names.filter((n) => n === "speaker"), ["speaker"], "exactly one speaker, no director call for a single character");
  assert.ok(names.includes("delta") && names.includes("done") && names.includes("state"));
  const done = ev.find((e) => e[0] === "done")[1];
  assert.equal(done.message.speaker.name, "Mira");
  assert.ok(done.stats.loreTriggered.includes("Salt priests"));
  const reqs = mock.requests.slice(before);
  const replyReq = reqs.find((r) => r.body.stream);
  assert.equal(replyReq.headers["x-api-key"], "sk-ant-alice-key-000000", "the user's own key is used");
  assert.equal(replyReq.body.output_config.effort, "high");
  assert.deepEqual(replyReq.body.system[0].cache_control, { type: "ephemeral" });
  assert.match(replyReq.body.system[0].text, /You are Mira, fully in character/);
  assert.equal(replyReq.body.messages.at(-1).role, "system");
  assert.match(replyReq.body.messages.at(-1).content, /They trade in memories/);
  assert.equal(reqs.filter((r) => r.body.output_config?.format).length, 1, "only the state extraction is structured");
  const d2 = await alice.get(`/api/chats/${chatId}`);
  assert.ok(d2.chat.state.time);
  assert.equal(d2.chat.memory.length, 1);
});

test("ensemble roleplay: director picks speakers, presence changes, newcomer joins, promotion", async () => {
  const chat = await alice.post("/api/chats", { character_ids: [charId, char2Id], persona_id: personaId, premise: "A storm has trapped everyone in the harbour office." });
  const id = chat.id;
  assert.equal(chat.title, "Story with Mira & Bram");
  assert.equal(chat.cast.length, 2);
  assert.equal(chat.narrator_enabled, true);

  // Script the director: Bram answers then the Narrator; Mira steps away; a newcomer appears.
  mock.script.push({
    speakers: [{ name: "Bram", why: "he was addressed" }, { name: "narrator", why: "storm" }],
    presence_changes: [{ name: "Mira", status: "away", why: "went to check the cellar" }],
    newcomer: { introduce: true, name: "Old Tomas", role: "drenched fisherman", description: "Bangs on the door mid-storm. Talks in half-sentences. Wants shelter and has seen something in the water." },
  });
  const before = mock.requests.length;
  const ev = await alice.sse(`/api/ai/chats/${id}/reply`, { text: "\"Bram, is the door going to hold?\"" });
  const speakers = ev.filter((e) => e[0] === "speaker").map((e) => e[1].name);
  assert.deepEqual(speakers, ["Bram", "Narrator"]);
  const dones = ev.filter((e) => e[0] === "done").map((e) => e[1].message);
  assert.equal(dones.length, 2);
  assert.equal(dones[0].speaker.name, "Bram");
  assert.equal(dones[1].speaker.kind, "narrator");
  const castEv = ev.find((e) => e[0] === "cast")[1];
  assert.equal(castEv.cast.find((m) => m.name === "Mira").status, "away");
  const tomas = castEv.cast.find((m) => m.name === "Old Tomas");
  assert.ok(tomas && tomas.generated && tomas.status === "present", "newcomer joined the cast");
  assert.equal(castEv.newcomer.name, "Old Tomas");

  // Prompt shape for Bram: labelled transcript, other characters described, presence in dynamic context.
  const reqs = mock.requests.slice(before).filter((r) => r.body.stream);
  assert.equal(reqs.length, 2);
  const bramReq = reqs[0];
  assert.match(bramReq.body.system[0].text, /You are Bram, one character in an interactive story/);
  assert.match(bramReq.body.system[0].text, /Other characters in this story[\s\S]*\*\*Mira\*\*/);
  assert.match(bramReq.body.messages[1].content[0].text, /^\[Mira\]\n/, "assistant history is labelled by speaker");
  assert.match(bramReq.body.messages[2].content[0].text, /^\[Kael\]\n/, "user lines are labelled too in ensembles");
  assert.match(bramReq.body.messages.at(-1).content, /Who is where right now[\s\S]*Mira: away/);
  const narratorReq = reqs[1];
  assert.match(narratorReq.body.system[0].text, /You are the Narrator/);
  assert.match(narratorReq.body.messages.at(-1).content, /Already said this turn[\s\S]*Bram:/);

  // Force a specific speaker, including the newcomer (uses his brief).
  const ev2 = await alice.sse(`/api/ai/chats/${id}/reply`, { text: "\"Who's there?\"", speaker: "Old Tomas" });
  assert.deepEqual(ev2.filter((e) => e[0] === "speaker").map((e) => e[1].name), ["Old Tomas"]);
  const tomasReq = mock.requests.filter((r) => r.body.stream).at(-1);
  assert.match(tomasReq.body.system[0].text, /Your character: Old Tomas[\s\S]*drenched fisherman/);

  // Cast management endpoints.
  const upd = await alice.put(`/api/chats/${id}/cast/Mira`, { status: "present" });
  assert.equal(upd.cast.find((m) => m.name === "Mira").status, "present");
  const dupAdd = await alice.raw("POST", `/api/chats/${id}/cast`, { character_id: charId });
  assert.equal(dupAdd.status, 409);
  const promoted = await alice.job(`/api/ai/chats/${id}/cast/Old Tomas/promote`);
  assert.equal(promoted.character.name, "Old Tomas", "newcomer promoted to a full library character");
  assert.ok(promoted.cast.find((m) => m.name === "Old Tomas").character_id);
  assert.equal((await alice.get("/api/characters")).some((c) => c.name === "Old Tomas"), true);
  const rm = await alice.del(`/api/chats/${id}/cast/Old Tomas`);
  assert.equal(rm.cast.length, 2);
  const list = await alice.get("/api/chats");
  assert.equal(list.find((c) => c.id === id).cast.length, 2);
  await alice.del(`/api/chats/${id}`);
});

test("premise generation, narrator opening", async () => {
  const p = await alice.job("/api/ai/generate/premise", { character_ids: [charId, char2Id], persona_id: personaId, idea: "a heist" });
  assert.ok(p.title && p.premise && p.opening);
  const chat = await alice.post("/api/chats", { character_ids: [charId, char2Id], persona_id: personaId, premise: p.premise, opening: p.opening, title: p.title });
  const d = await alice.get(`/api/chats/${chat.id}`);
  assert.equal(d.messages[0].speaker.kind, "narrator");
  assert.equal(d.chat.premise, p.premise);
  await alice.del(`/api/chats/${chat.id}`);
});

test("regenerate keeps speaker; continue extends; directions; suggestions; impersonate", async () => {
  const d = await alice.get(`/api/chats/${chatId}`);
  const lastA = d.messages.at(-1);
  const ev = await alice.sse(`/api/ai/chats/${chatId}/reply`, { mode: "regen", target_message_id: lastA.id });
  const done = ev.find((e) => e[0] === "done")[1];
  assert.equal(done.message.id, lastA.id);
  assert.equal(done.message.alternatives.length, 2);
  assert.equal(done.message.speaker.name, "Mira");
  await alice.put(`/api/messages/${lastA.id}`, { active: 0 });
  const ev2 = await alice.sse(`/api/ai/chats/${chatId}/reply`, { mode: "continue" });
  assert.equal(ev2.find((e) => e[0] === "done")[1].message.id, lastA.id);
  const ev3 = await alice.sse(`/api/ai/chats/${chatId}/direct`, { kind: "time", detail: "Three hours pass" });
  assert.equal(ev3.find((e) => e[0] === "user_message")[1].message.kind, "direction");
  assert.equal(ev3.find((e) => e[0] === "speaker")[1].name, "Narrator", "time skips are narrated");
  const dirReq = mock.requests.filter((r) => r.body.stream).at(-1);
  assert.match(dirReq.body.system[0].text, /square brackets\] are stage directions/, "the prompt explains bracketed directions");
  assert.match(JSON.stringify(dirReq.body.messages), /\[Time skip: Three hours pass/, "the direction sits in the history as a bracketed line");
  assert.match(JSON.stringify(dirReq.body.messages), /Stage direction from the user for this reply[^"]*Three hours pass/, "and is repeated as the per-reply instruction");
  const sug = await alice.job(`/api/ai/chats/${chatId}/suggest`);
  assert.ok(sug.suggestions.length >= 3);
  const imp = await alice.job(`/api/ai/chats/${chatId}/impersonate`, { hint: "be bold" });
  assert.ok(imp.text.length > 10);
  const gen = await alice.job("/api/ai/generate/character", { prompt: "a tired bounty hunter" });
  assert.ok(gen.name && gen.likes.length >= 3);
  const badReq = await alice.raw("POST", "/api/ai/generate/character", {});
  assert.equal(badReq.status, 400);
});

test("rolling summary folds old messages when over budget", async () => {
  await alice.put("/api/settings", { contextBudget: 10, keepRecent: 2 });
  const ev = await alice.sse(`/api/ai/chats/${chatId}/reply`, { text: "\"Tell me about the tide.\"" });
  assert.ok(ev.find((e) => e[0] === "summary"));
  const d = await alice.get(`/api/chats/${chatId}`);
  assert.ok(d.chat.summary.length > 0);
  await alice.put("/api/settings", { contextBudget: 24000, keepRecent: 10 });
});

test("branch, edit, delete cascade, export, search stay within the owner", async () => {
  const d = await alice.get(`/api/chats/${chatId}`);
  const mid = d.messages[1].id;
  const br = await alice.post(`/api/chats/${chatId}/branch`, { message_id: mid });
  assert.match(br.title, /\(branch\)$/);
  assert.equal((await alice.get(`/api/chats/${br.id}`)).messages.length, 2);
  const ed = await alice.put(`/api/messages/${mid}`, { text: "edited text about the unicorn" });
  assert.equal(ed.edited, true);
  assert.equal((await bob.raw("PUT", `/api/messages/${mid}`, { text: "x" })).status, 404, "bob cannot edit alice's message");
  assert.equal((await alice.get("/api/search?q=unicorn")).length, 1);
  assert.equal((await bob.get("/api/search?q=unicorn")).length, 0);
  const md = await (await alice.raw("GET", `/api/chats/${chatId}/export?format=md`)).text();
  assert.match(md, /\*\*Kael:\*\*/);
  assert.match(md, /\*\*Mira:\*\*/);
  await alice.del(`/api/messages/${d.messages[2].id}?cascade=1`);
  assert.equal((await alice.get(`/api/chats/${chatId}`)).messages.length, 2);
  await alice.del(`/api/chats/${br.id}`);
  assert.equal((await alice.post(`/api/chats/${chatId}/reset-memory`)).state, null);
});

test("xAI (Grok) provider per user: streaming, reasoning, strict schema, low effort", async () => {
  await alice.put("/api/settings", { provider: "xai", xaiKey: "xai-test-key", xaiBaseUrl: mock.url + "/v1", showThinking: true, effort: "medium" });
  const cfg = await alice.get("/api/settings");
  assert.equal(cfg.settings.activeModel, "grok-4.6");
  assert.equal(cfg.hasApiKey, true);
  assert.deepEqual((await alice.get("/api/providers/xai/models")).map((m) => m.id), ["grok-4.6", "grok-4.3"]);
  const before = mock.requests.length;
  const ev = await alice.sse(`/api/ai/chats/${chatId}/reply`, { text: "\"Do the salt priests still trade in memories?\"" });
  assert.ok(ev.some((e) => e[0] === "thinking"));
  const done = ev.find((e) => e[0] === "done")[1];
  assert.equal(done.usage.model, "grok-4.6");
  const reqs = mock.requests.slice(before).filter((r) => r.url.startsWith("/v1/chat/completions"));
  const replyReq = reqs.find((r) => r.body.stream);
  assert.equal(replyReq.headers.authorization, "Bearer xai-test-key");
  assert.equal(replyReq.body.reasoning_effort, "low", "medium maps to low on xAI");
  assert.equal(replyReq.body.messages.at(-1).role, "system");
  const stateReq = reqs.find((r) => r.body.response_format);
  assert.equal(stateReq.body.model, "grok-4.3");
  assert.equal(stateReq.body.response_format.json_schema.strict, true);
  assert.equal((await bob.get("/api/settings")).settings.provider, "anthropic", "bob's provider unaffected");
  await alice.put("/api/settings", { provider: "anthropic", xaiKey: "", showThinking: false });
});

test("missing api key gives a clear error; static app served; health", async () => {
  const r = await bob.raw("POST", `/api/ai/generate/character`, { prompt: "x" });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /API key/);
  assert.match(await (await fetch(base + "/")).text(), /Tavern/);
  assert.equal((await (await fetch(base + "/healthz")).json()).ok, true);
});
