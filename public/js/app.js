// App shell: auth screen, navigation (top bar + mobile tab bar), router, list pages, settings.
import * as api from "./api.js";
import { $, h, avatar, toast, modal, confirm, prompt, field, input, textarea, select, toggle, timeAgo, download, readFile, menu, isMobile } from "./ui.js";
import { characterEditor, worldEditor, personaEditor, newRoleplayWizard } from "./editors.js";
import { renderRoleplay } from "./roleplay.js";

export const state = { route: { view: "home" }, user: null, chats: [], characters: [], personas: [], worlds: [], settings: null };
const appEl = $("#app"), main = $("#main"), panel = $("#panel"), topbar = $("#topbar"), tabbar = $("#tabbar");

export function navigate(view, params = {}) {
  const hash = view === "home" ? "#/" : `#/${view}${params.id ? "/" + params.id : ""}`;
  if (location.hash !== hash) location.hash = hash; else route();
}
const parseHash = () => { const p = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean); return { view: p[0] || "home", id: p[1] ? decodeURIComponent(p[1]) : null }; };

export async function loadLists() {
  [state.chats, state.characters, state.personas, state.worlds] = await Promise.all([api.get("/api/chats"), api.get("/api/characters"), api.get("/api/personas"), api.get("/api/worlds")]);
}
export async function loadSettings() { state.settings = await api.get("/api/settings"); return state.settings; }

export function togglePanel(open) { appEl.classList.toggle("panel-open", open); $("#overlay").classList.toggle("show", open); }
$("#overlay").addEventListener("click", () => togglePanel(false));

// ---------------------------------------------------------------- auth
function renderAuth(mode = "login") {
  appEl.classList.add("auth");
  main.innerHTML = "";
  const user = input("", { placeholder: "Username", autocomplete: "username", autocapitalize: "none" });
  const pass = input("", { placeholder: "Password", type: "password", autocomplete: mode === "login" ? "current-password" : "new-password" });
  const err = h("div", { class: "small", style: { color: "var(--danger)", minHeight: "18px", margin: "6px 0" } });
  const go = async () => {
    err.textContent = "";
    try {
      const r = await api.post(`/api/auth/${mode}`, { username: user.value.trim(), password: pass.value });
      state.user = r.user;
      await boot();
    } catch (e) { err.textContent = e.message; }
  };
  pass.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  user.addEventListener("keydown", (e) => { if (e.key === "Enter") pass.focus(); });
  main.append(h("div", { class: "auth-wrap" }, h("div", { class: "auth-box" },
    h("div", { class: "row" }, h("span", { style: { fontSize: "34px" } }, "🎭"), h("div", {}, h("h1", {}, "Tavern"), h("div", { class: "muted small" }, "Roleplay with casts of AI characters that remember everything."))),
    h("div", { class: "tabs" }, h("button", { class: mode === "login" ? "active" : "", onClick: () => renderAuth("login") }, "Sign in"), h("button", { class: mode === "register" ? "active" : "", onClick: () => renderAuth("register") }, "Create account")),
    user, h("div", { style: { height: "8px" } }), pass, err,
    h("button", { class: "btn primary block", onClick: go }, mode === "login" ? "Sign in" : "Create account"),
    h("div", { class: "muted small", style: { marginTop: "12px" } }, mode === "register" ? "Your roleplays, characters and settings are private to your account." : "New here? Create an account, it takes five seconds."),
  )));
  setTimeout(() => user.focus(), 30);
}
window.addEventListener("auth:required", () => { state.user = null; renderAuth("login"); });

// ---------------------------------------------------------------- navigation chrome
const NAV = [["home", "💬", "Roleplays"], ["characters", "🧑‍🎤", "Characters"], ["worlds", "🗺️", "Worlds"], ["settings", "⚙️", "Me"]];
const isActive = (k, v) => (k === "home" ? ["home", "roleplay"].includes(v) : k === "characters" ? ["characters", "character"].includes(v) : k === "worlds" ? ["worlds", "world"].includes(v) : v === k);
function renderChrome(title) {
  const v = state.route.view;
  topbar.innerHTML = "";
  topbar.append(
    h("div", { class: "brand", onClick: () => navigate("home") }, h("span", { class: "logo" }, "🎭"), h("span", {}, "Tavern")),
    h("div", { class: "topnav" }, NAV.slice(0, 3).map(([k, ico, label]) => h("button", { class: isActive(k, v) ? "active" : "", onClick: () => navigate(k) }, label))),
    h("div", { class: "spacer" }),
    v !== "roleplay" && isMobile() ? h("div", { class: "page-title" }, title || "") : null,
    v !== "roleplay" && isMobile() ? h("div", { class: "spacer" }) : null,
    h("button", { class: "userbtn", onClick: (e) => menu(e.currentTarget, [
      { header: state.user?.username },
      { icon: "⚙️", label: "Settings", onClick: () => navigate("settings") },
      { icon: "🔍", label: "Search messages", onClick: searchDialog },
      "-",
      { icon: "🚪", label: "Sign out", onClick: async () => { await api.post("/api/auth/logout"); state.user = null; renderAuth("login"); } },
    ]) }, avatar({ name: state.user?.username, avatar: "", color: "#8b5cf6" }, "xs"), h("span", { class: "name" }, state.user?.username || "")),
  );
  tabbar.innerHTML = "";
  tabbar.append(NAV.map(([k, ico, label]) => h("button", { class: isActive(k, v) ? "active" : "", onClick: () => navigate(k) }, h("span", { class: "ico" }, ico), label)));
}

// ---------------------------------------------------------------- router
export async function route() {
  if (!state.user) return;
  const r = parseHash();
  state.route = r;
  togglePanel(false);
  appEl.classList.remove("auth", "with-panel");
  appEl.classList.toggle("in-roleplay", r.view === "roleplay");
  main.innerHTML = ""; panel.innerHTML = "";
  try {
    switch (r.view) {
      case "roleplay": renderChrome(""); await renderRoleplay(main, panel, r.id); break;
      case "characters": renderChrome("Characters"); renderCharacters(); break;
      case "character": renderChrome(r.id === "new" ? "New character" : "Edit character"); await characterEditor(main, r.id); break;
      case "worlds": renderChrome("Worlds"); renderWorlds(); break;
      case "world": renderChrome("World"); await worldEditor(main, r.id); break;
      case "settings": renderChrome("Settings"); await renderSettings(); break;
      default: renderChrome("Roleplays"); renderHome();
    }
  } catch (e) {
    console.error(e);
    main.append(h("div", { class: "page" }, h("div", { class: "empty" }, h("div", { class: "big" }, "😵"), h("div", {}, e.message), h("button", { class: "btn", style: { marginTop: "12px" }, onClick: () => navigate("home") }, "Back to roleplays"))));
  }
}

async function searchDialog() {
  const inp = input("", { placeholder: "Search all your messages…" });
  const results = h("div", { style: { marginTop: "12px", maxHeight: "50vh", overflow: "auto" } });
  const m = modal({ title: "Search", body: [inp, results] });
  let t;
  inp.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const q = inp.value.trim(); results.innerHTML = "";
      if (q.length < 2) return;
      const rows = await api.get(`/api/search?q=${encodeURIComponent(q)}`);
      if (!rows.length) results.append(h("div", { class: "muted small" }, "No matches."));
      for (const r of rows) {
        const txt = r.alternatives?.[r.active ?? 0] || "";
        const i = txt.toLowerCase().indexOf(q.toLowerCase());
        results.append(h("div", { class: "search-result", onClick: () => { m.close(); navigate("roleplay", { id: r.chat_id }); setTimeout(() => document.getElementById("m-" + r.id)?.scrollIntoView({ block: "center" }), 600); } },
          h("div", { class: "t" }, `${r.chat_title} · ${r.speaker?.name || (r.role === "user" ? "you" : "AI")} · ${timeAgo(r.created_at)}`), h("div", {}, "…" + txt.slice(Math.max(0, i - 60), i + 100) + "…")));
      }
    }, 250);
  });
  setTimeout(() => inp.focus(), 30);
}

// ---------------------------------------------------------------- home: roleplays
function castAvatars(c) {
  const cast = (c.cast || []).slice(0, 4);
  return h("div", { class: "avatar-stack" }, cast.length ? cast.map((m) => avatar({ name: m.name, avatar: m.avatar, color: m.color }, "sm")) : avatar({ name: "N", avatar: "📜" }, "sm"));
}
function renderHome() {
  const page = h("div", { class: "page" });
  if (!state.settings?.hasApiKey) {
    page.append(h("div", { class: "hero" }, h("h1", {}, "One more step"), h("p", {}, "Add an AI provider key so your characters can talk. It takes a minute."), h("button", { class: "btn primary", onClick: () => navigate("settings") }, "Open settings")));
  }
  page.append(h("div", { class: "page-head" },
    h("div", {}, h("h1", {}, "Roleplays"), h("p", {}, state.chats.length ? "Pick up where you left off, or start something new." : "Start a story with one character, or bring a whole cast together.")),
    h("button", { class: "btn primary", onClick: () => newRoleplayWizard() }, "＋ New roleplay"),
  ));
  const cards = h("div", { class: "cards" });
  if (!state.chats.length) cards.append(h("div", { class: "tile new", onClick: () => newRoleplayWizard() }, h("div", { style: { fontSize: "36px" } }, "🎬"), h("div", {}, "Start your first roleplay"), h("div", { class: "muted small" }, state.characters.length ? "Choose characters and go" : "We'll create a character first")));
  for (const c of state.chats) {
    cards.append(h("div", { class: "tile", style: { "--c": c.cast?.[0]?.color || "#64748b" }, onClick: () => navigate("roleplay", { id: c.id }) },
      h("div", { class: "row between" }, castAvatars(c), c.pinned ? h("span", { title: "Pinned" }, "📌") : null),
      h("h3", {}, c.title),
      h("div", { class: "desc" }, c.preview ? (c.preview_speaker ? `${c.preview_speaker}: ` : "") + c.preview : "No messages yet"),
      h("div", { class: "meta" }, `${(c.cast || []).map((m) => m.name).join(", ") || "Narrator"} · ${c.message_count} msgs · ${timeAgo(c.updated_at)}`),
      h("button", { class: "btn ghost icon more", onClick: (e) => { e.stopPropagation(); roleplayMenu(e.currentTarget, c); } }, "⋯"),
    ));
  }
  page.append(cards);
  if (state.characters.length) {
    page.append(h("div", { class: "section-title" }, "Your characters", h("button", { class: "btn ghost sm", onClick: () => navigate("characters") }, "See all →")));
    page.append(characterCards(state.characters.slice(0, 6), true));
  }
  main.append(page);
}
function roleplayMenu(anchor, c) {
  menu(anchor, [
    { icon: "▶", label: "Open", onClick: () => navigate("roleplay", { id: c.id }) },
    { icon: "📌", label: c.pinned ? "Unpin" : "Pin to top", onClick: async () => { await api.put(`/api/chats/${c.id}`, { pinned: !c.pinned }); await loadLists(); route(); } },
    { icon: "✏️", label: "Rename", onClick: async () => { const t = await prompt("Rename roleplay", { value: c.title }); if (t) { await api.put(`/api/chats/${c.id}`, { title: t }); await loadLists(); route(); } } },
    { icon: "⬇", label: "Export transcript", onClick: async () => download(`${c.title}.md`, await api.get(`/api/chats/${c.id}/export?format=md`), "text/markdown") },
    "-",
    { icon: "🗑", label: "Delete", danger: true, onClick: async () => { if (await confirm(`Delete "${c.title}" permanently?`, { okText: "Delete", danger: true })) { await api.del(`/api/chats/${c.id}`); await loadLists(); route(); toast("Deleted"); } } },
  ]);
}

// ---------------------------------------------------------------- characters
function characterCards(chars, compact = false) {
  const cards = h("div", { class: "cards" });
  if (!compact) cards.append(h("div", { class: "tile new", onClick: () => navigate("character", { id: "new" }) }, h("div", { style: { fontSize: "34px" } }, "＋"), h("div", {}, "New character"), h("div", { class: "muted small" }, "Describe one; AI writes the card")));
  for (const c of chars) {
    cards.append(h("div", { class: "tile", style: { "--c": c.color || "#8b5cf6" }, onClick: () => newRoleplayWizard(c.id) },
      h("div", { class: "row" }, avatar(c, "lg"), h("div", { style: { minWidth: 0 } }, h("h3", {}, c.name), h("div", { class: "muted small" }, (c.tags || []).slice(0, 3).join(" · ")))),
      h("div", { class: "desc" }, c.tagline || (c.description || "").slice(0, 120)),
      h("div", { class: "row", style: { marginTop: "auto" }, onClick: (e) => e.stopPropagation() },
        h("button", { class: "btn sm primary", onClick: () => newRoleplayWizard(c.id) }, "▶ Roleplay"),
        h("button", { class: "btn sm", onClick: () => navigate("character", { id: c.id }) }, "Edit"),
        h("button", { class: "btn sm ghost", onClick: (e) => charMenu(e.currentTarget, c) }, "⋯"),
      ),
    ));
  }
  return cards;
}
function charMenu(anchor, c) {
  menu(anchor, [
    { icon: "⧉", label: "Duplicate", onClick: async () => { await api.post(`/api/characters/${c.id}/duplicate`); await loadLists(); route(); } },
    { icon: "⬇", label: "Export JSON", onClick: async () => download(`${c.name}.json`, await api.get(`/api/characters/${c.id}/export`)) },
    "-",
    { icon: "🗑", label: "Delete", danger: true, onClick: async () => { if (await confirm(`Delete ${c.name}? Roleplays that include them keep working but lose the card.`, { okText: "Delete", danger: true })) { await api.del(`/api/characters/${c.id}`); await loadLists(); route(); } } },
  ]);
}
function renderCharacters() {
  const page = h("div", { class: "page" });
  const q = input("", { placeholder: "Filter…", style: { maxWidth: "220px" } });
  const grid = h("div");
  const draw = () => { const f = q.value.toLowerCase(); grid.innerHTML = ""; grid.append(characterCards(state.characters.filter((c) => !f || c.name.toLowerCase().includes(f) || (c.tags || []).some((t) => t.toLowerCase().includes(f))))); };
  q.addEventListener("input", draw);
  page.append(h("div", { class: "page-head" },
    h("div", {}, h("h1", {}, "Characters"), h("p", {}, "Tap a character to start a roleplay with them.")),
    h("div", { class: "row" }, q, h("button", { class: "btn", onClick: importCharacter }, "⬆ Import"), h("button", { class: "btn primary", onClick: () => navigate("character", { id: "new" }) }, "＋ New")),
  ), grid);
  draw();
  main.append(page);
}
async function importCharacter() {
  const f = await readFile();
  if (!f) return;
  try { const c = await api.post("/api/characters/import", JSON.parse(f.text)); await loadLists(); toast(`Imported ${c.name}`, "ok"); navigate("character", { id: c.id }); }
  catch (e) { toast("Import failed: " + e.message, "error"); }
}

// ---------------------------------------------------------------- worlds
function renderWorlds() {
  const page = h("div", { class: "page" });
  page.append(h("div", { class: "page-head" },
    h("div", {}, h("h1", {}, "Worlds"), h("p", {}, "Settings and lore. Entries are pulled in automatically when their keywords come up.")),
    h("button", { class: "btn primary", onClick: () => navigate("world", { id: "new" }) }, "＋ New world"),
  ));
  const cards = h("div", { class: "cards" });
  cards.append(h("div", { class: "tile new", onClick: () => navigate("world", { id: "new" }) }, h("div", { style: { fontSize: "34px" } }, "🗺️"), h("div", {}, "New world"), h("div", { class: "muted small" }, "Describe it; AI builds the lorebook")));
  for (const w of state.worlds) cards.append(h("div", { class: "tile", style: { "--c": "#34d399" }, onClick: () => navigate("world", { id: w.id }) }, h("h3", {}, w.name), h("div", { class: "desc" }, w.description || ""), h("div", { class: "meta" }, `${(w.entries || []).length} lore entries`)));
  page.append(cards);
  main.append(page);
}

// ---------------------------------------------------------------- settings
async function renderSettings() {
  const cfg = await loadSettings();
  const s = cfg.settings;
  const page = h("div", { class: "page" });
  const patch = {};
  const save = async () => { try { await api.put("/api/settings", patch); await loadSettings(); toast("Saved", "ok"); } catch (e) { toast(e.message, "error"); } };
  const bind = (key, el, parse = (v) => v) => { el.addEventListener("change", () => { patch[key] = parse(el.value); }); return el; };
  const num = (v) => Number(v);

  const providerSel = bind("provider", select(cfg.providers, s.provider));
  const keyInput = input("", { placeholder: cfg.apiKeyMasked ? `Saved: ${cfg.apiKeyMasked}` : "sk-ant-…", type: "password" });
  keyInput.addEventListener("change", () => { patch.apiKey = keyInput.value; });
  const xaiKeyInput = input("", { placeholder: cfg.xaiKeyMasked ? `Saved: ${cfg.xaiKeyMasked}` : "xai-…", type: "password" });
  xaiKeyInput.addEventListener("change", () => { patch.xaiKey = xaiKeyInput.value; });
  const keyBox = h("div"), modelBox = h("div");
  const drawProvider = async () => {
    const prov = providerSel.value;
    keyBox.innerHTML = ""; modelBox.innerHTML = "";
    if (prov === "xai") {
      keyBox.append(field("xAI API key", xaiKeyInput, { hint: cfg.credentials.xai ? "configured ✓" : "required" }), h("div", { class: "muted small" }, "Get one at console.x.ai. Stored privately in your account."));
      let models = cfg.modelsByProvider.xai;
      modelBox.append(h("div", { class: "muted small" }, h("span", { class: "spinner" }), " Loading models…"));
      try { models = await api.get("/api/providers/xai/models"); } catch { /* fallback */ }
      modelBox.innerHTML = "";
      const pick = (v) => (models.some((m) => m.id === v) ? v : models[0]?.id);
      modelBox.append(field("Model for the story", bind("xaiModel", select(models, pick(s.xaiModel)))), field("Model for bookkeeping", bind("xaiUtilityModel", select(models, pick(s.xaiUtilityModel))), { hint: "state, summaries, suggestions" }));
    } else {
      keyBox.append(field("Anthropic API key", keyInput, { hint: cfg.credentials.anthropic ? "configured ✓" : "required" }), h("div", { class: "muted small" }, "Get one at console.anthropic.com. Stored privately in your account."));
      modelBox.append(field("Model for the story", bind("model", select(cfg.modelsByProvider.anthropic, s.model))), field("Model for bookkeeping", bind("utilityModel", select(cfg.modelsByProvider.anthropic, s.utilityModel)), { hint: "state, summaries, suggestions" }));
    }
  };
  providerSel.addEventListener("change", drawProvider);
  drawProvider();

  const personasBox = h("div");
  const drawPersonas = () => {
    personasBox.innerHTML = "";
    for (const p of state.personas) personasBox.append(h("div", { class: "cast-row" }, avatar(p, "sm"), h("div", { class: "n" }, h("b", {}, p.name, p.is_default ? h("span", { class: "tag", style: { marginLeft: "6px" } }, "default") : null), h("small", {}, p.description || "No description")),
      h("button", { class: "btn sm ghost", onClick: (e) => menu(e.currentTarget, [
        { icon: "✏️", label: "Edit", onClick: () => personaEditor(p, async () => { await loadLists(); drawPersonas(); }) },
        { icon: "★", label: "Make default", disabled: !!p.is_default, onClick: async () => { await api.post(`/api/personas/${p.id}/default`); await loadLists(); drawPersonas(); } },
        "-", { icon: "🗑", label: "Delete", danger: true, disabled: state.personas.length < 2, onClick: async () => { await api.del(`/api/personas/${p.id}`); await loadLists(); drawPersonas(); } },
      ]) }, "⋯")));
  };
  drawPersonas();

  page.append(
    h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "Settings"), h("p", {}, `Signed in as ${state.user.username}.`)), h("button", { class: "btn", onClick: async () => { await api.post("/api/auth/logout"); state.user = null; renderAuth("login"); } }, "Sign out")),
    h("div", { class: "settings-grid" },
      h("div", { class: "card" }, h("div", { class: "section-title" }, "AI provider"), field("Provider", providerSel), keyBox, modelBox),
      h("div", { class: "card" }, h("div", { class: "section-title" }, "Writing style"),
        field("Reply length", bind("replyLength", select(["short", "medium", "long", "epic"], s.replyLength))),
        field("Realism", bind("realism", select([{ value: "cinematic", label: "Cinematic — dramatic, forgiving" }, { value: "grounded", label: "Grounded — real people, real consequences" }, { value: "brutal", label: "Brutal — the world does not care" }], s.realism))),
        field("Thinking depth", bind("effort", select([{ value: "low", label: "Fast (recommended for chat)" }, { value: "medium", label: "Balanced" }, { value: "high", label: "Deep (slower)" }], ["low", "medium"].includes(s.effort) ? s.effort : "high"))),
        toggle("Show the model's reasoning while it writes", s.showThinking, (v) => { patch.showThinking = v; }),
      ),
      h("div", { class: "card" }, h("div", { class: "section-title" }, "You in the story", h("button", { class: "btn sm", onClick: () => personaEditor(null, async () => { await loadLists(); drawPersonas(); }) }, "＋ Persona")), h("div", { class: "muted small", style: { marginBottom: "8px" } }, "Personas are who you play as. The AI never writes for your persona."), personasBox),
    ),
    h("details", { class: "adv" }, h("summary", {}, "Advanced"), h("div", { class: "body grid-2" },
      field("Point of view", bind("pov", select([{ value: "second", label: "Second person (\"you\")" }, { value: "third", label: "Third person" }], s.pov))),
      field("Tense", bind("tense", select(["present", "past"], s.tense))),
      field("Max tokens per reply", bind("maxTokens", input(s.maxTokens, { type: "number", min: 256, max: 32000 }), num)),
      field("Bookkeeping effort", bind("utilityEffort", select(["low", "medium", "high"], s.utilityEffort))),
      field("Context budget (tokens)", bind("contextBudget", input(s.contextBudget, { type: "number", min: 4000, max: 400000, step: 1000 }), num), { hint: "older messages fold into the summary beyond this" }),
      field("Always keep last N messages", bind("keepRecent", input(s.keepRecent, { type: "number", min: 2, max: 60 }), num)),
      field("Lore budget (tokens)", bind("loreBudget", input(s.loreBudget, { type: "number", min: 0, max: 20000, step: 250 }), num)),
      h("div", { class: "col", style: { paddingTop: "22px" } },
        toggle("Track world state after every turn", s.autoState, (v) => { patch.autoState = v; }),
        toggle("Rolling summaries", s.autoSummarize, (v) => { patch.autoSummarize = v; }),
        toggle("Auto-suggest actions", s.autoSuggest, (v) => { patch.autoSuggest = v; }),
        toggle("Refusal fallbacks (Claude)", s.fallbacks, (v) => { patch.fallbacks = v; }),
      ),
      h("div", {}, h("div", { class: "field-label" }, "Account"), h("button", { class: "btn", onClick: changePassword }, "Change password")),
    )),
    h("div", { class: "sticky-actions" }, h("button", { class: "btn primary", onClick: save }, "Save settings")),
  );
  main.append(page);
}
async function changePassword() {
  const cur = input("", { type: "password", placeholder: "Current password" });
  const nxt = input("", { type: "password", placeholder: "New password (6+ characters)" });
  const m = modal({ title: "Change password", body: [cur, h("div", { style: { height: "8px" } }), nxt], foot: [h("button", { class: "btn", onClick: () => m.close() }, "Cancel"), h("button", { class: "btn primary", onClick: async () => { try { await api.post("/api/auth/password", { current: cur.value, next: nxt.value }); m.close(); toast("Password changed", "ok"); } catch (e) { toast(e.message, "error"); } } }, "Change")] });
}

// ---------------------------------------------------------------- boot
async function boot() {
  try {
    const me = await api.get("/api/auth/me");
    state.user = me.user;
  } catch { state.user = null; }
  if (!state.user) return renderAuth("login");
  await Promise.all([loadLists(), loadSettings()]);
  await route();
}
window.addEventListener("hashchange", route);
window.addEventListener("resize", () => { if (state.user && state.route.view !== "roleplay") renderChrome(); });
boot();
