// Character, world/lorebook, persona editors + new-chat dialog.
import * as api from "./api.js";
import { h, avatar, toast, modal, confirm, prompt, field, input, textarea, select, toggle, download, readImageAsDataUrl } from "./ui.js";
import { state, navigate, loadLists, renderSidebar } from "./app.js";

const EMOJIS = ["🧝‍♀️", "🧛", "🧙", "🦊", "🐉", "👸", "🤴", "🧑‍🚀", "🕵️", "🧑‍⚕️", "🧑‍🎤", "🧑‍💻", "🦸", "🦹", "👻", "🤖", "🐺", "🦁", "🐱", "🌙", "🔥", "⚔️", "🎭", "🌹"];

const aiBusy = (btn, on) => { btn.disabled = on; btn.innerHTML = on ? '<span class="spinner"></span> Working…' : btn.dataset.label; };

// ---------------------------------------------------------------- character editor
export async function characterEditor(main, id) {
  const isNew = !id || id === "new";
  const c = isNew
    ? { name: "", tagline: "", description: "", personality: "", appearance: "", backstory: "", speech_style: "", likes: [], dislikes: [], goals: [], secrets: "", relationships: [], scenario: "", greeting: "", alt_greetings: [], example_dialogue: "", tags: [], avatar: EMOJIS[Math.floor(Math.random() * EMOJIS.length)], color: "#8b5cf6", world_id: "" }
    : await api.get(`/api/characters/${id}`);

  const page = h("div", { class: "page editor" });
  const av = avatar(c, "xl");
  const F = {};
  const mk = (key, el) => { F[key] = el; return el; };
  const listField = (key) => mk(key, input((c[key] || []).join(", "), { placeholder: "comma separated" }));

  const aiField = (key, label) => h("button", { class: "btn sm ghost", title: `Let AI write ${label}`, onClick: async (e) => {
    const btn = e.currentTarget; btn.disabled = true; btn.textContent = "…";
    try {
      const guidance = await prompt(`AI: write "${label}"`, { placeholder: "Optional guidance (tone, details to include)…", okText: "Generate" });
      if (guidance === null) return;
      const r = await api.post("/api/ai/generate/field", { character: collect(), field: key, guidance });
      F[key].value = r.text;
    } catch (err) { toast(err.message, "error"); }
    finally { btn.disabled = false; btn.textContent = "✨ AI"; }
  } }, "✨ AI");

  const collect = () => ({
    ...c,
    name: F.name.value.trim(),
    tagline: F.tagline.value.trim(),
    description: F.description.value,
    personality: F.personality.value,
    appearance: F.appearance.value,
    backstory: F.backstory.value,
    speech_style: F.speech_style.value,
    secrets: F.secrets.value,
    scenario: F.scenario.value,
    greeting: F.greeting.value,
    alt_greetings: F.alt_greetings.value.split(/\n---+\n/).map((s) => s.trim()).filter(Boolean),
    example_dialogue: F.example_dialogue.value,
    likes: splitList(F.likes.value),
    dislikes: splitList(F.dislikes.value),
    goals: splitList(F.goals.value),
    relationships: splitList(F.relationships.value),
    tags: splitList(F.tags.value),
    world_id: F.world_id.value || null,
    color: F.color.value,
    avatar: c.avatar,
  });

  const fill = (data) => {
    Object.assign(c, data);
    for (const k of ["name", "tagline", "description", "personality", "appearance", "backstory", "speech_style", "secrets", "scenario", "greeting", "example_dialogue"]) if (F[k] && data[k] != null) F[k].value = data[k];
    if (data.alt_greetings) F.alt_greetings.value = data.alt_greetings.join("\n---\n");
    for (const k of ["likes", "dislikes", "goals", "relationships", "tags"]) if (data[k]) F[k].value = data[k].join(", ");
    if (data.color) F.color.value = data.color;
    if (data.avatar) { c.avatar = data.avatar; refreshAvatar(); }
  };
  const refreshAvatar = () => { const n = avatar({ ...c, color: F.color?.value || c.color }, "xl"); av.replaceWith(n); Object.assign(av, {}); avRef.el = n; n.addEventListener("click", pickAvatar); };
  const avRef = { el: av };
  const pickAvatar = () => {
    const m = modal({ title: "Choose an avatar", body: [
      h("div", { class: "row" }, EMOJIS.map((e) => h("button", { class: "btn", style: { fontSize: "22px" }, onClick: () => { c.avatar = e; refreshAvatar(); m.close(); } }, e))),
      h("div", { class: "row", style: { marginTop: "12px" } },
        input("", { placeholder: "Any emoji or image URL", onChange: (e) => { c.avatar = e.target.value.trim(); refreshAvatar(); m.close(); } }),
        h("button", { class: "btn", onClick: async () => { const d = await readImageAsDataUrl(256); if (d) { c.avatar = d; refreshAvatar(); m.close(); } } }, "Upload image"),
      ),
    ] });
  };
  av.addEventListener("click", pickAvatar);

  const genPrompt = textarea("", { rows: 3, placeholder: "e.g. A weary bounty hunter in a rain-soaked cyberpunk city who secretly writes poetry and owes money to the wrong people…" });
  const genBtn = h("button", { class: "btn primary", dataset: { label: "✨ Generate full character" } }, "✨ Generate full character");
  const fillBtn = h("button", { class: "btn", dataset: { label: "🪄 Fill in the blanks" }, title: "Keep what you wrote; AI completes the rest" }, "🪄 Fill in the blanks");
  genBtn.addEventListener("click", async () => {
    if (!genPrompt.value.trim()) return toast("Describe the character first.", "error");
    aiBusy(genBtn, true);
    try { fill(await api.post("/api/ai/generate/character", { prompt: genPrompt.value })); toast("Character generated — review and save.", "ok"); }
    catch (e) { toast(e.message, "error"); } finally { aiBusy(genBtn, false); }
  });
  fillBtn.addEventListener("click", async () => {
    aiBusy(fillBtn, true);
    try { fill(await api.post("/api/ai/generate/character", { prompt: genPrompt.value, existing: collect() })); toast("Filled in — review and save.", "ok"); }
    catch (e) { toast(e.message, "error"); } finally { aiBusy(fillBtn, false); }
  });

  const save = async (andChat = false) => {
    const data = collect();
    if (!data.name) return toast("Give the character a name.", "error");
    try {
      const saved = isNew && !c.id ? await api.post("/api/characters", data) : await api.put(`/api/characters/${c.id}`, data);
      c.id = saved.id;
      await loadLists();
      toast("Saved", "ok");
      if (andChat) startChatDialog(saved.id);
      else if (isNew) navigate("character", { id: saved.id });
    } catch (e) { toast(e.message, "error"); }
  };

  const worldOpts = [{ value: "", label: "— none —" }, ...state.worlds.map((w) => ({ value: w.id, label: w.name }))];

  page.append(
    h("div", { class: "page-head" },
      h("div", {}, h("h1", {}, isNew ? "New character" : `Edit ${c.name}`), h("p", {}, "Every field feeds the AI's understanding of who this person is. Use {{user}} and {{char}} as placeholders.")),
      h("div", { class: "row" },
        !isNew ? h("button", { class: "btn", onClick: async () => download(`${c.name}.json`, await api.get(`/api/characters/${c.id}/export`)) }, "⬇ Export") : null,
        h("button", { class: "btn", onClick: () => history.back() }, "Back"),
      ),
    ),
    h("div", { class: "ai-bar" },
      h("div", { class: "row between" }, h("b", {}, "✨ AI character creator"), h("span", { class: "muted small" }, "Describe a concept and get a complete, playable card")),
      genPrompt,
      h("div", { class: "row", style: { marginTop: "8px" } }, genBtn, fillBtn),
    ),
    h("div", { class: "top" },
      av,
      h("div", { style: { flex: 1, minWidth: "240px" } },
        field("Name", mk("name", input(c.name, { placeholder: "Name" }))),
        field("Tagline", mk("tagline", input(c.tagline, { placeholder: "One line that sells the character" })), { action: aiField("tagline", "tagline") }),
      ),
      h("div", {}, field("Accent color", mk("color", input(c.color || "#8b5cf6", { type: "color", style: { width: "60px", padding: "2px", height: "38px" }, onInput: refreshAvatar })))),
    ),
    h("div", { class: "grid-2" },
      field("Description", mk("description", textarea(c.description, { rows: 6, placeholder: "Who they are, their situation, their role in the story." })), { action: aiField("description", "description") }),
      field("Personality", mk("personality", textarea(c.personality, { rows: 6, placeholder: "Temperament, values, quirks, flaws." })), { action: aiField("personality", "personality") }),
      field("Appearance", mk("appearance", textarea(c.appearance, { rows: 4 })), { action: aiField("appearance", "appearance") }),
      field("Speech & mannerisms", mk("speech_style", textarea(c.speech_style, { rows: 4, placeholder: "How they talk. Verbal tics. What they'd never say." })), { action: aiField("speech_style", "speech style") }),
    ),
    field("Backstory", mk("backstory", textarea(c.backstory, { rows: 6 })), { action: aiField("backstory", "backstory") }),
    h("div", { class: "grid-2" },
      field("Likes", listField("likes")),
      field("Dislikes", listField("dislikes")),
      field("Goals & motivations", listField("goals")),
      field("Relationships", listField("relationships"), { hint: "e.g. Mira — estranged sister" }),
    ),
    field("Secrets", mk("secrets", textarea(c.secrets, { rows: 3, placeholder: "Hidden truths that can surface through play. The AI never states them outright." })), { action: aiField("secrets", "secrets") }),
    h("div", { class: "section-title" }, "Scene"),
    field("Default scenario", mk("scenario", textarea(c.scenario, { rows: 4, placeholder: "Where and how the story starts." })), { action: aiField("scenario", "scenario") }),
    field("Greeting (first message)", mk("greeting", textarea(c.greeting, { rows: 7, placeholder: "*She looks up from the bar…* \"You're late.\"" })), { action: aiField("greeting", "greeting") }),
    field("Alternative greetings", mk("alt_greetings", textarea((c.alt_greetings || []).join("\n---\n"), { rows: 5, placeholder: "Separate alternatives with a line containing only ---" })), { hint: "pick one when starting a chat" }),
    field("Example dialogue", mk("example_dialogue", textarea(c.example_dialogue, { rows: 6, placeholder: "{{user}}: …\n{{char}}: …" })), { action: aiField("example_dialogue", "example dialogue") }),
    h("div", { class: "grid-2" },
      field("Tags", listField("tags")),
      field("Default world / lorebook", mk("world_id", select(worldOpts, c.world_id || ""))),
    ),
    h("div", { class: "sticky-actions" },
      !isNew ? h("button", { class: "btn danger ghost", onClick: async () => { if (await confirm(`Delete ${c.name}?`, { okText: "Delete", danger: true })) { await api.del(`/api/characters/${c.id}`); await loadLists(); navigate("characters"); } } }, "Delete") : null,
      h("button", { class: "btn", onClick: () => save(false) }, "Save"),
      h("button", { class: "btn primary", onClick: () => save(true) }, "Save & start chat ▶"),
    ),
  );
  main.append(page);
}
const splitList = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);

// ---------------------------------------------------------------- world editor
export async function worldEditor(main, id) {
  const isNew = !id || id === "new";
  const w = isNew ? { name: "", description: "", entries: [] } : await api.get(`/api/worlds/${id}`);
  const page = h("div", { class: "page editor" });
  const name = input(w.name, { placeholder: "World name" });
  const desc = textarea(w.description, { rows: 5, placeholder: "Overview, tone, era, the rules of this world. Always included in the prompt." });
  const entriesEl = h("div");

  const drawEntries = () => {
    entriesEl.innerHTML = "";
    if (!w.entries.length) entriesEl.append(h("div", { class: "muted small", style: { marginBottom: "10px" } }, "No lore entries yet."));
    w.entries.forEach((e, i) => {
      const kw = input((e.keywords || []).join(", "), { placeholder: "keywords, comma separated", onInput: (ev) => { e.keywords = splitList(ev.target.value); } });
      const nm = input(e.name, { placeholder: "Entry name", onInput: (ev) => { e.name = ev.target.value; } });
      const ct = textarea(e.content, { rows: 4, placeholder: "The lore itself", onInput: (ev) => { e.content = ev.target.value; } });
      const pr = input(e.priority ?? 0, { type: "number", min: 0, max: 10, style: { width: "70px" }, title: "Priority", onInput: (ev) => { e.priority = Number(ev.target.value); } });
      entriesEl.append(h("div", { class: "lore-entry" },
        h("div", { class: "head" }, nm, pr, toggle("Always on", e.always_on, (v) => { e.always_on = v; }), h("button", { class: "btn sm danger ghost", onClick: () => { w.entries.splice(i, 1); drawEntries(); } }, "✕")),
        h("div", { style: { marginTop: "8px" } }, kw),
        h("div", { style: { marginTop: "8px" } }, ct),
      ));
    });
  };
  drawEntries();

  const genPrompt = textarea("", { rows: 3, placeholder: "e.g. A drowned kingdom where the tide reveals ruins twice a day, ruled by salt-priests who trade in memories…" });
  const genBtn = h("button", { class: "btn primary", dataset: { label: "✨ Generate world & lorebook" } }, "✨ Generate world & lorebook");
  genBtn.addEventListener("click", async () => {
    if (!genPrompt.value.trim()) return toast("Describe the world first.", "error");
    aiBusy(genBtn, true);
    try {
      const g = await api.post("/api/ai/generate/world", { prompt: genPrompt.value });
      if (!name.value) name.value = g.name;
      if (!desc.value) desc.value = g.description; else desc.value += "\n\n" + g.description;
      w.entries.push(...g.entries.map((e) => ({ ...e, id: crypto.randomUUID() })));
      drawEntries();
      toast("World generated — review and save.", "ok");
    } catch (e) { toast(e.message, "error"); } finally { aiBusy(genBtn, false); }
  });

  const save = async () => {
    const data = { name: name.value.trim() || "Untitled world", description: desc.value, entries: w.entries };
    try {
      const saved = isNew && !w.id ? await api.post("/api/worlds", data) : await api.put(`/api/worlds/${w.id}`, data);
      w.id = saved.id;
      await loadLists(); toast("Saved", "ok");
      if (isNew) navigate("world", { id: saved.id });
    } catch (e) { toast(e.message, "error"); }
  };

  page.append(
    h("div", { class: "page-head" }, h("div", {}, h("h1", {}, isNew ? "New world" : w.name), h("p", {}, "Lore entries are injected only when their keywords appear in the recent conversation, so big worlds stay cheap.")), h("button", { class: "btn", onClick: () => history.back() }, "Back")),
    h("div", { class: "ai-bar" }, h("b", {}, "✨ AI worldbuilder"), genPrompt, h("div", { class: "row", style: { marginTop: "8px" } }, genBtn)),
    field("Name", name),
    field("Description", desc),
    h("div", { class: "section-title" }, "Lore entries", h("button", { class: "btn sm", onClick: () => { w.entries.push({ id: crypto.randomUUID(), name: "", keywords: [], content: "", always_on: false, priority: 0 }); drawEntries(); } }, "＋ Add entry")),
    entriesEl,
    h("div", { class: "sticky-actions" },
      !isNew ? h("button", { class: "btn danger ghost", onClick: async () => { if (await confirm(`Delete world ${w.name}?`, { okText: "Delete", danger: true })) { await api.del(`/api/worlds/${w.id}`); await loadLists(); navigate("worlds"); } } }, "Delete") : null,
      h("button", { class: "btn primary", onClick: save }, "Save world"),
    ),
  );
  main.append(page);
}

// ---------------------------------------------------------------- persona editor (modal)
export function personaEditor(p, onSaved) {
  const d = p ? { ...p } : { name: "", description: "", appearance: "", avatar: "🙂", color: "#60a5fa" };
  const name = input(d.name, { placeholder: "Your name in the story" });
  const desc = textarea(d.description, { rows: 4, placeholder: "Who you are: role, personality, background the AI should know." });
  const app = textarea(d.appearance, { rows: 2, placeholder: "What you look like (optional)" });
  const av = input(d.avatar, { placeholder: "emoji", style: { width: "80px" } });
  const color = input(d.color, { type: "color", style: { width: "60px", padding: "2px", height: "38px" } });
  const m = modal({
    title: p ? "Edit persona" : "New persona",
    body: [
      h("div", { class: "row" }, field("Avatar", av), field("Color", color)),
      field("Name", name), field("Description", desc), field("Appearance", app),
    ],
    foot: [
      h("button", { class: "btn", onClick: () => m.close() }, "Cancel"),
      h("button", { class: "btn primary", onClick: async () => {
        const data = { ...d, name: name.value.trim() || "You", description: desc.value, appearance: app.value, avatar: av.value.trim() || "🙂", color: color.value };
        try {
          if (p) await api.put(`/api/personas/${p.id}`, data); else await api.post("/api/personas", data);
          m.close(); onSaved?.();
        } catch (e) { toast(e.message, "error"); }
      } }, "Save"),
    ],
  });
}

// ---------------------------------------------------------------- start chat dialog
export async function startChatDialog(characterId = null) {
  await loadLists();
  if (!state.characters.length && !characterId) {
    if (await confirm("You don't have any characters yet. Create one now?", { okText: "Create character" })) navigate("character", { id: "new" });
    return;
  }
  let sel = characterId ? state.characters.find((c) => c.id === characterId) : null;
  let mode = "character";
  let greetingIdx = 0;
  const personaSel = select(state.personas.map((p) => ({ value: p.id, label: p.name })), (state.personas.find((p) => p.is_default) || state.personas[0])?.id);
  const worldSel = select([{ value: "", label: "— use character default —" }, ...state.worlds.map((w) => ({ value: w.id, label: w.name }))], "");
  const scenario = textarea("", { rows: 3, placeholder: "Optional: override the opening scenario for this chat" });
  const list = h("div", { style: { maxHeight: "220px", overflow: "auto", marginBottom: "10px" } });
  const greetings = h("div");
  const drawGreetings = () => {
    greetings.innerHTML = "";
    const gs = sel ? [sel.greeting, ...(sel.alt_greetings || [])].filter((g) => g && g.trim()) : [];
    if (gs.length > 1) {
      greetings.append(h("div", { class: "field-label" }, "Opening scene"));
      gs.forEach((g, i) => greetings.append(h("div", { class: `greeting-opt ${i === greetingIdx ? "sel" : ""}`, onClick: () => { greetingIdx = i; drawGreetings(); } }, g.slice(0, 260))));
    }
  };
  const drawList = () => {
    list.innerHTML = "";
    for (const c of state.characters) {
      list.append(h("div", { class: `picker-item ${sel?.id === c.id ? "sel" : ""}`, onClick: () => { sel = c; greetingIdx = 0; drawList(); drawGreetings(); } }, avatar(c), h("div", {}, h("b", {}, c.name), h("div", { class: "muted small" }, c.tagline))));
    }
  };
  drawList(); drawGreetings();
  const modeSel = select([{ value: "character", label: "Character chat — the AI plays the character" }, { value: "narrator", label: "Narrator / Game Master — the AI runs the whole world" }], mode, { onChange: (e) => { mode = e.target.value; } });
  const m = modal({
    title: "Start a roleplay",
    wide: true,
    body: [
      h("div", { class: "grid-2" },
        h("div", {}, h("div", { class: "field-label" }, "Character"), list),
        h("div", {}, field("Mode", modeSel), field("Your persona", personaSel, { action: h("button", { class: "btn sm ghost", onClick: () => personaEditor(null, async () => { await loadLists(); m.close(); startChatDialog(sel?.id); }) }, "＋ new") }), field("World / lorebook", worldSel)),
      ),
      greetings,
      field("Scenario override", scenario),
    ],
    foot: [
      h("button", { class: "btn", onClick: () => m.close() }, "Cancel"),
      h("button", { class: "btn primary", onClick: async () => {
        if (!sel) return toast("Pick a character.", "error");
        try {
          const chat = await api.post("/api/chats", { character_id: sel.id, persona_id: personaSel.value, world_id: worldSel.value || null, mode, scenario: scenario.value, greeting_index: greetingIdx });
          m.close(); await loadLists(); navigate("chat", { id: chat.id });
        } catch (e) { toast(e.message, "error"); }
      } }, "Begin ▶"),
    ],
  });
}
