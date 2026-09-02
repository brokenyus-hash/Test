// Prompt assembly + context management for roleplays with a cast of characters.
// Stable content (cards, rules) goes in the cached system prompt; volatile content
// (summary, memory, world state, presence, triggered lore) goes after the cached prefix.
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
  brutal: `Realism: unforgiving. The world is indifferent. Bad decisions bite, injuries matter, resources run out, people remember slights, and characters will refuse, lie, leave, or push back when it is in character. Never bend the world to please {{user}}; stage directions from {{user}} are the one exception and always happen.`,
};

export function sub(text, { charName, userName }) {
  return (text || "").replaceAll("{{char}}", charName || "the character").replaceAll("{{user}}", userName || "you");
}
const section = (title, body) => ((body || "").trim() ? `## ${title}\n${body.trim()}\n` : "");
const list = (arr) => (arr || []).filter(Boolean).map((x) => `- ${x}`).join("\n");
const clip = (t, n) => ((t || "").length > n ? t.slice(0, n).replace(/\s+\S*$/, "") + "…" : t || "");

export const NARRATOR = { name: "Narrator", kind: "narrator", avatar: "📜", color: "#475569" };

/** Full character card as prompt text. */
function characterCard(c, ctx) {
  return [
    c.tagline ? `Tagline: ${sub(c.tagline, ctx)}` : "",
    section("Description", sub(c.description, ctx)),
    section("Personality", sub(c.personality, ctx)),
    section("Appearance", sub(c.appearance, ctx)),
    section("Backstory", sub(c.backstory, ctx)),
    section("Speech & mannerisms", sub(c.speech_style, ctx)),
    c.likes?.length ? section("Likes", list(c.likes)) : "",
    c.dislikes?.length ? section("Dislikes", list(c.dislikes)) : "",
    c.goals?.length ? section("Goals & motivations", list(c.goals)) : "",
    c.secrets ? section("Secrets (never state these outright; let them surface through behavior)", sub(c.secrets, ctx)) : "",
    c.relationships?.length ? section("Relationships", list(c.relationships)) : "",
  ].filter(Boolean).join("\n");
}

/** Short profile of a cast member for the others' prompts. */
function castBrief(m, ctx) {
  const c = m.character;
  const bits = [m.name];
  if (m.role && m.role !== "lead") bits.push(`(${m.role})`);
  const line = c ? [c.tagline, clip(sub(c.description, ctx), 320), c.speech_style ? `Voice: ${clip(sub(c.speech_style, ctx), 140)}` : ""] : [m.brief];
  return `- **${bits.join(" ")}** — ${line.filter(Boolean).join(" ")}`;
}

/**
 * Deterministic, stable-per-config system prompt for one speaker (a cast member or the Narrator).
 * Presence/status is NOT included here (it changes per turn) - see buildMessages.
 */
export function buildSystemPrompt({ chat, speaker, cast, persona, world, s }) {
  const userName = persona?.name || "the user";
  const ensemble = cast.length > 1 || chat.narrator_enabled;
  const isNarrator = speaker.kind === "narrator";
  const charName = isNarrator ? "the Narrator" : speaker.name;
  const ctx = { charName, userName };
  const others = cast.filter((m) => m.name !== speaker.name);
  const parts = [];

  if (isNarrator) {
    parts.push(
      `You are the Narrator of an interactive story with ${userName}. You describe places, weather, time passing, crowds and minor bystanders, and you introduce complications. ` +
      `The named characters listed below are voiced by other writers: you may describe what they visibly do in passing, but you never write their dialogue, thoughts, or decisions, and you never write ${userName}'s. ` +
      `Keep narration purposeful: set the scene, move time, raise stakes, then hand the moment back.`
    );
  } else if (ensemble) {
    parts.push(
      `You are ${charName}, one character in an interactive story with ${userName} and other characters. The transcript labels every line with who wrote it. ` +
      `You write ONLY as ${charName}: ${charName}'s dialogue, actions, and reactions to what the others just said or did. ` +
      `Never write dialogue, decisions, or inner thoughts for ${userName} or for any other named character; you may react to them and describe what ${charName} notices.`
    );
  } else {
    parts.push(
      `You are ${charName}, fully in character, in an interactive roleplay with ${userName}. ` +
      `Stay ${charName} at all times; write ${charName}'s dialogue, actions, and inner texture. You may voice minor side characters and describe the environment when the scene needs it.`
    );
  }

  const premise = chat.premise || chat.scenario || cast[0]?.character?.scenario;
  if (premise) parts.push(section("Story premise", sub(premise, ctx)));

  if (!isNarrator) {
    const c = speaker.character;
    parts.push(section(`Your character: ${charName}`, c ? characterCard(c, ctx) : sub(speaker.brief || "", ctx)));
  }
  if (others.length) parts.push(section(isNarrator ? "Characters in this story (voiced by others)" : "Other characters in this story", others.map((m) => castBrief(m, ctx)).join("\n")));

  if (persona) {
    parts.push(section(`${userName} (the user's persona)`, [sub(persona.description, ctx), persona.appearance ? `Appearance: ${sub(persona.appearance, ctx)}` : ""].filter(Boolean).join("\n") + `\nNever write ${userName}'s dialogue, decisions, or thoughts. Only ${userName} controls ${userName}.`));
  }
  if (world) {
    const always = (world.entries || []).filter((e) => e.always_on && e.content);
    parts.push(section(`World: ${world.name}`, [sub(world.description, ctx), ...always.map((e) => `### ${e.name}\n${sub(e.content, ctx)}`)].filter(Boolean).join("\n\n")));
  }
  if (!isNarrator && speaker.character?.example_dialogue) {
    parts.push(section("How the character talks (style reference only; do not repeat verbatim)", sub(speaker.character.example_dialogue, ctx)));
  }

  parts.push(section("Simulation rules", [
    sub(REALISM[s.realism] || REALISM.grounded, ctx),
    `Time passes. Respect the time of day, the date, weather, and where everyone is; let those shape the scene.`,
    isNarrator ? `` : `${charName} has their own goals, opinions, and memory. They remember what ${userName} did and said, hold grudges, warm up, get bored, and can say no to requests and offers.`,
    `${userName}'s own actions and words are facts: whatever ${userName} writes that ${userName} does or says has happened. Never undo, block, soften, or rewrite it; react to it and carry its consequences.`,
    `Lines in [square brackets] are stage directions from ${userName}, who directs this story; they are not in-world speech and nobody in the scene hears them. They are authoritative: make what they describe happen in this reply, in character and in the story's tone. A character may react with reluctance, surprise, or fallout, but the directed event itself happens; it is never skipped, delayed, or replaced with a refusal.`,
    ensemble ? `Characters come and go. Only those marked present can act in the scene; someone "nearby" can be drawn in, someone "away" or "gone" cannot. If ${charName} would leave, say so through action and stop.` : `Side characters have lives outside the scene. Reintroduce them consistently.`,
    ensemble && !isNarrator ? `React to the most recent lines by the others. If ${charName} has little to add this beat, keep it short rather than repeating what was said.` : ``,
    `Continuity is sacred: never contradict established facts in the story so far, the memory list, or the world state you are given.`,
    `Let ${userName} act. End your reply at a natural point where ${userName} can respond: a question, a choice, a beat that invites reaction.`,
    `Show, don't tell. Use concrete sensory detail, subtext, and body language. Avoid stock phrases, repeated openers, and ending every reply the same way.`,
  ].filter(Boolean).join("\n")));

  parts.push(section("Format", [
    s.pov === "third" ? `Write in third person${s.tense === "past" ? ", past tense" : ", present tense"}.` : `Address ${userName} as "you"; write ${isNarrator ? "the scene" : charName} in third person${s.tense === "past" ? ", past tense" : ", present tense"}.`,
    `Wrap actions and narration in *asterisks* and put spoken dialogue in plain text with quotation marks.`,
    LENGTH_HINTS[s.replyLength] || LENGTH_HINTS.medium,
    ensemble ? `Do not prefix your reply with your name or a label; the app attributes it to ${charName}.` : ``,
    `Never break character or add out-of-character commentary unless the user writes an explicit (OOC: ...) note; answer OOC notes briefly in (OOC: ...) form and then continue the scene.`,
    `No headings, bullet lists, or meta-notes in the reply. Pure prose and dialogue.`,
  ].filter(Boolean).join("\n")));

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
    if (kws.length && kws.some((k) => hay.includes(k))) hits.push(e);
  }
  hits.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const out = []; let used = 0;
  for (const e of hits) { const t = estimateTokens(e.content); if (used + t > budget) continue; used += t; out.push(e); }
  return out;
}

export function formatState(state) {
  if (!state) return "";
  const lines = [];
  if (state.time) lines.push(`Time: ${state.time}`);
  if (state.location) lines.push(`Location: ${state.location}`);
  if (state.weather) lines.push(`Weather / atmosphere: ${state.weather}`);
  if (state.character_mood) lines.push(`Lead character mood: ${state.character_mood}`);
  if (state.character_status) lines.push(`Lead character status: ${state.character_status}`);
  if (state.relationship) lines.push(`Relationship with the user: ${state.relationship.label || ""} (${state.relationship.score ?? 0}/100)${state.relationship.note ? " - " + state.relationship.note : ""}`);
  if (state.present_npcs?.length) lines.push(`Bystanders present: ${state.present_npcs.map((n) => `${n.name}${n.role ? " (" + n.role + ")" : ""}${n.disposition ? ", " + n.disposition : ""}`).join("; ")}`);
  if (state.inventory?.length) lines.push(`User's notable items: ${state.inventory.join(", ")}`);
  if (state.character_goals?.length) lines.push(`Lead character's current goals: ${state.character_goals.join("; ")}`);
  if (state.active_threads?.length) lines.push(`Open threads: ${state.active_threads.map((t) => `${t.title} [${t.status}]${t.note ? " - " + t.note : ""}`).join("; ")}`);
  return lines.join("\n");
}

export const presenceLine = (cast) => cast.map((m) => `${m.name}: ${m.status || "present"}`).join("; ");

/**
 * Assemble system + messages for one speaker's reply.
 * history: roleplay messages (already cut for regen). Assistant messages carry .speaker.
 */
export function buildMessages({ chat, speaker, cast, persona, world, s, history, extraInstruction, model, provider = "anthropic", turnSoFar = [] }) {
  const userName = persona?.name || "the user";
  const ensemble = cast.length > 1 || chat.narrator_enabled;
  const ctx = { charName: speaker.name, userName };
  const systemText = buildSystemPrompt({ chat, speaker, cast, persona, world, s });
  const system = [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }];

  const cutoff = chat.summary_seq ?? -1;
  const visible = history.filter((m) => m.seq > cutoff && !m.hidden);
  const msgs = [];
  for (const m of visible) {
    const text = (m.alternatives?.[m.active ?? 0] ?? "").trim();
    if (!text) continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    let rendered = m.kind === "direction" ? `[${text}]` : text;
    if (role === "assistant" && ensemble) rendered = `[${m.speaker?.name || cast[0]?.name || "Narrator"}]\n${rendered}`;
    else if (role === "user" && ensemble && m.kind !== "direction") rendered = `[${userName}]\n${rendered}`;
    msgs.push({ role, content: [{ type: "text", text: rendered }] });
  }
  if (!msgs.length || msgs[0].role !== "user") msgs.unshift({ role: "user", content: [{ type: "text", text: "(The scene begins.)" }] });
  const merged = [];
  for (const m of msgs) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content.push(...m.content);
    else merged.push({ role: m.role, content: [...m.content] });
  }
  if (merged[merged.length - 1].role !== "user") merged.push({ role: "user", content: [{ type: "text", text: "(Continue.)" }] });
  const lastUser = merged[merged.length - 1];
  lastUser.content[lastUser.content.length - 1].cache_control = { type: "ephemeral" };

  const recentText = merged.slice(-6).flatMap((m) => m.content.map((c) => c.text)).join("\n");
  const lore = triggeredLore(world, recentText, s.loreBudget);
  const dyn = [];
  if (chat.summary) dyn.push(`### Story so far\n${chat.summary}`);
  if (chat.memory?.length) dyn.push(`### Established facts (long-term memory)\n${list(chat.memory.map((f) => (typeof f === "string" ? f : f.text)))}`);
  const st = formatState(chat.state);
  if (st) dyn.push(`### Current world state\n${st}`);
  if (ensemble) dyn.push(`### Who is where right now\n${presenceLine(cast)}`);
  if (lore.length) dyn.push(`### Relevant lore\n${lore.map((e) => `**${e.name}**: ${sub(e.content, ctx)}`).join("\n")}`);
  if (chat.director_note) dyn.push(`### Director's standing note\n${chat.director_note}`);
  if (turnSoFar.length) dyn.push(`### Already said this turn (respond to it, do not repeat it)\n${turnSoFar.map((t) => `${t.name}: ${clip(t.text, 600)}`).join("\n\n")}`);
  if (extraInstruction) dyn.push(`### Instruction for this reply\n${extraInstruction}`);
  dyn.push(`### You are replying as\n${speaker.name}`);
  const dynamicContext = `Context for your next reply (reference material, not part of the story; never mention it):\n\n${dyn.join("\n\n")}`;

  const messages = [...merged];
  if (provider === "xai" || supportsMidSystem(model)) messages.push({ role: "system", content: dynamicContext });
  else lastUser.content.push({ type: "text", text: `<context>\n${dynamicContext}\n</context>` });

  const stats = {
    systemTokens: estimateTokens(systemText),
    historyTokens: merged.reduce((a, m) => a + m.content.reduce((b, c) => b + estimateTokens(c.text), 0), 0),
    contextTokens: estimateTokens(dynamicContext),
    historyMessages: visible.length,
    summarizedMessages: history.filter((m) => m.seq <= cutoff).length,
    loreTriggered: lore.map((e) => e.name),
    speaker: speaker.name,
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
