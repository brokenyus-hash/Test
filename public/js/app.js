// App shell: router, sidebar, home, galleries, settings.
import * as api from "./api.js";
import { $, h, avatar, toast, modal, confirm, prompt, field, input, textarea, select, toggle, timeAgo, download, readFile } from "./ui.js";
import { characterEditor, worldEditor, personaEditor, startChatDialog } from "./editors.js";
import { renderChat } from "./chat.js";

export const state = {
  route: { view: "home" },
  chats: [],
  characters: [],
  personas: [],
  worlds: [],
  settings: null,
  activeChatId: null,
};

const main = $("#main");
const sidebar = $("#sidebar");
const panel = $("#panel");
const appEl = $("#app");

export function navigate(view, params = {}) {
  const hash = view === "home" ? "#/" : `#/${view}${params.id ? "/" + params.id : ""}`;
  if (location.hash !== hash) location.hash = hash;
  else route();
}

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  return { view: parts[0] || "home", id: parts[1] || null };
}

export async function loadLists() {
  [state.chats, state.characters, state.personas, state.worlds] = await Promise.all([
    api.get("/api/chats"), api.get("/api/characters"), api.get("/api/personas"), api.get("/api/worlds"),
  ]);
}

export async function loadSettings() {
  state.settings = await api.get("/api/settings");
  return state.settings;
}

export async function route() {
  const r = parseHash();
  state.route = r;
  appEl.classList.remove("sidebar-open", "panel-open");
  $("#overlay").classList.remove("show");
  state.activeChatId = r.view === "chat" ? r.id : null;
  renderSidebar();
  main.innerHTML = "";
  panel.innerHTML = "";
  appEl.classList.toggle("no-panel", r.view !== "chat");
  try {
    switch (r.view) {
      case "chat": await renderChat(main, panel, r.id); break;
      case "characters": renderCharacters(); break;
      case "character": await characterEditor(main, r.id); break;
      case "personas": renderPersonas(); break;
      case "worlds": renderWorlds(); break;
      case "world": await worldEditor(main, r.id); break;
      case "settings": await renderSettings(); break;
      default: renderHome();
    }
  } catch (e) {
    console.error(e);
    main.append(h("div", { class: "page" }, h("div", { class: "empty" }, h("div", { class: "big" }, "😵"), h("div", {}, e.message))));
  }
}

// ---------------------------------------------------------------- sidebar
export function renderSidebar() {
  const v = state.route.view;
  const isActive = (k) => (k === "chats" ? ["home", "chat"].includes(v) : k === "characters" ? ["characters", "character"].includes(v) : k === "worlds" ? ["worlds", "world"].includes(v) : v === k);
  sidebar.innerHTML = "";
  sidebar.append(
    h("div", { class: "brand" }, h("span", { class: "logo" }, "🎭"), h("div", {}, "Tavern", h("small", {}, "AI Roleplay Studio"))),
    h("div", { class: "nav" },
      navBtn("💬", "Chats", "home", isActive("chats")),
      navBtn("🧑‍🎤", "Characters", "characters", isActive("characters")),
      navBtn("🗺️", "Worlds", "worlds", isActive("worlds")),
      navBtn("⚙️", "Settings", "settings", isActive("settings")),
    ),
    h("div", { class: "row", style: { padding: "0 12px 8px" } },
      h("button", { class: "btn primary block", onClick: () => startChatDialog() }, "＋ New chat"),
      h("button", { class: "btn icon", title: "Search messages", onClick: searchDialog }, "🔍"),
    ),
    h("div", { class: "side-head" }, h("span", {}, "Recent chats"), h("button", { class: "btn ghost sm", onClick: () => navigate("personas") }, "Personas")),
    chatList(),
  );
}
function navBtn(ico, label, view, active) {
  return h("button", { class: active ? "active" : "", onClick: () => navigate(view) }, h("span", { class: "ico" }, ico), label);
}
function chatList() {
  const list = h("div", { class: "chat-list" });
  if (!state.chats.length) list.append(h("div", { class: "empty small" }, "No chats yet. Create a character and start one."));
  for (const c of state.chats) {
    const ch = state.characters.find((x) => x.id === c.character_id);
    list.append(h("div", { class: `chat-item ${c.id === state.activeChatId ? "active" : ""}`, onClick: () => navigate("chat", { id: c.id }) },
      avatar(ch || { name: c.title, avatar: "📜" }),
      h("div", { class: "ci-body" },
        h("div", { class: "ci-title" }, c.pinned ? h("span", { class: "pin" }, "📌") : null, c.title),
        h("div", { class: "ci-prev" }, c.preview || (ch ? ch.tagline : "")),
        h("div", { class: "ci-meta" }, `${ch?.name || "Narrator"} · ${c.message_count} msgs · ${timeAgo(c.updated_at)}`),
      ),
    ));
  }
  return list;
}

export function toggleSidebar(open) {
  appEl.classList.toggle("sidebar-open", open);
  $("#overlay").classList.toggle("show", open);
}
export function togglePanel(open) {
  appEl.classList.toggle("panel-open", open);
  $("#overlay").classList.toggle("show", open);
}
$("#overlay").addEventListener("click", () => { toggleSidebar(false); togglePanel(false); });
$("#menu-fab").addEventListener("click", () => toggleSidebar(!appEl.classList.contains("sidebar-open")));

async function searchDialog() {
  const inp = input("", { placeholder: "Search all messages…" });
  const results = h("div", { style: { marginTop: "12px", maxHeight: "50vh", overflow: "auto" } });
  const m = modal({ title: "Search", body: [inp, results] });
  let t;
  inp.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const q = inp.value.trim();
      results.innerHTML = "";
      if (q.length < 2) return;
      const rows = await api.get(`/api/search?q=${encodeURIComponent(q)}`);
      if (!rows.length) results.append(h("div", { class: "muted small" }, "No matches."));
      for (const r of rows) {
        const txt = r.alternatives?.[r.active ?? 0] || "";
        const i = txt.toLowerCase().indexOf(q.toLowerCase());
        const snippet = txt.slice(Math.max(0, i - 60), i + 100);
        results.append(h("div", { class: "search-result", onClick: () => { m.close(); navigate("chat", { id: r.chat_id }); setTimeout(() => document.getElementById("m-" + r.id)?.scrollIntoView({ block: "center" }), 600); } },
          h("div", { class: "t" }, `${r.chat_title} · ${r.role} · ${timeAgo(r.created_at)}`),
          h("div", {}, "…" + snippet + "…"),
        ));
      }
    }, 250);
  });
  setTimeout(() => inp.focus(), 30);
}

// ---------------------------------------------------------------- home
function renderHome() {
  const s = state.settings;
  const page = h("div", { class: "page" });
  page.append(
    h("div", { class: "home-hero" },
      h("h1", {}, "Stories that remember everything."),
      h("p", {}, "Create characters with real personalities, build worlds with living lore, and roleplay with an AI that tracks time, places, relationships, inventory and plot threads as the story unfolds."),
      h("div", { class: "row" },
        h("button", { class: "btn primary", onClick: () => startChatDialog() }, "▶ Start a roleplay"),
        h("button", { class: "btn", onClick: () => navigate("character", { id: "new" }) }, "✨ Create a character"),
        h("button", { class: "btn", onClick: () => navigate("world", { id: "new" }) }, "🗺️ Build a world"),
        !s?.hasApiKey ? h("button", { class: "btn", style: { borderColor: "var(--warn)", color: "var(--warn)" }, onClick: () => navigate("settings") }, "⚠ Add your API key") : null,
      ),
    ),
  );
  if (state.chats.length) {
    page.append(h("div", { class: "section-title" }, "Continue"));
    const cards = h("div", { class: "cards" });
    for (const c of state.chats.slice(0, 6)) {
      const ch = state.characters.find((x) => x.id === c.character_id);
      cards.append(h("div", { class: "char-card", style: { "--c": ch?.color || "#64748b" }, onClick: () => navigate("chat", { id: c.id }) },
        h("div", { class: "row" }, avatar(ch || { name: c.title, avatar: "📜" }), h("div", {}, h("h3", {}, c.title), h("div", { class: "muted small" }, `${ch?.name || "Narrator"} · ${timeAgo(c.updated_at)}`))),
        h("div", { class: "tagline" }, c.preview || ""),
      ));
    }
    page.append(cards);
  }
  page.append(h("div", { class: "section-title" }, "Characters", h("button", { class: "btn ghost sm", onClick: () => navigate("characters") }, "See all →")));
  page.append(characterCards(state.characters.slice(0, 8)));
  main.append(page);
}

// ---------------------------------------------------------------- characters
function characterCards(chars) {
  const cards = h("div", { class: "cards" });
  cards.append(h("div", { class: "char-card new", onClick: () => navigate("character", { id: "new" }) }, h("div", { style: { fontSize: "36px" } }, "＋"), h("div", {}, "New character"), h("div", { class: "muted small" }, "Write it or let AI create it")));
  for (const c of chars) {
    cards.append(h("div", { class: "char-card", style: { "--c": c.color || "#8b5cf6" }, onClick: () => startChatDialog(c.id) },
      h("div", { class: "row" }, avatar(c, "lg"), h("div", { style: { minWidth: 0 } }, h("h3", {}, c.name), h("div", {}, (c.tags || []).slice(0, 3).map((t) => h("span", { class: "tag" }, t))))),
      h("div", { class: "tagline" }, c.tagline || (c.description || "").slice(0, 120)),
      h("div", { class: "actions", onClick: (e) => e.stopPropagation() },
        h("button", { class: "btn sm primary", onClick: () => startChatDialog(c.id) }, "▶ Chat"),
        h("button", { class: "btn sm", onClick: () => navigate("character", { id: c.id }) }, "Edit"),
        h("button", { class: "btn sm ghost", title: "More", onClick: (e) => charMenu(e, c) }, "⋯"),
      ),
    ));
  }
  return cards;
}
function charMenu(e, c) {
  const m = modal({
    title: c.name,
    body: h("div", { class: "row", style: { flexDirection: "column", alignItems: "stretch" } },
      h("button", { class: "btn", onClick: async () => { await api.post(`/api/characters/${c.id}/duplicate`); await loadLists(); m.close(); route(); toast("Duplicated"); } }, "⧉ Duplicate"),
      h("button", { class: "btn", onClick: async () => { const d = await api.get(`/api/characters/${c.id}/export`); download(`${c.name}.json`, d); m.close(); } }, "⬇ Export JSON"),
      h("button", { class: "btn danger", onClick: async () => { m.close(); if (await confirm(`Delete ${c.name}? Existing chats keep working but lose the character card.`, { okText: "Delete", danger: true })) { await api.del(`/api/characters/${c.id}`); await loadLists(); route(); toast("Deleted"); } } }, "🗑 Delete"),
    ),
  });
}
function renderCharacters() {
  const page = h("div", { class: "page" });
  const q = input("", { placeholder: "Filter by name or tag…", style: { maxWidth: "280px" } });
  const grid = h("div");
  const draw = () => {
    const f = q.value.toLowerCase();
    grid.innerHTML = "";
    grid.append(characterCards(state.characters.filter((c) => !f || c.name.toLowerCase().includes(f) || (c.tags || []).some((t) => t.toLowerCase().includes(f)))));
  };
  q.addEventListener("input", draw);
  page.append(
    h("div", { class: "page-head" },
      h("div", {}, h("h1", {}, "Characters"), h("p", {}, `${state.characters.length} character${state.characters.length === 1 ? "" : "s"} · click a card to start chatting`)),
      h("div", { class: "row" }, q, h("button", { class: "btn", onClick: importCharacter }, "⬆ Import"), h("button", { class: "btn primary", onClick: () => navigate("character", { id: "new" }) }, "＋ New")),
    ),
    grid,
  );
  draw();
  main.append(page);
}
async function importCharacter() {
  const f = await readFile();
  if (!f) return;
  try {
    const data = JSON.parse(f.text);
    const c = await api.post("/api/characters/import", data);
    await loadLists();
    toast(`Imported ${c.name}`, "ok");
    navigate("character", { id: c.id });
  } catch (e) { toast("Import failed: " + e.message, "error"); }
}

// ---------------------------------------------------------------- personas
function renderPersonas() {
  const page = h("div", { class: "page" });
  page.append(h("div", { class: "page-head" },
    h("div", {}, h("h1", {}, "Personas"), h("p", {}, "Who you are in the story. The AI never writes for your persona.")),
    h("button", { class: "btn primary", onClick: () => personaEditor(null, async () => { await loadLists(); route(); }) }, "＋ New persona"),
  ));
  const cards = h("div", { class: "cards" });
  if (!state.personas.length) page.append(h("div", { class: "empty" }, h("div", { class: "big" }, "🙂"), "No personas yet. Create one so characters know who they're talking to."));
  for (const p of state.personas) {
    cards.append(h("div", { class: "char-card", style: { "--c": p.color || "#60a5fa" }, onClick: () => personaEditor(p, async () => { await loadLists(); route(); }) },
      h("div", { class: "row" }, avatar(p, "lg"), h("div", {}, h("h3", {}, p.name, p.is_default ? h("span", { class: "tag", style: { marginLeft: "6px" } }, "default") : null))),
      h("div", { class: "tagline" }, p.description || ""),
      h("div", { class: "actions", onClick: (e) => e.stopPropagation() },
        !p.is_default ? h("button", { class: "btn sm", onClick: async () => { await api.post(`/api/personas/${p.id}/default`); await loadLists(); route(); } }, "Make default") : null,
        h("button", { class: "btn sm danger ghost", onClick: async () => { if (await confirm(`Delete persona ${p.name}?`, { okText: "Delete", danger: true })) { await api.del(`/api/personas/${p.id}`); await loadLists(); route(); } } }, "Delete"),
      ),
    ));
  }
  page.append(cards);
  main.append(page);
}

// ---------------------------------------------------------------- worlds
function renderWorlds() {
  const page = h("div", { class: "page" });
  page.append(h("div", { class: "page-head" },
    h("div", {}, h("h1", {}, "Worlds & Lorebooks"), h("p", {}, "Settings, factions, places and rules. Entries are injected automatically when their keywords come up.")),
    h("button", { class: "btn primary", onClick: () => navigate("world", { id: "new" }) }, "＋ New world"),
  ));
  const cards = h("div", { class: "cards" });
  if (!state.worlds.length) page.append(h("div", { class: "empty" }, h("div", { class: "big" }, "🗺️"), "No worlds yet. Describe one and let the AI build the lorebook."));
  for (const w of state.worlds) {
    cards.append(h("div", { class: "char-card", style: { "--c": "#34d399" }, onClick: () => navigate("world", { id: w.id }) },
      h("h3", {}, "🗺️ ", w.name),
      h("div", { class: "tagline" }, w.description || ""),
      h("div", { class: "muted small" }, `${(w.entries || []).length} lore entries`),
    ));
  }
  page.append(cards);
  main.append(page);
}

// ---------------------------------------------------------------- settings
async function renderSettings() {
  const cfg = await loadSettings();
  const s = cfg.settings;
  const page = h("div", { class: "page" });
  const patch = {};
  const save = async () => {
    try { await api.put("/api/settings", patch); await loadSettings(); toast("Settings saved", "ok"); }
    catch (e) { toast(e.message, "error"); }
  };
  const bind = (key, el, parse = (v) => v) => { el.addEventListener("change", () => { patch[key] = parse(el.value); }); return el; };
  const num = (v) => Number(v);

  const keyInput = input("", { placeholder: cfg.apiKeyMasked ? `Saved: ${cfg.apiKeyMasked}` : "sk-ant-…", type: "password" });
  keyInput.addEventListener("change", () => { patch.apiKey = keyInput.value; });

  page.append(
    h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "Settings"), h("p", {}, "Model, writing style, and how much the app remembers."))),
    h("div", { class: "settings-grid" },
      h("div", { class: "card" },
        h("div", { class: "section-title" }, "Connection"),
        field("Anthropic API key", keyInput, { hint: cfg.hasApiKey ? "configured ✓" : "required" }),
        h("div", { class: "muted small" }, "Stored locally in the app database. You can also set ANTHROPIC_API_KEY in the environment instead. Get a key at console.anthropic.com."),
        h("div", { class: "row", style: { marginTop: "10px" } },
          cfg.apiKeyMasked && !cfg.apiKeyMasked.startsWith("(") ? h("button", { class: "btn sm danger ghost", onClick: async () => { await api.put("/api/settings", { apiKey: "" }); toast("Key removed"); route(); } }, "Remove saved key") : null,
        ),
      ),
      h("div", { class: "card" },
        h("div", { class: "section-title" }, "Model"),
        field("Roleplay model", bind("model", select(cfg.models, s.model))),
        field("Reasoning effort", bind("effort", select(["low", "medium", "high", "xhigh", "max"], s.effort)), { hint: "higher = deeper, slower" }),
        field("Utility model", bind("utilityModel", select(cfg.models, s.utilityModel)), { hint: "state tracking, summaries, suggestions" }),
        field("Utility effort", bind("utilityEffort", select(["low", "medium", "high"], s.utilityEffort))),
        field("Max tokens per reply", bind("maxTokens", input(s.maxTokens, { type: "number", min: 256, max: 32000 }), num)),
        toggle("Refusal fallbacks (re-run on a fallback model if the primary declines)", s.fallbacks, (v) => { patch.fallbacks = v; }),
        h("div", { style: { height: "8px" } }),
        toggle("Show the model's thinking summary while it writes", s.showThinking, (v) => { patch.showThinking = v; }),
      ),
      h("div", { class: "card" },
        h("div", { class: "section-title" }, "Writing style"),
        field("Reply length", bind("replyLength", select(["short", "medium", "long", "epic"], s.replyLength))),
        field("Realism", bind("realism", select([{ value: "cinematic", label: "Cinematic — dramatic, forgiving" }, { value: "grounded", label: "Grounded — real people, real consequences" }, { value: "brutal", label: "Brutal — the world does not care" }], s.realism))),
        field("Point of view", bind("pov", select([{ value: "second", label: "Second person (\"you\")" }, { value: "third", label: "Third person" }], s.pov))),
        field("Tense", bind("tense", select(["present", "past"], s.tense))),
      ),
      h("div", { class: "card" },
        h("div", { class: "section-title" }, "Memory & context"),
        toggle("Track world state after every reply (time, place, mood, relationship, inventory, threads)", s.autoState, (v) => { patch.autoState = v; }),
        h("div", { style: { height: "8px" } }),
        toggle("Rolling summaries when history grows past the budget", s.autoSummarize, (v) => { patch.autoSummarize = v; }),
        h("div", { style: { height: "8px" } }),
        toggle("Auto-suggest actions after each reply", s.autoSuggest, (v) => { patch.autoSuggest = v; }),
        h("div", { style: { height: "14px" } }),
        field("Context budget (tokens of raw history)", bind("contextBudget", input(s.contextBudget, { type: "number", min: 4000, max: 400000, step: 1000 }), num), { hint: "older messages fold into the summary beyond this" }),
        field("Always keep the last N messages verbatim", bind("keepRecent", input(s.keepRecent, { type: "number", min: 2, max: 60 }), num)),
        field("Lore budget (tokens)", bind("loreBudget", input(s.loreBudget, { type: "number", min: 0, max: 20000, step: 250 }), num)),
      ),
    ),
    h("div", { class: "sticky-actions" }, h("button", { class: "btn primary", onClick: save }, "Save settings")),
  );
  main.append(page);
}

// ---------------------------------------------------------------- boot
window.addEventListener("hashchange", route);
(async () => {
  try {
    await Promise.all([loadLists(), loadSettings()]);
    if (!state.personas.length) {
      // Seed a default persona so chats have a name for the user.
      await api.post("/api/personas", { name: "You", description: "", avatar: "🙂", color: "#60a5fa", is_default: 1 });
      await loadLists();
    }
    await route();
    if (!state.settings.hasApiKey) toast("Add your Anthropic API key in Settings to start chatting.", "");
  } catch (e) {
    main.append(h("div", { class: "page" }, h("div", { class: "empty" }, "Failed to load: " + e.message)));
  }
})();
