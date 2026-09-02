// Character editor (simple by default, advanced on demand), world editor, persona editor, new-roleplay wizard.
import * as api from "./api.js";
import { h, avatar, toast, modal, confirm, prompt, field, input, textarea, select, toggle, download, readImageAsDataUrl } from "./ui.js";
import { state, navigate, loadLists } from "./app.js";

const EMOJIS = ["🧝‍♀️", "🧛", "🧙", "🦊", "🐉", "👸", "🤴", "🧑‍🚀", "🕵️", "🧑‍⚕️", "🧑‍🎤", "🧑‍💻", "🦸", "🦹", "👻", "🤖", "🐺", "🦁", "🐱", "🌙", "🔥", "⚔️", "🎭", "🌹", "⚓", "🍺", "🗡️", "🧜‍♀️"];
const splitList = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);
const busy = (btn, on, label) => { btn.disabled = on; btn.innerHTML = on ? '<span class="spinner"></span> Working…' : label; };

// ---------------------------------------------------------------- character editor
export async function characterEditor(main, id) {
  const isNew = !id || id === "new";
  const c = isNew
    ? { name: "", tagline: "", description: "", personality: "", appearance: "", backstory: "", speech_style: "", likes: [], dislikes: [], goals: [], secrets: "", relationships: [], scenario: "", greeting: "", alt_greetings: [], example_dialogue: "", tags: [], avatar: EMOJIS[Math.floor(Math.random() * EMOJIS.length)], color: "#8b5cf6", world_id: "" }
    : await api.get(`/api/characters/${id}`);
  const page = h("div", { class: "page", style: { maxWidth: "960px" } });
  const F = {};
  const mk = (key, el) => { F[key] = el; return el; };
  const listField = (key) => mk(key, input((c[key] || []).join(", "), { placeholder: "comma separated" }));
  let av = avatar(c, "xl");
  const refreshAvatar = () => { const n = avatar({ ...c, color: F.color?.value || c.color }, "xl"); n.style.cursor = "pointer"; n.addEventListener("click", pickAvatar); av.replaceWith(n); av = n; };
  const pickAvatar = () => {
    const m = modal({ title: "Choose an avatar", body: [
      h("div", { class: "row" }, EMOJIS.map((e) => h("button", { class: "btn", style: { fontSize: "22px" }, onClick: () => { c.avatar = e; refreshAvatar(); m.close(); } }, e))),
      h("div", { class: "row", style: { marginTop: "12px" } }, input("", { placeholder: "Any emoji or image URL", onChange: (e) => { c.avatar = e.target.value.trim(); refreshAvatar(); m.close(); } }), h("button", { class: "btn", onClick: async () => { const d = await readImageAsDataUrl(256); if (d) { c.avatar = d; refreshAvatar(); m.close(); } } }, "Upload image")),
    ] });
  };
  av.style.cursor = "pointer"; av.addEventListener("click", pickAvatar);

  const aiField = (key, label) => h("button", { class: "btn sm ghost", title: `Let AI write ${label}`, onClick: async (e) => {
    const btn = e.currentTarget; btn.disabled = true; btn.textContent = "…";
    try { const guidance = await prompt(`AI: write "${label}"`, { placeholder: "Optional guidance…", okText: "Generate" }); if (guidance === null) return; const r = await api.job("/api/ai/generate/field", { character: collect(), field: key, guidance }); F[key].value = r.text; }
    catch (err) { toast(err.message, "error"); } finally { btn.disabled = false; btn.textContent = "✨ AI"; }
  } }, "✨ AI");

  const collect = () => ({
    ...c, name: F.name.value.trim(), tagline: F.tagline.value.trim(), description: F.description.value, personality: F.personality.value, appearance: F.appearance.value,
    backstory: F.backstory.value, speech_style: F.speech_style.value, secrets: F.secrets.value, scenario: F.scenario.value, greeting: F.greeting.value,
    alt_greetings: F.alt_greetings.value.split(/\n---+\n/).map((s) => s.trim()).filter(Boolean), example_dialogue: F.example_dialogue.value,
    likes: splitList(F.likes.value), dislikes: splitList(F.dislikes.value), goals: splitList(F.goals.value), relationships: splitList(F.relationships.value), tags: splitList(F.tags.value),
    world_id: F.world_id.value || null, color: F.color.value, avatar: c.avatar,
  });
  const fill = (data) => {
    Object.assign(c, data);
    for (const k of ["name", "tagline", "description", "personality", "appearance", "backstory", "speech_style", "secrets", "scenario", "greeting", "example_dialogue"]) if (F[k] && data[k] != null) F[k].value = data[k];
    if (data.alt_greetings) F.alt_greetings.value = data.alt_greetings.join("\n---\n");
    for (const k of ["likes", "dislikes", "goals", "relationships", "tags"]) if (data[k]) F[k].value = data[k].join(", ");
    if (data.color) F.color.value = data.color;
    if (data.avatar) c.avatar = data.avatar;
    refreshAvatar();
    adv.open = true;
  };
  const genPrompt = textarea("", { rows: 3, placeholder: "e.g. A weary bounty hunter in a rain-soaked city who secretly writes poetry and owes money to the wrong people…" });
  const genBtn = h("button", { class: "btn primary" }, "✨ Create with AI");
  const fillBtn = h("button", { class: "btn", title: "Keep what you wrote; AI completes the rest" }, "🪄 Fill in the blanks");
  const genStatus = h("div", { class: "muted small", style: { marginTop: "6px" } });
  genBtn.addEventListener("click", async () => {
    if (!genPrompt.value.trim()) return toast("Describe the character first.", "error");
    busy(genBtn, true, "✨ Create with AI");
    try { fill(await api.job("/api/ai/generate/character", { prompt: genPrompt.value }, (t) => { genStatus.textContent = t; })); toast("Character created. Review and save.", "ok"); }
    catch (e) { toast(e.message, "error"); } finally { busy(genBtn, false, "✨ Create with AI"); genStatus.textContent = ""; }
  });
  fillBtn.addEventListener("click", async () => {
    busy(fillBtn, true, "🪄 Fill in the blanks");
    try { fill(await api.job("/api/ai/generate/character", { prompt: genPrompt.value, existing: collect() })); toast("Filled in. Review and save.", "ok"); }
    catch (e) { toast(e.message, "error"); } finally { busy(fillBtn, false, "🪄 Fill in the blanks"); }
  });
  const save = async (andPlay = false) => {
    const data = collect();
    if (!data.name) return toast("Give the character a name.", "error");
    try {
      const saved = c.id ? await api.put(`/api/characters/${c.id}`, data) : await api.post("/api/characters", data);
      c.id = saved.id; await loadLists(); toast("Saved", "ok");
      if (andPlay) newRoleplayWizard(saved.id); else if (isNew) navigate("character", { id: saved.id });
    } catch (e) { toast(e.message, "error"); }
  };
  const worldOpts = [{ value: "", label: "— none —" }, ...state.worlds.map((w) => ({ value: w.id, label: w.name }))];
  const adv = h("details", { class: "adv" }, h("summary", {}, "Personality, backstory & details"), h("div", { class: "body" },
    h("div", { class: "grid-2" },
      field("Personality", mk("personality", textarea(c.personality, { rows: 5, placeholder: "Temperament, values, quirks, flaws." })), { action: aiField("personality", "personality") }),
      field("Appearance", mk("appearance", textarea(c.appearance, { rows: 5 })), { action: aiField("appearance", "appearance") }),
      field("Speech & mannerisms", mk("speech_style", textarea(c.speech_style, { rows: 4, placeholder: "How they talk. Verbal tics." })), { action: aiField("speech_style", "speech style") }),
      field("Backstory", mk("backstory", textarea(c.backstory, { rows: 4 })), { action: aiField("backstory", "backstory") }),
      field("Likes", listField("likes")), field("Dislikes", listField("dislikes")),
      field("Goals & motivations", listField("goals")), field("Relationships", listField("relationships"), { hint: "e.g. Mira — estranged sister" }),
    ),
    field("Secrets", mk("secrets", textarea(c.secrets, { rows: 3, placeholder: "Hidden truths that surface through play." })), { action: aiField("secrets", "secrets") }),
    field("Default scenario", mk("scenario", textarea(c.scenario, { rows: 3, placeholder: "Where and how a story with them usually starts." })), { action: aiField("scenario", "scenario") }),
    field("Alternative openings", mk("alt_greetings", textarea((c.alt_greetings || []).join("\n---\n"), { rows: 4, placeholder: "Separate alternatives with a line containing only ---" }))),
    field("Example dialogue", mk("example_dialogue", textarea(c.example_dialogue, { rows: 5, placeholder: "{{user}}: …\n{{char}}: …" })), { action: aiField("example_dialogue", "example dialogue") }),
    h("div", { class: "grid-2" }, field("Tags", listField("tags")), field("Default world", mk("world_id", select(worldOpts, c.world_id || "")))),
  ));
  page.append(
    h("div", { class: "page-head" }, h("div", {}, h("h1", {}, isNew ? "New character" : c.name), h("p", {}, "Use {{user}} for the player and {{char}} for the character.")), h("div", { class: "row" }, !isNew ? h("button", { class: "btn", onClick: async () => download(`${c.name}.json`, await api.get(`/api/characters/${c.id}/export`)) }, "⬇ Export") : null, h("button", { class: "btn", onClick: () => navigate("characters") }, "Back"))),
    h("div", { class: "ai-bar" }, h("b", {}, "✨ Describe the character, AI writes the card"), genPrompt, h("div", { class: "row", style: { marginTop: "8px" } }, genBtn, fillBtn), genStatus),
    h("div", { class: "row", style: { alignItems: "flex-start", marginBottom: "6px" } },
      av,
      h("div", { style: { flex: 1, minWidth: "220px" } }, field("Name", mk("name", input(c.name, { placeholder: "Name" }))), field("Tagline", mk("tagline", input(c.tagline, { placeholder: "One line that sells them" })), { action: aiField("tagline", "tagline") })),
      field("Color", mk("color", input(c.color || "#8b5cf6", { type: "color", style: { width: "56px", padding: "2px", height: "40px" }, onInput: refreshAvatar }))),
    ),
    field("Description", mk("description", textarea(c.description, { rows: 5, placeholder: "Who they are, their situation, what makes them interesting." })), { action: aiField("description", "description") }),
    field("Opening message", mk("greeting", textarea(c.greeting, { rows: 6, placeholder: "*She looks up from the bar…* \"You're late.\"" })), { action: aiField("greeting", "opening message"), hint: "how they greet you when a roleplay starts" }),
    adv,
    h("div", { class: "sticky-actions" },
      !isNew ? h("button", { class: "btn danger ghost", onClick: async () => { if (await confirm(`Delete ${c.name}?`, { okText: "Delete", danger: true })) { await api.del(`/api/characters/${c.id}`); await loadLists(); navigate("characters"); } } }, "Delete") : null,
      h("button", { class: "btn", onClick: () => save(false) }, "Save"),
      h("button", { class: "btn primary", onClick: () => save(true) }, "Save & roleplay ▶"),
    ),
  );
  main.append(page);
}

// ---------------------------------------------------------------- world editor
export async function worldEditor(main, id) {
  const isNew = !id || id === "new";
  const w = isNew ? { name: "", description: "", entries: [] } : await api.get(`/api/worlds/${id}`);
  const page = h("div", { class: "page", style: { maxWidth: "960px" } });
  const name = input(w.name, { placeholder: "World name" });
  const desc = textarea(w.description, { rows: 4, placeholder: "Overview, tone, era, the rules of this world. Always included." });
  const entriesEl = h("div");
  const drawEntries = () => {
    entriesEl.innerHTML = "";
    if (!w.entries.length) entriesEl.append(h("div", { class: "muted small", style: { marginBottom: "10px" } }, "No lore entries yet."));
    w.entries.forEach((e, i) => {
      entriesEl.append(h("div", { class: "lore-entry" },
        h("div", { class: "head" }, input(e.name, { placeholder: "Entry name", style: { flex: 1, minWidth: "140px" }, onInput: (ev) => { e.name = ev.target.value; } }), toggle("Always on", e.always_on, (v) => { e.always_on = v; }), h("button", { class: "btn sm danger ghost", onClick: () => { w.entries.splice(i, 1); drawEntries(); } }, "✕")),
        h("div", { style: { marginTop: "8px" } }, input((e.keywords || []).join(", "), { placeholder: "trigger keywords, comma separated", onInput: (ev) => { e.keywords = splitList(ev.target.value); } })),
        h("div", { style: { marginTop: "8px" } }, textarea(e.content, { rows: 3, placeholder: "The lore itself", onInput: (ev) => { e.content = ev.target.value; } })),
      ));
    });
  };
  drawEntries();
  const genPrompt = textarea("", { rows: 3, placeholder: "e.g. A drowned kingdom where the tide reveals ruins twice a day, ruled by salt-priests who trade in memories…" });
  const genBtn = h("button", { class: "btn primary" }, "✨ Build with AI");
  genBtn.addEventListener("click", async () => {
    if (!genPrompt.value.trim()) return toast("Describe the world first.", "error");
    busy(genBtn, true, "✨ Build with AI");
    try { const g = await api.job("/api/ai/generate/world", { prompt: genPrompt.value }); if (!name.value) name.value = g.name; desc.value = desc.value ? desc.value + "\n\n" + g.description : g.description; w.entries.push(...g.entries.map((e) => ({ ...e, id: crypto.randomUUID() }))); drawEntries(); toast("World built. Review and save.", "ok"); }
    catch (e) { toast(e.message, "error"); } finally { busy(genBtn, false, "✨ Build with AI"); }
  });
  const save = async () => {
    const data = { name: name.value.trim() || "Untitled world", description: desc.value, entries: w.entries };
    try { const saved = w.id ? await api.put(`/api/worlds/${w.id}`, data) : await api.post("/api/worlds", data); w.id = saved.id; await loadLists(); toast("Saved", "ok"); if (isNew) navigate("world", { id: saved.id }); }
    catch (e) { toast(e.message, "error"); }
  };
  page.append(
    h("div", { class: "page-head" }, h("div", {}, h("h1", {}, isNew ? "New world" : w.name), h("p", {}, "Lore entries are injected only when their keywords appear, so big worlds stay cheap.")), h("button", { class: "btn", onClick: () => navigate("worlds") }, "Back")),
    h("div", { class: "ai-bar" }, h("b", {}, "✨ Describe the world, AI writes the lorebook"), genPrompt, h("div", { class: "row", style: { marginTop: "8px" } }, genBtn)),
    field("Name", name), field("Description", desc),
    h("div", { class: "section-title" }, "Lore entries", h("button", { class: "btn sm", onClick: () => { w.entries.push({ id: crypto.randomUUID(), name: "", keywords: [], content: "", always_on: false, priority: 0 }); drawEntries(); } }, "＋ Add")),
    entriesEl,
    h("div", { class: "sticky-actions" }, !isNew ? h("button", { class: "btn danger ghost", onClick: async () => { if (await confirm(`Delete world ${w.name}?`, { okText: "Delete", danger: true })) { await api.del(`/api/worlds/${w.id}`); await loadLists(); navigate("worlds"); } } }, "Delete") : null, h("button", { class: "btn primary", onClick: save }, "Save world")),
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
  const color = input(d.color, { type: "color", style: { width: "56px", padding: "2px", height: "40px" } });
  const m = modal({ title: p ? "Edit persona" : "New persona", body: [h("div", { class: "row" }, field("Avatar", av), field("Color", color)), field("Name", name), field("About you", desc), field("Appearance", app)],
    foot: [h("button", { class: "btn", onClick: () => m.close() }, "Cancel"), h("button", { class: "btn primary", onClick: async () => {
      const data = { ...d, name: name.value.trim() || "You", description: desc.value, appearance: app.value, avatar: av.value.trim() || "🙂", color: color.value };
      try { if (p) await api.put(`/api/personas/${p.id}`, data); else await api.post("/api/personas", data); m.close(); onSaved?.(); } catch (e) { toast(e.message, "error"); }
    } }, "Save")] });
}

// ---------------------------------------------------------------- new roleplay wizard
export async function newRoleplayWizard(preselectId = null) {
  await loadLists();
  if (!state.characters.length) {
    if (await confirm("You need a character first. Create one now? AI can write the whole card from one sentence.", { okText: "Create character" })) navigate("character", { id: "new" });
    return;
  }
  const sel = new Set(preselectId ? [preselectId] : []);
  let step = 1;
  const personaSel = select(state.personas.map((p) => ({ value: p.id, label: p.name })), (state.personas.find((p) => p.is_default) || state.personas[0])?.id);
  const worldSel = select([{ value: "", label: "— none —" }, ...state.worlds.map((w) => ({ value: w.id, label: w.name }))], "");
  const idea = textarea("", { rows: 3, placeholder: "Optional: what should this story be about? e.g. 'a heist that goes wrong', 'a slow-burn romance', 'the night before the festival'" });
  const premise = textarea("", { rows: 4, placeholder: "The situation the story starts in." });
  const opening = textarea("", { rows: 6, placeholder: "The first message. Leave empty to use the lead character's own opening." });
  const title = input("", { placeholder: "Title (optional; AI names it later)" });
  let greetingIdx = 0;
  const body = h("div");
  const foot = h("div", { class: "row", style: { justifyContent: "flex-end", width: "100%" } });
  const m = modal({ title: "New roleplay", wide: true, body, foot });

  const draw = () => {
    body.innerHTML = ""; foot.innerHTML = "";
    body.append(h("div", { class: "steps" }, [1, 2].map((i) => h("span", { class: i <= step ? "on" : "" }))));
    if (step === 1) {
      body.append(h("div", { class: "field-label" }, `Who is in this story? (${sel.size} selected)`), h("div", { class: "muted small", style: { marginBottom: "10px" } }, "Pick one character for a classic chat, or several for an ensemble where the AI decides who speaks, who walks in, and who leaves."));
      const list = h("div", { style: { maxHeight: "48vh", overflow: "auto" } });
      for (const c of state.characters) list.append(h("div", { class: `picker-item ${sel.has(c.id) ? "sel" : ""}`, onClick: () => { sel.has(c.id) ? sel.delete(c.id) : sel.add(c.id); draw(); } }, avatar(c), h("div", { style: { minWidth: 0 } }, h("b", {}, c.name), h("div", { class: "muted small" }, c.tagline)), sel.has(c.id) ? h("span", { class: "chk" }, "✓") : null));
      body.append(list);
      foot.append(h("button", { class: "btn", onClick: () => m.close() }, "Cancel"), h("button", { class: "btn primary", disabled: !sel.size, onClick: () => { step = 2; draw(); } }, "Next →"));
    } else {
      const chars = [...sel].map((id) => state.characters.find((c) => c.id === id)).filter(Boolean);
      const lead = chars[0];
      const gs = [lead?.greeting, ...(lead?.alt_greetings || [])].filter((g) => g && g.trim());
      const genBtn = h("button", { class: "btn" }, "✨ Draft premise & opening with AI");
      const genStatus = h("span", { class: "muted small" });
      genBtn.addEventListener("click", async () => {
        busy(genBtn, true, "✨ Draft premise & opening with AI");
        try { const r = await api.job("/api/ai/generate/premise", { character_ids: [...sel], persona_id: personaSel.value, world_id: worldSel.value || null, idea: idea.value }, (t) => { genStatus.textContent = t; }); premise.value = r.premise; opening.value = r.opening; if (!title.value) title.value = r.title; toast("Drafted. Edit anything you like.", "ok"); }
        catch (e) { toast(e.message, "error"); } finally { busy(genBtn, false, "✨ Draft premise & opening with AI"); genStatus.textContent = ""; }
      });
      body.append(
        h("div", { class: "row", style: { marginBottom: "12px" } }, h("div", { class: "avatar-stack" }, chars.map((c) => avatar(c, "sm"))), h("b", {}, chars.map((c) => c.name).join(", "))),
        h("div", { class: "grid-2" }, field("You play as", personaSel), field("World", worldSel)),
        field("Story idea", idea), h("div", { class: "row", style: { marginBottom: "12px" } }, genBtn, genStatus),
        field("Premise", premise, { hint: "optional" }),
        chars.length === 1 && gs.length > 1 && !opening.value ? h("div", {}, h("div", { class: "field-label" }, "Opening scene"), gs.map((g, i) => h("div", { class: `greeting-opt ${i === greetingIdx ? "sel" : ""}`, onClick: () => { greetingIdx = i; draw(); } }, g.slice(0, 240)))) : null,
        field("Custom opening", opening, { hint: "optional" }), field("Title", title),
      );
      foot.append(h("button", { class: "btn", onClick: () => { step = 1; draw(); } }, "← Back"), h("button", { class: "btn primary", onClick: async () => {
        try {
          const chat = await api.post("/api/chats", { character_ids: [...sel], persona_id: personaSel.value, world_id: worldSel.value || null, premise: premise.value, opening: opening.value, title: title.value, greeting_index: greetingIdx });
          m.close(); await loadLists(); navigate("roleplay", { id: chat.id });
        } catch (e) { toast(e.message, "error"); }
      } }, "Begin ▶"));
    }
  };
  draw();
}
