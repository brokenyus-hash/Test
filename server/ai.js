// Turn engine: director (who speaks, who enters/leaves, newcomers), per-speaker streaming,
// world-state extraction, rolling summaries, generators (characters, worlds, premises).
import { z } from "zod";
import * as db from "./db.js";
import { settings, resolveModels, estimateTokens } from "./claude.js";
import { streamText, structured as providerStructured, complete as providerComplete, describeError } from "./provider.js";
import { buildMessages, pickForSummary, formatState, presenceLine, NARRATOR, sub } from "./prompt.js";

const text = (m) => m.alternatives?.[m.active ?? 0] ?? "";
const norm = (n) => (n || "").trim().toLowerCase();

/** Cast entries with their character docs attached; migrates pre-cast roleplays. */
export function resolveCast(chat, userId) {
  let cast = Array.isArray(chat.cast) ? chat.cast : null;
  if (!cast || !cast.length) {
    const c = chat.character_id ? db.characters.get(chat.character_id, userId) : null;
    cast = c ? [{ character_id: c.id, name: c.name, status: "present", role: "lead" }] : [];
  }
  return cast.map((m) => {
    const character = m.character_id ? db.characters.get(m.character_id, userId) : null;
    return { status: "present", role: "supporting", ...m, name: m.name || character?.name || "Unknown", character, avatar: m.avatar || character?.avatar || "🎭", color: m.color || character?.color || "#8b5cf6", kind: "character" };
  });
}
const stripCast = (cast) => cast.map(({ character, kind, ...m }) => m);

export function loadChatContext(chatId, user) {
  const chat = db.chats.get(chatId, user.id);
  if (!chat) throw Object.assign(new Error("Roleplay not found"), { status: 404 });
  const cast = resolveCast(chat, user.id);
  const persona = chat.persona_id ? db.personas.get(chat.persona_id, user.id) : null;
  const world = chat.world_id ? db.worlds.get(chat.world_id, user.id) : (cast[0]?.character?.world_id ? db.worlds.get(cast[0].character.world_id, user.id) : null);
  const s = resolveModels({ ...settings(user), ...(chat.settings || {}) });
  if (chat.settings?.model) s.activeModel = chat.settings.model;
  const history = db.messages.list(chatId);
  return { chat, cast, persona, world, s, history, user };
}

const structured = (s, p) => providerStructured({ s, model: s.activeUtilityModel, effort: s.utilityEffort, maxTokens: 8000, ...p });
const complete = (s, p) => providerComplete({ s, model: s.activeUtilityModel, effort: s.utilityEffort, maxTokens: 4000, ...p });
const genEffort = (s) => (s.provider === "xai" ? "low" : "high");

// ---------------------------------------------------------------- summaries
export async function maybeSummarize(ctx, emit) {
  const { chat, cast, persona, s, history } = ctx;
  if (!s.autoSummarize) return null;
  const fold = pickForSummary({ chat, history, s });
  if (!fold) return null;
  emit?.("status", { text: `Condensing ${fold.length} older messages into memory…` });
  const userName = persona?.name || "User";
  const transcript = fold.map((m) => `${m.role === "assistant" ? (m.speaker?.name || cast[0]?.name || "Narrator") : userName}: ${text(m)}`).join("\n\n");
  const prompt = [
    chat.summary ? `Existing summary of everything before this point:\n${chat.summary}\n\n` : "",
    `New transcript to fold into the summary:\n${transcript}\n\n`,
    `Write an updated, self-contained summary of the story so far (existing summary + new transcript). Preserve key events in order, decisions and consequences, promises, injuries, items gained or lost, where each character is, relationship shifts, unresolved threads, and specific names, places, or numbers. Past tense, third person, dense but readable, under 700 words. Output only the summary.`,
  ].join("");
  const { text: summary } = await complete(s, { system: "You are a meticulous continuity editor for an ongoing interactive story.", messages: [{ role: "user", content: prompt }], maxTokens: 2000 });
  const summary_seq = fold[fold.length - 1].seq;
  db.chats.update(chat.id, { summary: summary.trim(), summary_seq }, { touch: false });
  chat.summary = summary.trim(); chat.summary_seq = summary_seq;
  emit?.("summary", { summary: chat.summary, summary_seq });
  return chat.summary;
}

// ---------------------------------------------------------------- world state
const StateSchema = z.object({
  time: z.string().describe("In-world date and time of day, e.g. 'Day 3, Tuesday, 21:40 (night)'"),
  location: z.string().describe("Where the scene is happening right now"),
  weather: z.string().describe("Weather and ambient atmosphere"),
  character_mood: z.string().describe("The lead character's current emotional state, in a few words"),
  character_status: z.string().describe("What the lead character is doing / physical state"),
  relationship: z.object({
    score: z.number().describe("-100 (hatred) to 100 (devotion) between the lead character and the user; move it only when something earns it"),
    label: z.string().describe("Short label: strangers, wary, friendly, close, lovers, rivals, enemies…"),
    note: z.string().describe("One sentence on the current dynamic"),
  }),
  cast_presence: z.array(z.object({ name: z.string(), status: z.enum(["present", "nearby", "away", "gone"]) })).describe("Where each named cast member is after this exchange (use the exact cast names)"),
  present_npcs: z.array(z.object({ name: z.string(), role: z.string(), disposition: z.string().describe("attitude toward the user right now") })).describe("Unnamed-cast bystanders currently in the scene (exclude cast members and the user)"),
  inventory: z.array(z.string()).describe("Notable items the user currently carries or owns"),
  character_goals: z.array(z.string()).describe("The lead character's active goals or intentions"),
  active_threads: z.array(z.object({ title: z.string(), status: z.enum(["open", "progressing", "resolved", "failed"]), note: z.string() })).describe("Plot threads, quests, promises, mysteries"),
  new_facts: z.array(z.string()).describe("NEW durable facts established in this exchange worth remembering forever. Empty if none."),
  events: z.array(z.string()).describe("1-3 short past-tense lines describing what happened in this exchange"),
});

export async function extractState(ctx, lastUser, turnText, emit) {
  const { chat, cast, persona, s } = ctx;
  if (!s.autoState) return null;
  emit?.("status", { text: "Updating world state…" });
  const lead = cast[0]?.name || "the narrator";
  const userName = persona?.name || "the user";
  const prev = chat.state ? formatState(chat.state) : "(no state yet - initialise from the scene; if the story gives no time, invent a plausible one)";
  const prompt = [
    `Lead character: ${lead}. User: ${userName}. Cast: ${cast.map((m) => m.name).join(", ") || "(none)"}. Presence before this exchange: ${presenceLine(cast)}.`,
    chat.summary ? `Story so far: ${chat.summary}` : "",
    `Previous world state:\n${prev}`,
    `Latest exchange:\n${userName}: ${lastUser || "(scene start)"}\n\n${turnText}`,
    `Produce the complete updated world state after this exchange. Carry forward everything still true; change only what the exchange changed. Advance time realistically. Relationship score moves in small steps (usually ±1 to ±8) unless something dramatic happened. For cast_presence, list every cast member with where they are now.`,
  ].filter(Boolean).join("\n\n");
  const { data } = await structured(s, { schema: StateSchema, system: "You are the continuity and state tracker for an interactive story. Be precise and conservative.", messages: [{ role: "user", content: prompt }], maxTokens: 4000 });
  const { new_facts, events, cast_presence, ...state } = data;
  const memory = [...(chat.memory || [])];
  const known = new Set(memory.map((f) => (typeof f === "string" ? f : f.text).toLowerCase()));
  for (const f of new_facts || []) if (!known.has(f.toLowerCase())) { memory.push({ text: f, at: Date.now(), pinned: false }); known.add(f.toLowerCase()); }
  const capped = [...memory.filter((f) => f.pinned), ...memory.filter((f) => !f.pinned).slice(-80)];
  // Apply presence updates to the cast.
  let castChanged = false;
  for (const p of cast_presence || []) {
    const m = cast.find((x) => norm(x.name) === norm(p.name));
    if (m && m.status !== p.status) { m.status = p.status; castChanged = true; }
  }
  db.chats.update(chat.id, { state, memory: capped, ...(castChanged ? { cast: stripCast(cast) } : {}) }, { touch: false });
  chat.state = state; chat.memory = capped;
  return { state, memory: capped, events: events || [], new_facts: new_facts || [], castChanged };
}

// ---------------------------------------------------------------- director
const DirectorSchema = z.object({
  speakers: z.array(z.object({ name: z.string().describe("Exact cast name, or 'Narrator'"), why: z.string() })).min(1).max(3).describe("Who responds this turn, in order. Usually 1-2. Only present or nearby characters (a nearby one is drawn into the scene)."),
  presence_changes: z.array(z.object({ name: z.string(), status: z.enum(["present", "nearby", "away", "gone"]), why: z.string() })).describe("Cast members whose whereabouts change now (arrivals, exits). Empty if none."),
  newcomer: z.object({
    introduce: z.boolean().describe("true only when the story genuinely calls for a NEW named character to appear now (rare)"),
    name: z.string(), role: z.string(), description: z.string().describe("2-3 sentences: who they are, how they talk, what they want"),
  }),
});

export async function direct(ctx, userText, emit) {
  const { chat, cast, persona, s, history } = ctx;
  emit?.("status", { text: "Deciding who responds…" });
  const userName = persona?.name || "the user";
  const recent = history.slice(-8).map((m) => `${m.role === "assistant" ? (m.speaker?.name || "Narrator") : userName}: ${text(m).slice(0, 500)}`).join("\n\n");
  const castDesc = cast.map((m) => `- ${m.name} [${m.status}]${m.role === "lead" ? " (lead)" : ""}: ${m.character?.tagline || m.brief || ""}`).join("\n");
  const prompt = [
    `Cast:\n${castDesc}\n- Narrator [always available]: scene description, time passing, bystanders, complications.`,
    chat.premise ? `Premise: ${chat.premise}` : "",
    chat.state ? `World state:\n${formatState(chat.state)}` : "",
    `Recent transcript:\n${recent}`,
    `${userName} just wrote:\n${userText || "(no message; the scene continues on its own)"}`,
    `Decide who responds now. Rules: characters who were addressed or directly affected respond; not everyone speaks every turn; if nobody present would naturally speak, or the scene/time/place needs describing, use the Narrator. Someone marked nearby may enter if it fits; someone away or gone cannot speak. Introduce a newcomer only when the story clearly needs a new named person right now.`,
  ].filter(Boolean).join("\n\n");
  const { data } = await structured(s, { schema: DirectorSchema, system: "You are the director of an ensemble interactive story. Keep scenes lively but coherent; favour the fewest speakers that move the scene.", messages: [{ role: "user", content: prompt }], maxTokens: 1500 });

  // Normalise names against the cast.
  const find = (n) => cast.find((m) => norm(m.name) === norm(n)) || cast.find((m) => norm(m.name).startsWith(norm(n)) || norm(n).startsWith(norm(m.name)));
  let castChanged = false;
  for (const p of data.presence_changes || []) {
    const m = find(p.name);
    if (m && m.status !== p.status) { m.status = p.status; castChanged = true; emit?.("status", { text: `${m.name} is now ${p.status} (${p.why})` }); }
  }
  let newcomer = null;
  const nc = data.newcomer;
  if (nc?.introduce && nc.name && !find(nc.name) && norm(nc.name) !== "narrator") {
    newcomer = { character_id: null, name: nc.name.trim(), status: "present", role: "guest", generated: true, brief: `${nc.role}. ${nc.description}`, avatar: "✨", color: "#f59e0b" };
    cast.push({ ...newcomer, character: null, kind: "character" });
    castChanged = true;
  }
  const speakers = [];
  for (const sp of data.speakers || []) {
    if (norm(sp.name) === "narrator") { if (!speakers.some((x) => x.kind === "narrator")) speakers.push({ ...NARRATOR }); continue; }
    const m = find(sp.name);
    if (m && ["present", "nearby"].includes(m.status) && !speakers.includes(m)) { if (m.status === "nearby") { m.status = "present"; castChanged = true; } speakers.push(m); }
  }
  if (!speakers.length) {
    const fallback = cast.find((m) => m.status === "present") || cast.find((m) => m.status === "nearby");
    speakers.push(fallback || { ...NARRATOR });
  }
  if (castChanged) db.chats.update(chat.id, { cast: stripCast(cast) }, { touch: false });
  return { speakers: speakers.slice(0, 3), castChanged, newcomer };
}

// ---------------------------------------------------------------- one speaker's reply
async function speak({ ctx, speaker, history, extra, turnSoFar, emit, signal, mode, target }) {
  const { chat, cast, persona, world, s } = ctx;
  const built = buildMessages({ chat, speaker, cast, persona, world, s, history, extraInstruction: extra, model: s.activeModel, provider: s.provider, turnSoFar });
  emit("speaker", { name: speaker.name, kind: speaker.kind, avatar: speaker.avatar, color: speaker.color, character_id: speaker.character_id || null, stats: built.stats });
  const r = await streamText({
    s, model: s.activeModel, system: built.system, messages: built.messages,
    maxTokens: Number(s.maxTokens) || 4096, effort: s.effort, showThinking: s.showThinking, fallbacks: s.fallbacks, signal,
    onDelta: (t) => emit("delta", { text: t }), onThinking: (t) => emit("thinking", { text: t }),
  });
  let out = r.text.trim().replace(new RegExp(`^\\[?${speaker.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]?:?\\s*`, "i"), "").trim();
  if (r.stopReason === "refusal") {
    if (!out) throw new Error(`Refused: ${r.note}`);
    emit("status", { text: `Note: the model stopped early (${r.note}).` });
  }
  if (!out) throw new Error("Empty reply from the model.");
  const speakerInfo = { name: speaker.name, kind: speaker.kind, character_id: speaker.character_id || null, avatar: speaker.avatar, color: speaker.color };
  let saved;
  if (mode === "regen" && target) {
    const alts = [...(target.alternatives || []), out];
    saved = db.messages.update(target.id, { alternatives: alts, active: alts.length - 1, thinking: r.thinking || target.thinking, usage: r.usage, stopped: !!signal?.aborted, speaker: target.speaker || speakerInfo });
  } else if (mode === "continue" && target) {
    const alts = [...(target.alternatives || [])];
    const i = target.active ?? 0;
    const sep = /\s$/.test(alts[i]) || /^[,.;:!?]/.test(out) ? "" : (/[.!?*"”]$/.test(alts[i]) ? "\n\n" : " ");
    alts[i] = alts[i] + sep + out;
    saved = db.messages.update(target.id, { alternatives: alts, usage: r.usage });
  } else {
    saved = db.messages.add(chat.id, { role: "assistant", text: out, thinking: r.thinking || undefined, usage: r.usage, stopped: !!signal?.aborted, speaker: speakerInfo });
  }
  emit("done", { message: saved, usage: r.usage, stats: built.stats });
  return saved;
}

/**
 * Run one AI turn. emit(event, payload) events: status, speaker, delta, thinking, done, cast, state, summary, suggestions, title, error.
 * mode: reply | regen | continue.  speakerName: force a specific cast member / "Narrator".
 */
export async function runTurn({ chatId, user, emit, signal, mode = "reply", targetMessageId = null, instruction = null, speakerName = null }) {
  const ctx = loadChatContext(chatId, user);
  const { chat, cast } = ctx;
  await maybeSummarize(ctx, emit).catch((e) => emit("status", { text: `Summary skipped: ${describeError(e)}` }));
  ctx.history = db.messages.list(chatId);
  const ensemble = cast.length > 1 || chat.narrator_enabled;
  const speakerFor = (m) => (m?.speaker?.kind === "narrator" ? { ...NARRATOR } : cast.find((c) => c.character_id && c.character_id === m?.speaker?.character_id) || cast.find((c) => norm(c.name) === norm(m?.speaker?.name)) || cast[0] || { ...NARRATOR });
  const byName = (n) => (norm(n) === "narrator" ? { ...NARRATOR } : cast.find((c) => norm(c.name) === norm(n)));

  let history = ctx.history;
  let target = targetMessageId ? db.messages.get(targetMessageId) : null;
  const spoken = [];

  if (mode === "regen" && target) {
    history = history.filter((m) => m.seq < target.seq);
    const turnSoFar = []; // earlier speakers of the same turn already sit in history
    spoken.push(await speak({ ctx, speaker: speakerFor(target), history, extra: instruction, turnSoFar, emit, signal, mode, target }));
  } else if (mode === "continue") {
    target = [...history].reverse().find((m) => m.role === "assistant") || null;
    const extra = (instruction ? instruction + "\n" : "") + "Continue your previous reply from exactly where it stopped. Do not repeat or rephrase what was already written; pick up mid-flow.";
    const h = [...history, { seq: 1e9, role: "user", alternatives: ["(Continue.)"], active: 0 }];
    spoken.push(await speak({ ctx, speaker: speakerFor(target), history: h, extra, turnSoFar: [], emit, signal, mode, target }));
  } else {
    const lastUser = [...history].reverse().find((m) => m.role === "user");
    let speakers;
    if (speakerName) speakers = [byName(speakerName) || { ...NARRATOR }];
    else if (ensemble) {
      const d = await direct(ctx, lastUser ? text(lastUser) : "", emit);
      speakers = d.speakers;
      if (d.castChanged) emit("cast", { cast: stripCast(cast), newcomer: d.newcomer });
    } else speakers = [cast[0] || { ...NARRATOR }];
    const turnSoFar = [];
    for (const sp of speakers) {
      if (signal?.aborted) break;
      const saved = await speak({ ctx, speaker: sp, history: db.messages.list(chatId), extra: instruction, turnSoFar, emit, signal, mode: "reply" });
      spoken.push(saved);
      turnSoFar.push({ name: sp.name, text: text(saved) });
    }
  }

  if (signal?.aborted || !spoken.length) return;
  try {
    const lastUser = [...db.messages.list(chatId)].reverse().find((m) => m.role === "user" && m.seq < spoken[0].seq);
    const turnText = spoken.map((m) => `${m.speaker?.name || cast[0]?.name || "Narrator"}: ${text(m)}`).join("\n\n");
    const res = await extractState(ctx, lastUser ? text(lastUser) : "", turnText, emit);
    if (res) {
      if (mode === "regen") db.timeline.removeForMessages(chatId, spoken.map((m) => m.id));
      for (const ev of res.events) db.timeline.add(chatId, { message_id: spoken[0].id, kind: "event", text: ev });
      for (const f of res.new_facts) db.timeline.add(chatId, { message_id: spoken[0].id, kind: "fact", text: f });
      emit("state", { state: res.state, memory: res.memory, events: res.events, timeline: db.timeline.list(chatId) });
      if (res.castChanged) emit("cast", { cast: stripCast(cast) });
    }
  } catch (e) { emit("status", { text: `State update skipped: ${describeError(e)}` }); }
  if (ctx.s.autoSuggest) { try { emit("suggestions", { suggestions: await suggestActions(chatId, user) }); } catch { /* optional */ } }
  const cur = db.chats.get(chatId, user.id);
  if (cur && /^New roleplay|^Chat with |^Story with /.test(cur.title) && db.messages.list(chatId).length >= 3) {
    try { const t = await autoTitle(chatId, user); if (t) emit("title", { title: t }); } catch { /* optional */ }
  }
}

export async function autoTitle(chatId, user) {
  const ctx = loadChatContext(chatId, user);
  const transcript = ctx.history.slice(0, 6).map((m) => `${m.role === "assistant" ? (m.speaker?.name || "AI") : "User"}: ${text(m).slice(0, 400)}`).join("\n");
  const { text: t } = await complete(ctx.s, { system: "You name stories. Reply with only a title.", messages: [{ role: "user", content: `Give this roleplay a short evocative title (2-6 words, no quotes):\n\n${transcript}` }], maxTokens: 60 });
  const title = t.trim().split("\n")[0].replace(/^["'“”*]+|["'“”*.]+$/g, "").trim().slice(0, 80);
  if (title) db.chats.update(chatId, { title }, { touch: false });
  return title;
}

// ---------------------------------------------------------------- suggestions / impersonation
const SuggestSchema = z.object({
  suggestions: z.array(z.object({
    label: z.string().describe("3-8 word label, e.g. 'Ask about the letter'"),
    text: z.string().describe("The full message the user could send, in the user's voice with *actions* and dialogue"),
    tone: z.enum(["bold", "cautious", "kind", "clever", "romantic", "hostile", "funny", "curious"]),
  })).min(3).max(5),
});
export async function suggestActions(chatId, user) {
  const ctx = loadChatContext(chatId, user);
  const { chat, cast, persona, s } = ctx;
  const userName = persona?.name || "you";
  const recent = ctx.history.slice(-8).map((m) => `${m.role === "assistant" ? (m.speaker?.name || cast[0]?.name || "Narrator") : userName}: ${text(m)}`).join("\n\n");
  const { data } = await structured(s, { schema: SuggestSchema, system: `You propose what ${userName} might do next in an interactive story. Offer genuinely different directions (not paraphrases). Stay in ${userName}'s voice; never decide outcomes.`, messages: [{ role: "user", content: `${chat.summary ? "Story so far: " + chat.summary + "\n\n" : ""}${chat.state ? "World state:\n" + formatState(chat.state) + "\n\n" : ""}Recent scene:\n${recent}\n\nPropose 4 distinct next actions for ${userName}.` }], maxTokens: 2500 });
  return data.suggestions;
}
export async function impersonate(chatId, user, hint) {
  const ctx = loadChatContext(chatId, user);
  const { chat, cast, persona, s } = ctx;
  const userName = persona?.name || "the user";
  const recent = ctx.history.slice(-10).map((m) => `${m.role === "assistant" ? (m.speaker?.name || cast[0]?.name || "Narrator") : userName}: ${text(m)}`).join("\n\n");
  const { text: t } = await complete(s, { system: `You write the next message for ${userName} in an interactive story, in first person as ${userName}. ${persona?.description ? "About " + userName + ": " + persona.description : ""} Match the established writing format (*actions*, "dialogue"). Never write for the other characters. Output only the message.`, messages: [{ role: "user", content: `${chat.summary ? "Story so far: " + chat.summary + "\n\n" : ""}Recent scene:\n${recent}\n\n${hint ? "Direction: " + hint + "\n\n" : ""}Write ${userName}'s next message (1-3 paragraphs).` }], maxTokens: 1500, effort: s.effort });
  return t.trim();
}

// ---------------------------------------------------------------- generators
export const CharacterSchema = z.object({
  name: z.string(),
  tagline: z.string().describe("One punchy line that sells the character"),
  description: z.string().describe("Who they are, their role and situation, 100-200 words"),
  personality: z.string().describe("Temperament, values, quirks, flaws, how they treat people. 100-200 words"),
  appearance: z.string().describe("Physical description and typical clothing, 60-120 words"),
  backstory: z.string().describe("Formative history in 120-250 words"),
  speech_style: z.string().describe("How they talk: vocabulary, rhythm, verbal tics, what they never say"),
  likes: z.array(z.string()).min(3).max(6),
  dislikes: z.array(z.string()).min(3).max(6),
  goals: z.array(z.string()).min(2).max(4).describe("Concrete wants and motivations"),
  secrets: z.string().describe("Something hidden that can surface through play"),
  scenario: z.string().describe("The default situation the roleplay starts in, 60-120 words"),
  greeting: z.string().describe("The character's opening message to {{user}}: in-scene, 120-300 words, *actions* and dialogue, ends inviting a response"),
  alt_greetings: z.array(z.string()).min(1).max(2).describe("Alternative opening scenes, same format"),
  example_dialogue: z.string().describe("4-6 exchange example using {{char}}: and {{user}}: prefixes showing voice"),
  tags: z.array(z.string()).min(2).max(6),
  avatar: z.string().describe("A single emoji that suits the character"),
  color: z.string().describe("A hex accent color like #c084fc"),
});
const GEN_SYSTEM = "You are an expert character designer for interactive fiction. Create vivid, specific, internally consistent characters with real flaws and hooks for play. Use {{user}} to refer to the person they'll talk to and {{char}} for themselves inside greetings and example dialogue.";

export async function generateCharacter(s, prompt, existing) {
  const { data } = await structured(s, { schema: CharacterSchema, system: GEN_SYSTEM, messages: [{ role: "user", content: existing
    ? `Here is a partial character card as JSON. Fill in every missing or thin field and improve weak ones while preserving what is already established:\n${JSON.stringify(existing, null, 2)}\n\nExtra guidance: ${prompt || "none"}`
    : `Create a complete character from this concept:\n${prompt}` }], effort: genEffort(s), maxTokens: 12000 });
  return data;
}
export async function enhanceField(s, character, field, guidance) {
  const { text: t } = await complete(s, { system: "You are an expert character writer for interactive fiction. Output only the rewritten field text, no preamble.", messages: [{ role: "user", content: `Character card:\n${JSON.stringify(character, null, 2)}\n\nRewrite/expand the field "${field}" so it is vivid, specific and consistent with the rest of the card.${guidance ? " Guidance: " + guidance : ""}${field === "greeting" ? " Write it as an in-scene opening message with *actions* and dialogue, addressed to {{user}}." : ""}` }], effort: genEffort(s), maxTokens: 3000 });
  return t.trim();
}
export const WorldSchema = z.object({
  name: z.string(),
  description: z.string().describe("Overview of the setting, tone, era, and rules of the world, 150-300 words"),
  entries: z.array(z.object({
    name: z.string(),
    keywords: z.array(z.string()).min(1).max(6).describe("Words that should trigger this entry when they appear in the conversation"),
    content: z.string().describe("60-160 words of lore"),
    always_on: z.boolean().describe("true only for 1-3 foundational entries"),
    priority: z.number().describe("0-10"),
  })).min(6).max(14),
});
export async function generateWorld(s, prompt) {
  const { data } = await structured(s, { schema: WorldSchema, system: "You are a worldbuilder for interactive fiction. Build settings with texture: places, factions, customs, dangers, notable people, and secrets. Lore entries must be triggerable by concrete keywords.", messages: [{ role: "user", content: `Build a world from this concept:\n${prompt}` }], effort: genEffort(s), maxTokens: 14000 });
  return data;
}

/** Draft a premise + opening scene for a cast. */
const PremiseSchema = z.object({
  title: z.string().describe("2-6 word title"),
  premise: z.string().describe("The situation the story starts in and what brings these characters together, 80-160 words"),
  opening: z.string().describe("Opening narration (120-250 words) that sets the scene and ends with a hook inviting {{user}} to act; *actions* and dialogue allowed"),
});
export async function generatePremise(s, { cast, persona, world, idea }) {
  const castDesc = cast.map((m) => `- ${m.name}: ${m.character?.tagline || m.brief || ""}${m.character?.description ? " — " + m.character.description.slice(0, 300) : ""}`).join("\n");
  const { data } = await structured(s, { schema: PremiseSchema, system: "You design premises for interactive ensemble stories. Give every character a reason to be in the scene and something at stake.", messages: [{ role: "user", content: `Characters:\n${castDesc}\n\nUser persona: ${persona?.name || "the user"}${persona?.description ? " — " + persona.description : ""}\n${world ? `World: ${world.name} — ${world.description?.slice(0, 500)}` : ""}\n${idea ? `Idea from the user: ${idea}` : "No idea given; invent an intriguing situation."}` }], effort: genEffort(s), maxTokens: 4000 });
  return data;
}

/** Turn a generated newcomer / bystander into a full character card. */
export async function promoteNpc(s, { name, brief, context }) {
  return generateCharacter(s, `Name: ${name}. ${brief || ""}${context ? "\nStory context: " + context : ""}\nKeep the name exactly "${name}".`, null);
}

export function narratorDirection(kind, detail) {
  switch (kind) {
    case "time": return `Time skip: ${detail || "some time passes"}. Narrate what changed in the meantime and resume the scene.`;
    case "event": return `Narrator: introduce an unexpected event or complication that fits the story and world${detail ? ": " + detail : ""}. Let it land on the characters naturally.`;
    case "scene": return `Scene change: ${detail || "cut to a new scene"}.`;
    case "narrate": return `Narrator: ${detail}`;
    default: return detail || "";
  }
}

export { estimateTokens, describeError, stripCast };
