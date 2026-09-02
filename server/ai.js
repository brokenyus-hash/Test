// High-level AI operations: streaming replies, world-state extraction, rolling
// summaries, character/world generation, action suggestions, impersonation.
import { z } from "zod";
import * as db from "./db.js";
import { settings, resolveModels, estimateTokens } from "./claude.js";
import { streamText, structured as providerStructured, complete as providerComplete, describeError } from "./provider.js";
import { buildMessages, pickForSummary, formatState, sub } from "./prompt.js";

const text = (m) => m.alternatives?.[m.active ?? 0] ?? "";

export function loadChatContext(chatId) {
  const chat = db.chats.get(chatId);
  if (!chat) throw Object.assign(new Error("Chat not found"), { status: 404 });
  const character = chat.character_id ? db.characters.get(chat.character_id) : null;
  const persona = chat.persona_id ? db.personas.get(chat.persona_id) : null;
  const world = chat.world_id ? db.worlds.get(chat.world_id) : (character?.world_id ? db.worlds.get(character.world_id) : null);
  const s = resolveModels({ ...settings(), ...(chat.settings || {}) });
  if (chat.settings?.model) s.activeModel = chat.settings.model; // per-chat override
  const history = db.messages.list(chatId);
  return { chat, character, persona, world, s, history };
}

// Provider-aware helpers: utility calls use the utility model unless a model is given.
// Creative generation effort: Grok's "high" reasoning takes minutes per card, so use low reasoning there.
const genEffort = () => (settings().provider === "xai" ? "low" : "high");
const structured = (p) => { const s = settings(); return providerStructured({ provider: s.provider, model: s.activeUtilityModel, effort: s.utilityEffort, maxTokens: 8000, ...p }); };
const complete = (p) => { const s = settings(); return providerComplete({ provider: s.provider, model: s.activeUtilityModel, effort: s.utilityEffort, maxTokens: 4000, ...p }); };

// ---------------------------------------------------------------- summaries
export async function maybeSummarize(ctx, emit) {
  const { chat, character, persona, s, history } = ctx;
  if (!s.autoSummarize) return null;
  const fold = pickForSummary({ chat, history, s });
  if (!fold) return null;
  emit?.("status", { text: `Condensing ${fold.length} older messages into memory…` });
  const charName = character?.name || "Narrator";
  const userName = persona?.name || "User";
  const transcript = fold.map((m) => `${m.role === "assistant" ? charName : userName}: ${text(m)}`).join("\n\n");
  const prompt = [
    chat.summary ? `Existing summary of everything before this point:\n${chat.summary}\n\n` : "",
    `New transcript to fold into the summary:\n${transcript}\n\n`,
    `Write an updated, self-contained summary of the story so far (existing summary + new transcript). ` +
    `Preserve: key events in order, decisions and their consequences, promises, injuries, items gained or lost, ` +
    `where characters are, relationship shifts, unresolved threads, and any specific names, places, or numbers. ` +
    `Write in past tense, third person, dense but readable, under 700 words. Output only the summary.`,
  ].join("");
  const { text: summary } = await complete({
    system: "You are a meticulous continuity editor for an ongoing interactive story.",
    messages: [{ role: "user", content: prompt }],
    maxTokens: 2000,
  });
  const summary_seq = fold[fold.length - 1].seq;
  db.chats.update(chat.id, { summary: summary.trim(), summary_seq }, { touch: false });
  chat.summary = summary.trim();
  chat.summary_seq = summary_seq;
  emit?.("summary", { summary: chat.summary, summary_seq });
  return chat.summary;
}

// ---------------------------------------------------------------- world state
const StateSchema = z.object({
  time: z.string().describe("In-world date and time of day, e.g. 'Day 3, Tuesday, 21:40 (night)'"),
  location: z.string().describe("Where the scene is happening right now"),
  weather: z.string().describe("Weather and ambient atmosphere"),
  character_mood: z.string().describe("The main character's current emotional state, in a few words"),
  character_status: z.string().describe("What the main character is doing / physical state"),
  relationship: z.object({
    score: z.number().describe("-100 (hatred) to 100 (devotion); move it only when something earns it"),
    label: z.string().describe("Short label: strangers, wary, friendly, close, lovers, rivals, enemies…"),
    note: z.string().describe("One sentence on the current dynamic"),
  }),
  present_npcs: z.array(z.object({
    name: z.string(),
    role: z.string(),
    disposition: z.string().describe("attitude toward the user right now"),
  })).describe("Other characters currently in the scene (exclude the main character and the user)"),
  inventory: z.array(z.string()).describe("Notable items the user currently carries or owns"),
  character_goals: z.array(z.string()).describe("The main character's active goals or intentions"),
  active_threads: z.array(z.object({
    title: z.string(),
    status: z.enum(["open", "progressing", "resolved", "failed"]),
    note: z.string(),
  })).describe("Plot threads, quests, promises, mysteries"),
  new_facts: z.array(z.string()).describe("NEW durable facts established in this exchange worth remembering forever (names, revelations, decisions). Empty if none."),
  events: z.array(z.string()).describe("1-3 short past-tense lines describing what happened in this exchange"),
});

export async function extractState(ctx, lastUser, lastAssistant, emit) {
  const { chat, character, persona, s } = ctx;
  if (!s.autoState) return null;
  emit?.("status", { text: "Updating world state…" });
  const charName = character?.name || "the narrator";
  const userName = persona?.name || "the user";
  const prev = chat.state ? formatState(chat.state) : "(no state yet - initialise from the scene; if the story gives no time, invent a plausible one)";
  const prompt = [
    `Main character: ${charName}. User: ${userName}.`,
    chat.summary ? `Story so far: ${chat.summary}` : "",
    `Previous world state:\n${prev}`,
    `Latest exchange:\n${userName}: ${lastUser || "(scene start)"}\n\n${charName}: ${lastAssistant}`,
    `Produce the complete updated world state after this exchange. Carry forward everything still true; change only what the exchange changed. ` +
    `Advance time realistically. Relationship score moves in small steps (usually ±1 to ±8) unless something dramatic happened.`,
  ].filter(Boolean).join("\n\n");
  const { data } = await structured({
    schema: StateSchema,
    system: "You are the continuity and state tracker for an interactive story. Be precise and conservative.",
    messages: [{ role: "user", content: prompt }],
    maxTokens: 4000,
  });
  const { new_facts, events, ...state } = data;
  // Merge memory (dedupe, cap).
  const memory = [...(chat.memory || [])];
  const known = new Set(memory.map((f) => (typeof f === "string" ? f : f.text).toLowerCase()));
  for (const f of new_facts || []) {
    if (!known.has(f.toLowerCase())) { memory.push({ text: f, at: Date.now(), pinned: false }); known.add(f.toLowerCase()); }
  }
  const pinned = memory.filter((f) => f.pinned);
  const rest = memory.filter((f) => !f.pinned);
  const capped = [...pinned, ...rest.slice(-80)];
  db.chats.update(chat.id, { state, memory: capped }, { touch: false });
  chat.state = state;
  chat.memory = capped;
  return { state, memory: capped, events: events || [], new_facts: new_facts || [] };
}

// ---------------------------------------------------------------- streaming reply
/**
 * Generate a reply and stream it. `emit(event, payload)` is called for:
 * status, delta, thinking, done, state, summary, error.
 * mode: 'reply' (normal) | 'regen' (replace target message alt) | 'continue' (extend last assistant)
 */
export async function streamReply({ chatId, emit, signal, mode = "reply", targetMessageId = null, instruction = null }) {
  const ctx = loadChatContext(chatId);
  const { chat, character, persona, world, s } = ctx;
  await maybeSummarize(ctx, emit).catch((e) => emit("status", { text: `Summary skipped: ${describeError(e)}` }));
  ctx.history = db.messages.list(chatId);

  let history = ctx.history;
  let extra = instruction;
  let target = targetMessageId ? db.messages.get(targetMessageId) : null;

  if (mode === "regen" && target) {
    history = history.filter((m) => m.seq < target.seq);
  } else if (mode === "continue") {
    target = [...history].reverse().find((m) => m.role === "assistant") || null;
    extra = (extra ? extra + "\n" : "") + "Continue your previous reply from exactly where it stopped. Do not repeat or rephrase what was already written; pick up mid-flow and carry the scene forward.";
    history = [...history, { seq: 1e9, role: "user", alternatives: ["(Continue.)"], active: 0 }];
  }

  const model = s.activeModel;
  const built = buildMessages({ chat, character, persona, world, s, history, extraInstruction: extra, model, provider: s.provider });
  emit("status", { text: "Writing…", stats: built.stats });

  const r = await streamText({
    provider: s.provider, model, system: built.system, messages: built.messages,
    maxTokens: Number(s.maxTokens) || 4096, effort: s.effort, showThinking: s.showThinking, fallbacks: s.fallbacks, signal,
    onDelta: (t) => emit("delta", { text: t }),
    onThinking: (t) => emit("thinking", { text: t }),
  });
  let out = r.text.trim();
  const thinking = r.thinking;
  const usage = r.usage;
  if (r.stopReason === "refusal") {
    if (!out) throw new Error(`Refused: ${r.note}`);
    emit("status", { text: `Note: the model stopped early (${r.note}).` });
  }
  if (!out) throw new Error("Empty reply from the model.");

  // Persist.
  let saved;
  if (mode === "regen" && target) {
    const alts = [...(target.alternatives || [])];
    alts.push(out);
    saved = db.messages.update(target.id, { alternatives: alts, active: alts.length - 1, thinking: thinking || target.thinking, usage, stopped: !!signal?.aborted });
  } else if (mode === "continue" && target) {
    const alts = [...(target.alternatives || [])];
    const i = target.active ?? 0;
    const sep = /\s$/.test(alts[i]) || /^[,.;:!?]/.test(out) ? "" : (/[.!?*"”]$/.test(alts[i]) ? "\n\n" : " ");
    alts[i] = alts[i] + sep + out;
    saved = db.messages.update(target.id, { alternatives: alts, usage });
  } else {
    saved = db.messages.add(chatId, { role: "assistant", text: out, thinking: thinking || undefined, usage, stopped: !!signal?.aborted });
  }
  emit("done", { message: saved, usage, stats: built.stats });

  // Post-processing: world state + timeline (not on aborted partials).
  if (!signal?.aborted) {
    try {
      const lastUser = [...db.messages.list(chatId)].reverse().find((m) => m.role === "user" && m.seq < saved.seq);
      const res = await extractState(ctx, lastUser ? text(lastUser) : "", text(saved), emit);
      if (res) {
        if (mode === "regen") db.timeline.removeForMessages(chatId, [saved.id]);
        for (const ev of res.events) db.timeline.add(chatId, { message_id: saved.id, kind: "event", text: ev });
        for (const f of res.new_facts) db.timeline.add(chatId, { message_id: saved.id, kind: "fact", text: f });
        emit("state", { state: res.state, memory: res.memory, events: res.events, timeline: db.timeline.list(chatId) });
      }
    } catch (e) {
      emit("status", { text: `State update skipped: ${describeError(e)}` });
    }
    if (s.autoSuggest) {
      try { emit("suggestions", { suggestions: await suggestActions(chatId) }); } catch { /* optional */ }
    }
    // Auto-title after the first real exchange.
    const cur = db.chats.get(chatId);
    if (cur && /^New chat|^Chat with /.test(cur.title) && db.messages.list(chatId).length >= 3) {
      try {
        const t = await autoTitle(chatId);
        if (t) emit("title", { title: t });
      } catch { /* optional */ }
    }
  }
}

export async function autoTitle(chatId) {
  const ctx = loadChatContext(chatId);
  const transcript = ctx.history.slice(0, 6).map((m) => `${m.role}: ${text(m).slice(0, 400)}`).join("\n");
  const { text: t } = await complete({
    system: "You name stories. Reply with only a title.",
    messages: [{ role: "user", content: `Give this roleplay a short evocative title (2-6 words, no quotes):\n\n${transcript}` }],
    maxTokens: 60,
  });
  const title = t.trim().split("\n")[0].replace(/^["'“”*]+|["'“”*.]+$/g, "").trim().slice(0, 80);
  if (title) db.chats.update(chatId, { title }, { touch: false });
  return title;
}

// ---------------------------------------------------------------- suggestions
const SuggestSchema = z.object({
  suggestions: z.array(z.object({
    label: z.string().describe("3-8 word label, e.g. 'Ask about the letter'"),
    text: z.string().describe("The full message the user could send, written in the user's voice with *actions* and dialogue"),
    tone: z.enum(["bold", "cautious", "kind", "clever", "romantic", "hostile", "funny", "curious"]),
  })).min(3).max(5),
});

export async function suggestActions(chatId) {
  const ctx = loadChatContext(chatId);
  const { chat, character, persona, s } = ctx;
  const charName = character?.name || "the narrator";
  const userName = persona?.name || "you";
  const recent = ctx.history.slice(-8).map((m) => `${m.role === "assistant" ? charName : userName}: ${text(m)}`).join("\n\n");
  const { data } = await structured({
    schema: SuggestSchema,
    system: `You propose what ${userName} might do next in an interactive story. Offer genuinely different directions (not paraphrases). Stay in ${userName}'s voice; never decide outcomes.`,
    messages: [{ role: "user", content: `${chat.summary ? "Story so far: " + chat.summary + "\n\n" : ""}${chat.state ? "World state:\n" + formatState(chat.state) + "\n\n" : ""}Recent scene:\n${recent}\n\nPropose 4 distinct next actions for ${userName}.` }],
    maxTokens: 2500,
  });
  return data.suggestions;
}

// ---------------------------------------------------------------- impersonate
export async function impersonate(chatId, hint) {
  const ctx = loadChatContext(chatId);
  const { chat, character, persona, s } = ctx;
  const charName = character?.name || "the narrator";
  const userName = persona?.name || "the user";
  const recent = ctx.history.slice(-10).map((m) => `${m.role === "assistant" ? charName : userName}: ${text(m)}`).join("\n\n");
  const { text: t } = await complete({
    system: `You write the next message for ${userName} in an interactive story, in first person as ${userName}. ${persona?.description ? "About " + userName + ": " + persona.description : ""} Match the established writing format (*actions*, "dialogue"). Never write for ${charName}. Output only the message.`,
    messages: [{ role: "user", content: `${chat.summary ? "Story so far: " + chat.summary + "\n\n" : ""}Recent scene:\n${recent}\n\n${hint ? "Direction: " + hint + "\n\n" : ""}Write ${userName}'s next message (1-3 paragraphs).` }],
    maxTokens: 1500,
    effort: s.effort,
  });
  return t.trim();
}

// ---------------------------------------------------------------- character generation
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

export async function generateCharacter(prompt, existing) {
  const { data } = await structured({
    schema: CharacterSchema,
    system: "You are an expert character designer for interactive fiction. Create vivid, specific, internally consistent characters with real flaws and hooks for play. Use {{user}} to refer to the person they'll talk to and {{char}} for themselves inside greetings and example dialogue.",
    messages: [{ role: "user", content: existing
      ? `Here is a partial character card as JSON. Fill in every missing or thin field and improve weak ones while preserving what is already established:\n${JSON.stringify(existing, null, 2)}\n\nExtra guidance: ${prompt || "none"}`
      : `Create a complete character from this concept:\n${prompt}` }],
    effort: genEffort(),
    maxTokens: 12000,
  });
  return data;
}

export async function enhanceField(character, field, guidance) {
  const { text: t } = await complete({
    system: "You are an expert character writer for interactive fiction. Output only the rewritten field text, no preamble.",
    messages: [{ role: "user", content: `Character card:\n${JSON.stringify(character, null, 2)}\n\nRewrite/expand the field "${field}" so it is vivid, specific and consistent with the rest of the card.${guidance ? " Guidance: " + guidance : ""}${field === "greeting" ? " Write it as an in-scene opening message with *actions* and dialogue, addressed to {{user}}." : ""}` }],
    effort: genEffort(),
    maxTokens: 3000,
  });
  return t.trim();
}

// ---------------------------------------------------------------- world generation
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

export async function generateWorld(prompt) {
  const { data } = await structured({
    schema: WorldSchema,
    system: "You are a worldbuilder for interactive fiction. Build settings with texture: places, factions, customs, dangers, notable people, and secrets. Lore entries must be triggerable by concrete keywords.",
    messages: [{ role: "user", content: `Build a world from this concept:\n${prompt}` }],
    effort: genEffort(),
    maxTokens: 14000,
  });
  return data;
}

// ---------------------------------------------------------------- narrator actions
export function narratorDirection(kind, detail) {
  switch (kind) {
    case "time": return `Time skip: ${detail || "some time passes"}. Narrate what changed in the meantime and resume the scene.`;
    case "event": return `Narrator: introduce an unexpected event or complication that fits the story and world${detail ? ": " + detail : ""}. Let it land on the characters naturally.`;
    case "scene": return `Scene change: ${detail || "cut to a new scene"}.`;
    case "narrate": return `Narrator: ${detail}`;
    default: return detail || "";
  }
}

export { estimateTokens, describeError };
