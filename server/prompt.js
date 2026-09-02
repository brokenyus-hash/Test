// Prompt assembly + context management: character card, persona, lore triggers,
// rolling summary, long-term memory, live world state, director notes.
import { estimateTokens, supportsMidSystem } from "./claude.js";

const LENGTH_HINTS = {
  short: "Keep replies tight: 1-2 short paragraphs (roughly 60-150 words).",
  medium: "Aim for 2-4 paragraphs (roughly 150-350 words).",
  long: "Write rich, immersive replies of 4-7 paragraphs (roughly 350-700 words).",
  epic: "Write long, novel-like passages (700+ words) when the scene deserves it; never pad.",
};

const REALISM = {
  cinematic: `Realism: cinematic. Keep things dramatic and paced like a great show; small conveniences are fine if they serve the story.`,
  grounded: `Realism: grounded. People behave like real people with their own agendas, moods, fatigue, money, and limits. Actions have plausible consequences. Things take time. Not everyone likes {{user}}; trust and affection are earned through what actually happens.`,
  brutal: `Realism: unforgiving. The world is indifferent. Bad decisions bite, injuries matter, resources run out, NPCs remember slights, and {{char}} will refuse, lie, leave, or push back when it is in character. Never bend the world to please {{user}}.`,
};

export function sub(text, { charName, userName }) {
  return (text || "")
    .replaceAll("{{char}}", charName || "the character")
    .replaceAll("{{user}}", userName || "you");
}

function section(title, body) {
  body = (body || "").trim();
  return body ? `## ${title}\n${body}\n` : "";
}

function list(arr) {
  return (arr || []).filter(Boolean).map((x) => `- ${x}`).join("\n");
}

/** Deterministic, stable-per-config system prompt. Keep volatile info OUT of here (caching). */
export function buildSystemPrompt({ chat, character, persona, world, s }) {
  const charName = character?.name || "Narrator";
  const userName = persona?.name || "the user";
  const ctx = { charName, userName };
  const narrator = chat.mode === "narrator";

  const parts = [];
  if (narrator) {
    parts.push(
      `You are the Game Master and narrator of an interactive, open-ended roleplay with ${userName}. ` +
      `You voice every character except ${userName}, describe the world, and let ${userName} decide their own actions. ` +
      (character ? `The central character of this story is ${charName}.` : "")
    );
  } else {
    parts.push(
      `You are ${charName}, fully in character, in an interactive roleplay with ${userName}. ` +
      `Stay ${charName} at all times; write ${charName}'s dialogue, actions, and inner texture. ` +
      `You may also voice side characters and describe the environment when the scene needs it.`
    );
  }

  if (character) {
    parts.push(section(`Character: ${charName}`, [
      character.tagline ? `Tagline: ${sub(character.tagline, ctx)}` : "",
      section("Description", sub(character.description, ctx)),
      section("Personality", sub(character.personality, ctx)),
      section("Appearance", sub(character.appearance, ctx)),
      section("Backstory", sub(character.backstory, ctx)),
      section("Speech & mannerisms", sub(character.speech_style, ctx)),
      character.likes?.length ? section("Likes", list(character.likes)) : "",
      character.dislikes?.length ? section("Dislikes", list(character.dislikes)) : "",
      character.goals?.length ? section("Goals & motivations", list(character.goals)) : "",
      character.secrets ? section("Secrets (never state these outright; let them surface through behavior)", sub(character.secrets, ctx)) : "",
      character.relationships?.length ? section("Relationships", list(character.relationships)) : "",
    ].filter(Boolean).join("\n")));
  }

  if (persona) {
    parts.push(section(`${userName} (the user's persona)`, [
      sub(persona.description, ctx),
      persona.appearance ? `Appearance: ${sub(persona.appearance, ctx)}` : "",
    ].filter(Boolean).join("\n") + `\nNever write ${userName}'s dialogue, decisions, or thoughts. Only ${userName} controls ${userName}.`));
  }

  if (world) {
    const always = (world.entries || []).filter((e) => e.always_on && e.content);
    parts.push(section(`World: ${world.name}`, [
      sub(world.description, ctx),
      ...always.map((e) => `### ${e.name}\n${sub(e.content, ctx)}`),
    ].filter(Boolean).join("\n\n")));
  }

  const scenario = chat.scenario || character?.scenario;
  if (scenario) parts.push(section("Scenario", sub(scenario, ctx)));

  if (character?.example_dialogue) {
    parts.push(section("Example of how the character talks (style reference only; do not repeat verbatim)", sub(character.example_dialogue, ctx)));
  }

  parts.push(section("Simulation rules", [
    sub(REALISM[s.realism] || REALISM.grounded, ctx),
    `Time passes. Track the time of day, the date, weather, and where everyone is; let those shape the scene. Nights end, people get hungry, wounds heal slowly.`,
    `${charName} has their own goals, opinions, and memory. They remember what ${userName} did and said, hold grudges, warm up, get bored, and can say no.`,
    `Side characters have lives outside the scene. Reintroduce them consistently.`,
    `Continuity is sacred: never contradict established facts in the story so far, the memory list, or the world state you are given.`,
    `Let ${userName} act. End your reply at a natural point where ${userName} can respond: a question, a choice, a beat that invites reaction. Do not narrate ${userName}'s actions, feelings, or dialogue.`,
    `Show, don't tell. Use concrete sensory detail, subtext, and body language. Avoid summarizing emotions the reader can infer.`,
    `Vary rhythm and vocabulary. Avoid stock phrases, repeated openers, and ending every reply the same way.`,
  ].join("\n")));

  parts.push(section("Format", [
    s.pov === "third" ? `Write in third person${s.tense === "past" ? ", past tense" : ", present tense"}.` : `Address ${userName} as "you"; write ${charName} in third person${s.tense === "past" ? ", past tense" : ", present tense"}.`,
    `Wrap actions and narration in *asterisks* and put spoken dialogue in plain text with quotation marks.`,
    LENGTH_HINTS[s.replyLength] || LENGTH_HINTS.medium,
    `Never break character or add out-of-character commentary unless the user writes an explicit (OOC: ...) note; answer OOC notes briefly in (OOC: ...) form and then continue the scene.`,
    `Do not include headings, bullet lists, or meta-notes in the reply. Pure prose and dialogue.`,
  ].join("\n")));

  return parts.join("\n");
}

/** Find lore entries triggered by keywords in the recent text. */
export function triggeredLore(world, recentText, budget) {
  if (!world?.entries?.length) return [];
  const hay = recentText.toLowerCase();
  const hits = [];
  for (const e of world.entries) {
    if (e.always_on || !e.content) continue;
    const kws = (e.keywords || []).map((k) => k.trim().toLowerCase()).filter(Boolean);
    if (!kws.length) continue;
    if (kws.some((k) => hay.includes(k))) hits.push(e);
  }
  hits.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const out = [];
  let used = 0;
  for (const e of hits) {
    const t = estimateTokens(e.content);
    if (used + t > budget) continue;
    used += t;
    out.push(e);
  }
  return out;
}

export function formatState(state) {
  if (!state) return "";
  const lines = [];
  if (state.time) lines.push(`Time: ${state.time}`);
  if (state.location) lines.push(`Location: ${state.location}`);
  if (state.weather) lines.push(`Weather / atmosphere: ${state.weather}`);
  if (state.character_mood) lines.push(`Character mood: ${state.character_mood}`);
  if (state.character_status) lines.push(`Character status: ${state.character_status}`);
  if (state.relationship) lines.push(`Relationship with the user: ${state.relationship.label || ""} (${state.relationship.score ?? 0}/100)${state.relationship.note ? " - " + state.relationship.note : ""}`);
  if (state.present_npcs?.length) lines.push(`Present: ${state.present_npcs.map((n) => `${n.name}${n.role ? " (" + n.role + ")" : ""}${n.disposition ? ", " + n.disposition : ""}`).join("; ")}`);
  if (state.inventory?.length) lines.push(`User's notable items: ${state.inventory.join(", ")}`);
  if (state.character_goals?.length) lines.push(`Character's current goals: ${state.character_goals.join("; ")}`);
  if (state.active_threads?.length) lines.push(`Open threads: ${state.active_threads.map((t) => `${t.title} [${t.status}]${t.note ? " - " + t.note : ""}`).join("; ")}`);
  return lines.join("\n");
}

/**
 * Assemble the messages array for a reply.
 * @returns {{system: any[], messages: any[], dynamicContext: string, history: any[], stats: object}}
 */
export function buildMessages({ chat, character, persona, world, s, history, extraInstruction, model, provider = "anthropic" }) {
  const charName = character?.name || "Narrator";
  const userName = persona?.name || "the user";
  const ctx = { charName, userName };

  const systemText = buildSystemPrompt({ chat, character, persona, world, s });
  const system = [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }];

  // History after the summary cutoff.
  const cutoff = chat.summary_seq ?? -1;
  const visible = history.filter((m) => m.seq > cutoff && !m.hidden);
  const msgs = [];
  for (const m of visible) {
    const text = (m.alternatives?.[m.active ?? 0] ?? "").trim();
    if (!text) continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    const rendered = m.kind === "direction" ? `[${text}]` : text;
    msgs.push({ role, content: [{ type: "text", text: rendered }] });
  }
  if (msgs.length === 0 || msgs[0].role !== "user") {
    msgs.unshift({ role: "user", content: [{ type: "text", text: "(The scene begins.)" }] });
  }
  // Merge consecutive same-role messages for cleanliness.
  const merged = [];
  for (const m of msgs) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content.push(...m.content);
    else merged.push({ role: m.role, content: [...m.content] });
  }
  if (merged[merged.length - 1].role !== "user") {
    merged.push({ role: "user", content: [{ type: "text", text: "(Continue.)" }] });
  }
  // Cache breakpoint on the last user turn so the whole prefix is reusable next turn.
  const lastUser = merged[merged.length - 1];
  lastUser.content[lastUser.content.length - 1].cache_control = { type: "ephemeral" };

  // Dynamic context (volatile; goes AFTER the cached prefix).
  const recentText = merged.slice(-6).flatMap((m) => m.content.map((c) => c.text)).join("\n");
  const lore = triggeredLore(world, recentText, s.loreBudget);
  const dyn = [];
  if (chat.summary) dyn.push(`### Story so far\n${chat.summary}`);
  if (chat.memory?.length) dyn.push(`### Established facts (long-term memory)\n${list(chat.memory.map((f) => (typeof f === "string" ? f : f.text)))}`);
  const st = formatState(chat.state);
  if (st) dyn.push(`### Current world state\n${st}`);
  if (lore.length) dyn.push(`### Relevant lore\n${lore.map((e) => `**${e.name}**: ${sub(e.content, ctx)}`).join("\n")}`);
  if (chat.director_note) dyn.push(`### Director's standing note\n${chat.director_note}`);
  if (extraInstruction) dyn.push(`### Instruction for this reply\n${extraInstruction}`);
  const dynamicContext = dyn.length
    ? `Context for your next reply (this is reference material, not part of the story; never mention it):\n\n${dyn.join("\n\n")}`
    : "";

  const messages = [...merged];
  if (dynamicContext) {
    if (provider === "xai" || supportsMidSystem(model)) {
      messages.push({ role: "system", content: dynamicContext });
    } else {
      // Fallback: append as a text block on the last user turn (after the cache breakpoint).
      lastUser.content.push({ type: "text", text: `<context>\n${dynamicContext}\n</context>` });
    }
  }

  const stats = {
    systemTokens: estimateTokens(systemText),
    historyTokens: merged.reduce((a, m) => a + m.content.reduce((b, c) => b + estimateTokens(c.text), 0), 0),
    contextTokens: estimateTokens(dynamicContext),
    historyMessages: visible.length,
    summarizedMessages: history.filter((m) => m.seq <= cutoff).length,
    loreTriggered: lore.map((e) => e.name),
  };
  return { system, messages, dynamicContext, stats };
}

/** Pick which messages should be folded into the rolling summary. */
export function pickForSummary({ chat, history, s }) {
  const cutoff = chat.summary_seq ?? -1;
  const visible = history.filter((m) => m.seq > cutoff && !m.hidden);
  const tokens = visible.reduce((a, m) => a + estimateTokens(m.alternatives?.[m.active ?? 0] || ""), 0);
  if (tokens <= s.contextBudget) return null;
  const target = Math.floor(s.contextBudget * 0.55);
  let remaining = tokens;
  const fold = [];
  for (const m of visible) {
    if (visible.length - fold.length <= s.keepRecent) break;
    if (remaining <= target) break;
    fold.push(m);
    remaining -= estimateTokens(m.alternatives?.[m.active ?? 0] || "");
  }
  return fold.length ? fold : null;
}
