// Roleplay view: cast strip, speaker-attributed streaming messages, composer, world panel.
import * as api from "./api.js";
import { h, avatar, renderStory, toast, modal, confirm, prompt, field, input, textarea, select, timeAgo, autoGrow, download, menu, isMobile } from "./ui.js";
import { state, navigate, loadLists, togglePanel } from "./app.js";

const NARRATOR = { name: "Narrator", kind: "narrator", avatar: "📜", color: "#475569" };

export async function renderRoleplay(main, panel, id) {
  const data = await api.get(`/api/chats/${id}`);
  new RoleplayView(main, panel, data).mount();
}

class RoleplayView {
  constructor(main, panel, d) {
    this.main = main; this.panel = panel;
    this.chat = d.chat; this.cast = d.cast; this.messages = d.messages; this.timeline = d.timeline;
    this.persona = d.persona; this.world = d.world;
    this.busy = null; this.panelTab = "cast";
  }
  get userName() { return this.persona?.name || "You"; }
  get ensemble() { return this.cast.length > 1 || this.chat.narrator_enabled; }
  speakerOf(m) {
    if (m.role === "user") return this.persona || { name: "You", avatar: "🙂", color: "#2563eb" };
    const sp = m.speaker;
    if (!sp || sp.kind === "narrator") return sp?.kind === "narrator" ? NARRATOR : (this.cast[0] ? { ...this.cast[0] } : NARRATOR);
    const live = this.cast.find((c) => (sp.character_id && c.character_id === sp.character_id) || c.name === sp.name);
    return live ? { ...sp, avatar: live.avatar, color: live.color } : sp;
  }

  mount() {
    this.main.innerHTML = "";
    document.getElementById("app").classList.add("with-panel");
    this.scroll = h("div", { class: "chat-scroll" });
    this.inner = h("div", { class: "chat-inner" });
    this.scroll.append(this.inner);
    this.statusEl = h("div", { class: "status-line", style: { display: "none" } });
    this.suggestEl = h("div", { class: "suggestions" });
    this.castStrip = h("div", { class: "cast-strip" });
    this.main.append(this.header(), this.castStrip, this.scroll, this.composer());
    this.inner.append(this.statusEl, this.suggestEl);
    this.drawCast(); this.drawMessages(); this.drawPanel();
    this.scrollToBottom(true);
  }

  // ---------------------------------------------------------------- header + cast
  header() {
    this.titleEl = h("div", { class: "title" }, this.chat.title);
    return h("div", { class: "rp-head" },
      h("button", { class: "btn ghost icon", title: "Back", onClick: () => navigate("home") }, "←"),
      this.titleEl,
      h("button", { class: "btn ghost icon", title: "Story panel", onClick: () => (isMobile() ? togglePanel(true) : this.togglePanelDesktop()) }, "🌍"),
      h("button", { class: "btn ghost icon", title: "Menu", onClick: (e) => this.chatMenu(e.currentTarget) }, "⋯"),
    );
  }
  togglePanelDesktop() { document.getElementById("app").classList.toggle("with-panel"); }
  chatMenu(anchor) {
    const c = this.chat;
    menu(anchor, [
      { icon: "✏️", label: "Rename", onClick: async () => { const t = await prompt("Rename roleplay", { value: c.title }); if (t) { await api.put(`/api/chats/${c.id}`, { title: t }); c.title = t; this.titleEl.textContent = t; loadLists(); } } },
      { icon: "🎛", label: "Story settings", hint: "persona, world, style, director's note", onClick: () => this.storySettings() },
      { icon: "🌿", label: "Branch from here", onClick: async () => { const nc = await api.post(`/api/chats/${c.id}/branch`, {}); await loadLists(); navigate("roleplay", { id: nc.id }); } },
      { icon: "⬇", label: "Export transcript", onClick: async () => download(`${c.title}.md`, await api.get(`/api/chats/${c.id}/export?format=md`), "text/markdown") },
      { icon: "🧹", label: "Reset memory & state", onClick: async () => { if (await confirm("Clear the tracked world state, memory, summary and timeline? Messages are kept.", { okText: "Reset", danger: true })) { this.chat = await api.post(`/api/chats/${c.id}/reset-memory`); this.timeline = []; this.drawPanel(); toast("Memory reset"); } } },
      "-",
      { icon: "🗑", label: "Delete roleplay", danger: true, onClick: async () => { if (await confirm("Delete this roleplay permanently?", { okText: "Delete", danger: true })) { await api.del(`/api/chats/${c.id}`); await loadLists(); navigate("home"); } } },
    ]);
  }
  drawCast() {
    this.castStrip.innerHTML = "";
    for (const m of this.cast) {
      this.castStrip.append(h("button", { class: `cast-chip ${m.status || "present"}`, title: `${m.name} — ${m.status}`, onClick: (e) => this.castMenu(e.currentTarget, m) }, avatar(m, "xs"), h("span", { class: "dot" }), m.name));
    }
    if (this.ensemble) this.castStrip.append(h("button", { class: "cast-chip narrator", onClick: (e) => this.castMenu(e.currentTarget, NARRATOR) }, avatar(NARRATOR, "xs"), "Narrator"));
    this.castStrip.append(h("button", { class: "cast-chip add", onClick: () => this.addCastDialog() }, "＋ Add"));
  }
  castMenu(anchor, m) {
    const isN = m.kind === "narrator";
    const status = (st, label, icon) => ({ icon, label, disabled: m.status === st, onClick: async () => { const r = await api.put(`/api/chats/${this.chat.id}/cast/${encodeURIComponent(m.name)}`, { status: st }); this.cast = r.cast.map((x) => ({ ...this.cast.find((y) => y.name === x.name), ...x })); this.drawCast(); this.drawPanel(); } });
    menu(anchor, [
      { header: isN ? "Narrator" : `${m.name} · ${m.status}` },
      { icon: "💬", label: isN ? "Narrate the next beat" : `Have ${m.name} reply now`, disabled: !!this.busy, onClick: () => this.send(m.name) },
      !isN && m.character_id ? { icon: "🪪", label: "View / edit card", onClick: () => navigate("character", { id: m.character_id }) } : null,
      !isN && m.generated ? { icon: "✨", label: "Make a full character", hint: "AI writes a complete card and saves it to your library", onClick: () => this.promote(m.name) } : null,
      !isN ? "-" : null,
      !isN ? status("present", "In the scene", "🟢") : null,
      !isN ? status("nearby", "Nearby (can be drawn in)", "🟡") : null,
      !isN ? status("away", "Away", "⚪") : null,
      !isN ? status("gone", "Gone from the story", "🔴") : null,
      !isN && this.cast.length > 1 ? "-" : null,
      !isN && this.cast.length > 1 ? { icon: "✕", label: "Remove from story", danger: true, onClick: async () => { const r = await api.del(`/api/chats/${this.chat.id}/cast/${encodeURIComponent(m.name)}`); this.cast = r.cast.map((x) => ({ ...this.cast.find((y) => y.name === x.name), ...x })); this.drawCast(); this.drawPanel(); } } : null,
    ].filter(Boolean));
  }
  async addCastDialog() {
    const inCast = new Set(this.cast.map((m) => m.character_id).filter(Boolean));
    const options = state.characters.filter((c) => !inCast.has(c.id));
    const list = h("div", { style: { maxHeight: "40vh", overflow: "auto" } });
    const name = input("", { placeholder: "Name" }), brief = textarea("", { rows: 2, placeholder: "Who are they? One or two sentences." });
    const m = modal({ title: "Add to the story", body: [
      options.length ? h("div", {}, h("div", { class: "field-label" }, "From your characters"), list) : h("div", { class: "muted small" }, "All your characters are already in this story."),
      h("div", { class: "section-title" }, "Or invent someone on the spot"),
      field("Name", name), field("Brief", brief),
      h("button", { class: "btn", onClick: async () => { if (!name.value.trim()) return; await this.addCast({ name: name.value.trim(), brief: brief.value }); m.close(); } }, "Add newcomer"),
    ] });
    for (const c of options) list.append(h("div", { class: "picker-item", onClick: async () => { await this.addCast({ character_id: c.id }); m.close(); } }, avatar(c, "sm"), h("div", {}, h("b", {}, c.name), h("div", { class: "muted small" }, c.tagline))));
  }
  async addCast(body) {
    try { const r = await api.post(`/api/chats/${this.chat.id}/cast`, { ...body, status: "nearby" }); this.cast = r.cast.map((x) => ({ ...state.characters.find((c) => c.id === x.character_id), ...x })); this.chat.narrator_enabled = true; this.drawCast(); this.drawPanel(); toast(`${this.cast.at(-1).name} is nearby. They can join when it fits, or tap them to bring them in.`, "ok"); }
    catch (e) { toast(e.message, "error"); }
  }
  async promote(name) {
    this.status(`Writing a full card for ${name}…`);
    try { const r = await api.job(`/api/ai/chats/${this.chat.id}/cast/${encodeURIComponent(name)}/promote`, {}, (t) => this.status(t)); await loadLists(); this.cast = r.cast.map((x) => ({ ...state.characters.find((c) => c.id === x.character_id), ...x })); this.drawCast(); this.drawPanel(); toast(`${name} is now a full character in your library.`, "ok"); }
    catch (e) { toast(e.message, "error"); } finally { this.status(null); }
  }

  async storySettings() {
    const c = this.chat, s = c.settings || {}, g = state.settings?.settings || {};
    const personaSel = select(state.personas.map((p) => ({ value: p.id, label: p.name })), c.persona_id || "");
    const worldSel = select([{ value: "", label: "— none —" }, ...state.worlds.map((w) => ({ value: w.id, label: w.name }))], c.world_id || "");
    const inherit = (v) => [{ value: "", label: `(default: ${v})` }];
    const len = select([...inherit(g.replyLength), "short", "medium", "long", "epic"], s.replyLength || "");
    const realism = select([...inherit(g.realism), "cinematic", "grounded", "brutal"], s.realism || "");
    const model = select([...inherit(g.activeModel), ...(state.settings?.models || [])], s.model || "");
    const director = textarea(c.director_note || "", { rows: 3, placeholder: "Standing direction the AI always follows here, e.g. 'Keep it noir; the city is hostile at night.'" });
    const premise = textarea(c.premise || "", { rows: 3 });
    const m = modal({ title: "Story settings", body: [h("div", { class: "grid-2" }, field("You play as", personaSel), field("World", worldSel), field("Reply length", len), field("Realism", realism), field("Model", model)), field("Premise", premise), field("Director's note", director)],
      foot: [h("button", { class: "btn", onClick: () => m.close() }, "Cancel"), h("button", { class: "btn primary", onClick: async () => {
        const settings = { ...s };
        for (const [k, el] of [["replyLength", len], ["realism", realism], ["model", model]]) { if (el.value) settings[k] = el.value; else delete settings[k]; }
        await api.put(`/api/chats/${c.id}`, { persona_id: personaSel.value, world_id: worldSel.value || null, settings, director_note: director.value, premise: premise.value });
        m.close(); await loadLists(); navigate("roleplay", { id: c.id });
      } }, "Save")] });
  }

  // ---------------------------------------------------------------- messages
  drawMessages() {
    for (const el of [...this.inner.querySelectorAll(".msg")]) el.remove();
    for (const m of this.messages) this.inner.insertBefore(this.messageEl(m), this.statusEl);
  }
  messageEl(m) {
    const isA = m.role === "assistant";
    const who = this.speakerOf(m);
    const text = m.alternatives?.[m.active ?? 0] ?? "";
    const el = h("div", { class: `msg ${isA ? "assistant" : "user"} ${who.kind === "narrator" ? "narrator" : ""} ${m.kind === "direction" ? "direction" : ""} ${m.hidden ? "hidden-msg" : ""}`, id: "m-" + m.id, style: { "--sc": who.color || "" } });
    const swipes = h("div", { class: "swipes" });
    if (isA && (m.alternatives || []).length > 1) swipes.append(h("button", { onClick: () => this.swipe(m, -1) }, "‹"), h("span", {}, `${(m.active ?? 0) + 1} / ${m.alternatives.length}`), h("button", { onClick: () => this.swipe(m, +1) }, "›"));
    el.append(
      avatar(who, "sm"),
      h("div", { class: "bubble" },
        h("div", { class: "who" }, h("span", { class: "name" }, who.name), h("span", { class: "time" }, timeAgo(m.created_at)), m.bookmark ? h("span", {}, "🔖") : null, m.edited ? h("span", { class: "time" }, "edited") : null,
          h("button", { class: "more", title: "Message options", onClick: (e) => this.messageMenu(e.currentTarget, m, el) }, "⋯")),
        m.thinking ? h("details", { class: "thinking" }, h("summary", {}, "💭 thinking"), m.thinking) : null,
        h("div", { class: "body", html: m.kind === "direction" ? "🎬 " + renderStory(text) : renderStory(text) }),
        swipes,
      ),
    );
    return el;
  }
  messageMenu(anchor, m, el) {
    const isA = m.role === "assistant";
    const text = m.alternatives?.[m.active ?? 0] ?? "";
    const isLast = m === this.messages[this.messages.length - 1];
    menu(anchor, [
      isA ? { icon: "🔄", label: "Regenerate", hint: "keeps this version as an alternative", disabled: !!this.busy, onClick: () => this.run(`/api/ai/chats/${this.chat.id}/reply`, { mode: "regen", target_message_id: m.id }, m) } : null,
      isA && isLast ? { icon: "⏩", label: "Continue this reply", disabled: !!this.busy, onClick: () => this.run(`/api/ai/chats/${this.chat.id}/reply`, { mode: "continue" }) } : null,
      { icon: "✏️", label: "Edit", onClick: () => this.editMessage(m, el) },
      { icon: "📋", label: "Copy", onClick: () => { navigator.clipboard.writeText(text); toast("Copied"); } },
      { icon: "🔖", label: m.bookmark ? "Remove bookmark" : "Bookmark", onClick: async () => { Object.assign(m, await api.put(`/api/messages/${m.id}`, { bookmark: !m.bookmark })); el.replaceWith(this.messageEl(m)); } },
      { icon: "🌿", label: "Branch from here", onClick: async () => { const nc = await api.post(`/api/chats/${this.chat.id}/branch`, { message_id: m.id }); await loadLists(); navigate("roleplay", { id: nc.id }); } },
      { icon: m.hidden ? "👁️" : "🙈", label: m.hidden ? "Unhide (AI sees it again)" : "Hide from the AI", onClick: async () => { Object.assign(m, await api.put(`/api/messages/${m.id}`, { hidden: !m.hidden })); el.replaceWith(this.messageEl(m)); } },
      "-",
      { icon: "🗑", label: "Delete", danger: true, onClick: () => this.deleteMessage(m) },
    ].filter(Boolean));
  }
  async swipe(m, dir) {
    const n = (m.alternatives || []).length;
    Object.assign(m, await api.put(`/api/messages/${m.id}`, { active: ((m.active ?? 0) + dir + n) % n }));
    document.getElementById("m-" + m.id)?.replaceWith(this.messageEl(m));
  }
  editMessage(m, el) {
    const ta = textarea(m.alternatives?.[m.active ?? 0] ?? "", { class: "input edit-area", rows: 8 });
    const body = el.querySelector(".body"), orig = body.innerHTML;
    body.innerHTML = "";
    body.append(ta, h("div", { class: "row", style: { marginTop: "8px" } }, h("button", { class: "btn sm primary", onClick: async () => { Object.assign(m, await api.put(`/api/messages/${m.id}`, { text: ta.value })); el.replaceWith(this.messageEl(m)); } }, "Save"), h("button", { class: "btn sm", onClick: () => { body.innerHTML = orig; } }, "Cancel")));
    ta.focus();
  }
  async deleteMessage(m) {
    const idx = this.messages.indexOf(m), after = this.messages.length - idx - 1;
    let cascade = false;
    if (after > 0) {
      const choice = await new Promise((resolve) => { const md = modal({ title: "Delete message", body: h("p", {}, `Delete just this message, or this and the ${after} after it?`), foot: [h("button", { class: "btn", onClick: () => { resolve(null); md.close(); } }, "Cancel"), h("button", { class: "btn danger", onClick: () => { resolve("one"); md.close(); } }, "This only"), h("button", { class: "btn danger", onClick: () => { resolve("cascade"); md.close(); } }, `This + ${after} after`)], onClose: () => resolve(null) }); });
      if (!choice) return; cascade = choice === "cascade";
    } else if (!(await confirm("Delete this message?", { okText: "Delete", danger: true }))) return;
    await api.del(`/api/messages/${m.id}${cascade ? "?cascade=1" : ""}`);
    this.messages = cascade ? this.messages.slice(0, idx) : this.messages.filter((x) => x !== m);
    this.drawMessages();
  }

  // ---------------------------------------------------------------- composer
  composer() {
    this.ta = h("textarea", { placeholder: `Write as ${this.userName}…`, rows: 1, enterkeyhint: "send" });
    autoGrow(this.ta);
    this.ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !isMobile()) { e.preventDefault(); this.send(); }
      if (e.key === "ArrowUp" && !this.ta.value) { const last = [...this.messages].reverse().find((m) => m.role === "user"); if (last) { this.ta.value = last.alternatives[last.active ?? 0]; this.ta.dispatchEvent(new Event("input")); } }
    });
    this.sendBtn = h("button", { class: "btn rbtn send", title: "Send", onClick: () => (this.busy ? this.stop() : this.send()) }, "➤");
    const plus = h("button", { class: "btn rbtn", title: "Actions", onClick: (e) => this.actionsMenu(e.currentTarget) }, "＋");
    this.ctxBar = h("div", { class: "hint" }, h("span", { class: "keys" }, "Enter to send · Shift+Enter for a new line · ", h("a", { href: "#", onClick: (e) => { e.preventDefault(); this.showCommands(); } }, "/help for commands")), h("span", { class: "ctx-bar" }));
    return h("div", { class: "composer" }, h("div", { class: "composer-inner" }, h("div", { class: "box" }, plus, this.ta, this.sendBtn), this.ctxBar));
  }
  actionsMenu(anchor) {
    const dis = !!this.busy;
    menu(anchor, [
      { header: "Help me" },
      { icon: "💡", label: "Suggest what I could do", disabled: dis, onClick: () => this.suggest() },
      { icon: "🪄", label: "Write my next message for me", disabled: dis, onClick: () => this.impersonate() },
      { icon: "▶", label: "Let the scene continue", hint: "the AI moves things forward without you", disabled: dis, onClick: () => this.run(`/api/ai/chats/${this.chat.id}/reply`, { mode: "reply", instruction: "The user is silent for a beat. Continue the scene naturally; something should happen or be said." }) },
      "-",
      { header: "Direct the story" },
      { icon: "⏱", label: "Skip time", disabled: dis, onClick: () => this.direct("time") },
      { icon: "🎲", label: "Throw in a twist", disabled: dis, onClick: () => this.direct("event") },
      { icon: "🎬", label: "Change scene", disabled: dis, onClick: () => this.direct("scene") },
      { icon: "📣", label: "Tell the narrator something", disabled: dis, onClick: () => this.direct("narrate") },
      { icon: "🎯", label: "Steer the next reply", hint: "a one-off instruction the characters follow", disabled: dis, onClick: () => this.steer() },
      { icon: "⌨️", label: "Typed commands", hint: "/force, /say, /enter … type them in the box", onClick: () => this.showCommands() },
    ]);
  }
  /** Reference card for the slash commands (the list comes from the server so it never drifts). */
  async showCommands() {
    let list = [];
    try { list = (await api.get("/api/ai/commands")).commands; } catch (e) { toast(e.message, "error"); return; }
    const body = h("div", {},
      h("p", { class: "muted small" }, "Type these in the message box. They are hard controls: directions always happen, and /say never goes through the AI."),
      ...list.map((c) => h("div", { class: "cmd-row", style: { marginBottom: "10px" } }, h("code", {}, c.usage), h("div", { class: "muted small" }, c.help))),
    );
    const m = modal({ title: "Commands", body, foot: h("button", { class: "btn primary", onClick: () => m.close() }, "Got it") });
  }
  setBusy(on) { this.sendBtn.classList.toggle("stop", on); this.sendBtn.textContent = on ? "■" : "➤"; this.sendBtn.title = on ? "Stop" : "Send"; }
  status(text) {
    clearInterval(this._timer);
    if (!text) { this.statusEl.style.display = "none"; return; }
    this.statusEl.style.display = ""; this.statusEl.innerHTML = "";
    const clock = h("span", { class: "muted" });
    this.statusEl.append(h("span", { class: "spinner" }), text, clock);
    const t0 = Date.now();
    this._timer = setInterval(() => { clock.textContent = ` ${Math.round((Date.now() - t0) / 1000)}s`; }, 1000);
    this.scrollToBottom();
  }
  scrollToBottom(force = false) {
    const near = this.scroll.scrollHeight - this.scroll.scrollTop - this.scroll.clientHeight < 200;
    if (force || near) this.scroll.scrollTop = this.scroll.scrollHeight;
  }
  async send(speaker = null) {
    const text = this.ta.value.trim();
    if (this.busy) return;
    if (!text && !speaker) return;
    if (/^\/(help|\?|commands)?$/i.test(text)) { this.ta.value = ""; this.ta.dispatchEvent(new Event("input")); return this.showCommands(); }
    this.ta.value = ""; this.ta.dispatchEvent(new Event("input"));
    this.suggestEl.innerHTML = "";
    await this.run(`/api/ai/chats/${this.chat.id}/reply`, { text: text || undefined, mode: "reply", speaker });
  }
  async steer() {
    const instr = await prompt("Steer the next reply", { placeholder: "e.g. Have her finally admit what she saw. Make it rain. Keep it short.", okText: "Send" });
    if (!instr) return;
    const text = this.ta.value.trim(); this.ta.value = ""; this.ta.dispatchEvent(new Event("input"));
    await this.run(`/api/ai/chats/${this.chat.id}/reply`, { text: text || undefined, mode: "reply", instruction: instr });
  }
  async direct(kind) {
    const prompts = { time: ["Skip time", "e.g. Three hours pass. / The next morning. / A week later."], event: ["Throw in a twist", "Optional: what kind? Leave blank to be surprised."], scene: ["Change scene", "e.g. Cut to the harbour at dusk, two days later."], narrate: ["Tell the narrator", "e.g. A stranger enters and asks for me by name."] };
    const [title, placeholder] = prompts[kind];
    const detail = await prompt(title, { placeholder, okText: "Go" });
    if (detail == null || (!detail.trim() && kind !== "event")) return;
    await this.run(`/api/ai/chats/${this.chat.id}/direct`, { kind, detail });
  }

  /** Run a streaming turn. Handles multiple speakers per turn. */
  async run(url, body, regenTarget = null) {
    this.setBusy(true);
    let cur = null; // { el, bodyEl, thinkEl, buf, think }
    let raf = null;
    const paint = () => { raf = null; if (cur) { cur.bodyEl.innerHTML = renderStory(cur.buf); this.scrollToBottom(); } };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(paint); };
    const startSpeaker = (sp) => {
      const who = { name: sp.name, avatar: sp.avatar, color: sp.color, kind: sp.kind };
      const bodyEl = h("div", { class: "body cursor" });
      const thinkEl = h("div", { class: "thinking", style: { display: "none" } });
      const el = h("div", { class: `msg assistant ${sp.kind === "narrator" ? "narrator" : ""}`, style: { "--sc": who.color || "" } }, avatar(who, "sm"), h("div", { class: "bubble" }, h("div", { class: "who" }, h("span", { class: "name" }, who.name), h("span", { class: "time" }, "writing…")), thinkEl, bodyEl));
      if (regenTarget && !cur) document.getElementById("m-" + regenTarget.id)?.replaceWith(el); else this.inner.insertBefore(el, this.statusEl);
      cur = { el, bodyEl, thinkEl, buf: "", think: "" };
      this.status(null); this.scrollToBottom(true);
    };
    try {
      this.busy = api.stream(url, body, (ev, d) => {
        switch (ev) {
          case "user_message": this.messages.push(d.message); this.inner.insertBefore(this.messageEl(d.message), this.statusEl); this.scrollToBottom(true); break;
          case "status": this.status(d.text); if (d.stats) this.showStats(d.stats); break;
          case "summary": this.chat.summary = d.summary; this.chat.summary_seq = d.summary_seq; this.drawPanel(); break;
          case "speaker": if (cur) { cur.el.remove(); } startSpeaker(d); if (d.stats) this.showStats(d.stats); this.status(`${d.name} is thinking…`); break;
          case "thinking": if (!cur) startSpeaker({ name: "…", kind: "character" }); cur.think += d.text; cur.thinkEl.style.display = ""; cur.thinkEl.textContent = "💭 " + cur.think; break;
          case "delta": if (!cur) startSpeaker({ name: "…", kind: "character" }); this.status(null); cur.buf += d.text; schedule(); break;
          case "done": {
            if (raf) { cancelAnimationFrame(raf); raf = null; }
            const msg = d.message;
            if (body.mode === "regen" && regenTarget) { Object.assign(regenTarget, msg); cur?.el.replaceWith(this.messageEl(regenTarget)); }
            else if (body.mode === "continue") { const t = this.messages.find((x) => x.id === msg.id); if (t) { Object.assign(t, msg); document.getElementById("m-" + t.id)?.replaceWith(this.messageEl(t)); } cur?.el.remove(); }
            else { this.messages.push(msg); cur ? cur.el.replaceWith(this.messageEl(msg)) : this.inner.insertBefore(this.messageEl(msg), this.statusEl); }
            cur = null; this.status(null); this.scrollToBottom(); break;
          }
          case "cast": this.cast = d.cast.map((x) => ({ ...state.characters.find((c) => c.id === x.character_id), ...x })); this.drawCast(); this.drawPanel(); if (d.newcomer) toast(`${d.newcomer.name} has entered the story.`); break;
          case "state": this.chat.state = d.state; this.chat.memory = d.memory; this.timeline = d.timeline; this.drawPanel(); this.status(null); break;
          case "suggestions": this.showSuggestions(d.suggestions); break;
          case "title": this.chat.title = d.title; this.titleEl.textContent = d.title; loadLists(); break;
          case "note": this.chat.director_note = d.director_note; this.drawPanel(); toast(d.director_note ? "Director's note set. The AI follows it on every reply here." : "Director's note cleared.", "ok"); break;
          case "error": toast(d.error, "error"); this.status(null); break;
        }
      });
      await this.busy;
    } catch (e) { if (e.name !== "AbortError") toast(e.message, "error"); }
    finally {
      this.busy = null; this.setBusy(false); this.status(null);
      if (cur) { const d = await api.get(`/api/chats/${this.chat.id}`); this.messages = d.messages; this.chat = d.chat; this.cast = d.cast; this.drawMessages(); this.drawCast(); }
      loadLists();
      if (!isMobile()) this.ta.focus();
    }
  }
  stop() { this.busy?.abort(); }
  showStats(st) {
    const bar = this.ctxBar.querySelector(".ctx-bar");
    bar.innerHTML = "";
    bar.append(h("span", { title: "Estimated prompt size" }, `~${st.systemTokens + st.historyTokens + st.contextTokens} tokens`), st.summarizedMessages ? h("span", { title: "Messages folded into the summary" }, `📚 ${st.summarizedMessages} summarized`) : null, st.loreTriggered?.length ? h("span", { title: "Lore injected" }, `📖 ${st.loreTriggered.join(", ")}`) : null);
  }
  showSuggestions(list) {
    this.suggestEl.innerHTML = "";
    for (const s of list || []) this.suggestEl.append(h("button", { class: "suggestion", title: s.text, onClick: () => { this.ta.value = s.text; this.ta.dispatchEvent(new Event("input")); this.ta.focus(); } }, h("span", { class: "tone" }, s.tone), s.label));
    this.scrollToBottom();
  }
  async suggest() {
    this.status("Thinking about what you could do…");
    try { this.showSuggestions((await api.job(`/api/ai/chats/${this.chat.id}/suggest`)).suggestions); } catch (e) { toast(e.message, "error"); } finally { this.status(null); }
  }
  async impersonate() {
    const hint = await prompt("Write for me", { placeholder: "Optional direction, e.g. 'be flirtatious but guarded'", okText: "Write" });
    if (hint === null) return;
    this.status(`Writing as ${this.userName}…`);
    try { const r = await api.job(`/api/ai/chats/${this.chat.id}/impersonate`, { hint }); this.ta.value = r.text; this.ta.dispatchEvent(new Event("input")); this.ta.focus(); } catch (e) { toast(e.message, "error"); } finally { this.status(null); }
  }

  // ---------------------------------------------------------------- panel
  drawPanel() {
    const c = this.chat, st = c.state;
    this.panel.innerHTML = "";
    const tabs = h("div", { class: "panel-tabs" }, ["cast", "world", "memory", "story"].map((t) => h("button", { class: t === this.panelTab ? "active" : "", onClick: () => { this.panelTab = t; this.drawPanel(); } }, { cast: "🎭 Cast", world: "🌍 World", memory: "🧠 Memory", story: "📚 Story" }[t])));
    const box = h("div", { class: "panel-inner" }, h("div", { class: "row between", style: { marginBottom: "10px" } }, h("b", {}, c.title), h("button", { class: "btn ghost icon", onClick: () => (isMobile() ? togglePanel(false) : this.togglePanelDesktop()) }, "✕")), tabs);
    if (this.panelTab === "cast") {
      box.append(h("h2", {}, "Who's in the story", h("button", { class: "btn sm ghost", onClick: () => this.addCastDialog() }, "＋ Add")));
      for (const m of this.cast) box.append(h("div", { class: "cast-row" }, avatar(m, "sm"), h("div", { class: "n" }, h("b", {}, m.name), h("small", {}, `${m.status}${m.role === "lead" ? " · lead" : ""}${m.generated ? " · newcomer" : ""}${m.tagline ? " · " + m.tagline : ""}`)), h("button", { class: "btn sm ghost", onClick: (e) => this.castMenu(e.currentTarget, m) }, "⋯")));
      if (st?.present_npcs?.length) {
        box.append(h("h2", { style: { marginTop: "16px" } }, "Bystanders"));
        for (const n of st.present_npcs) box.append(h("div", { class: "cast-row" }, avatar({ name: n.name, avatar: "👤", color: "#334155" }, "sm"), h("div", { class: "n" }, h("b", {}, n.name), h("small", {}, [n.role, n.disposition].filter(Boolean).join(" · "))), h("button", { class: "btn sm ghost", title: "Bring them into the cast", onClick: () => this.addCast({ name: n.name, brief: `${n.role || ""}. ${n.disposition || ""}` }) }, "＋")));
      }
      box.append(h("div", { class: "muted small", style: { marginTop: "14px" } }, this.ensemble ? "The AI decides who speaks each turn based on who's present. Tap anyone to make them reply, change where they are, or bring someone new in." : "Add a second character to turn this into an ensemble: the AI will decide who speaks, who enters, and who leaves."));
    } else if (this.panelTab === "world") {
      const refresh = h("button", { class: "btn sm ghost", title: "Re-derive from the latest messages", onClick: async () => { refresh.disabled = true; try { const r = await api.job(`/api/ai/chats/${c.id}/refresh-state`); c.state = r.state; c.memory = r.memory; this.timeline = r.timeline; this.drawPanel(); } catch (e) { toast(e.message, "error"); } finally { refresh.disabled = false; } } }, "↻");
      box.append(h("h2", {}, "Now", refresh));
      if (!st) box.append(h("div", { class: "muted small" }, "After the first reply this tracks time, place, weather, moods, relationships, items and plot threads."));
      else {
        const rel = st.relationship || {}, pct = Math.max(0, Math.min(100, ((Number(rel.score) || 0) + 100) / 2));
        box.append(
          h("div", { class: "state-block" }, h("div", { class: "kv" }, h("span", { class: "k" }, "🕰"), h("span", {}, st.time || "—"), h("span", { class: "k" }, "📍"), h("span", {}, st.location || "—"), h("span", { class: "k" }, "🌦"), h("span", {}, st.weather || "—"))),
          h("div", { class: "state-block" }, h("div", { class: "row between" }, h("b", {}, this.cast[0]?.name || "Lead"), h("span", { class: "pill" }, st.character_mood || "—")), h("div", { class: "small muted", style: { marginTop: "4px" } }, st.character_status || ""), st.character_goals?.length ? h("ul", { style: { margin: "8px 0 0", paddingLeft: "18px", fontSize: "13px" } }, st.character_goals.map((g) => h("li", {}, g))) : null),
          h("div", { class: "state-block" }, h("div", { class: "row between" }, h("b", {}, "Relationship"), h("span", { class: "pill" }, rel.label || "—")), h("div", { class: "meter" }, h("i"), h("b", { style: pct >= 50 ? { left: "50%", width: (pct - 50) + "%" } : { left: pct + "%", width: (50 - pct) + "%" } })), h("div", { class: "row between small muted" }, h("span", {}, "hostile"), h("span", {}, `${rel.score ?? 0}`), h("span", {}, "devoted")), rel.note ? h("div", { class: "small", style: { marginTop: "6px" } }, rel.note) : null),
          h("div", { class: "state-block" }, h("b", {}, "Inventory"), h("div", { class: "pill-list", style: { marginTop: "6px" } }, st.inventory?.length ? st.inventory.map((i) => h("span", { class: "pill" }, i)) : h("span", { class: "muted small" }, "nothing notable"))),
          h("div", { class: "state-block" }, h("b", {}, "Threads & quests"), (st.active_threads || []).length ? st.active_threads.map((t) => h("div", { class: "thread" }, h("b", {}, t.title), h("span", { class: `st ${t.status}` }, t.status), t.note ? h("div", { class: "muted small" }, t.note) : null)) : h("div", { class: "muted small" }, "none yet")),
        );
      }
    } else if (this.panelTab === "memory") {
      const mem = c.memory || [];
      const saveMem = async () => { await api.put(`/api/chats/${c.id}`, { memory: c.memory }); this.drawPanel(); };
      box.append(h("h2", {}, `Facts (${mem.length})`, h("button", { class: "btn sm ghost", onClick: async () => { const t = await prompt("Add a fact the AI must remember", { placeholder: "e.g. Kael is allergic to silver." }); if (t) { c.memory = [...mem, { text: t, at: Date.now(), pinned: true }]; saveMem(); } } }, "＋")));
      if (!mem.length) box.append(h("div", { class: "muted small" }, "Durable facts are extracted automatically as the story goes. Pin the important ones; delete mistakes."));
      mem.slice().reverse().forEach((f) => { const o = typeof f === "string" ? { text: f } : f; box.append(h("div", { class: `mem ${o.pinned ? "pinned" : ""}` }, h("span", { class: "t" }, o.text), h("button", { title: o.pinned ? "Unpin" : "Pin", onClick: () => { o.pinned = !o.pinned; c.memory = mem.map((x) => (x === f ? o : x)); saveMem(); } }, o.pinned ? "📌" : "📍"), h("button", { title: "Forget", onClick: () => { c.memory = mem.filter((x) => x !== f); saveMem(); } }, "✕"))); });
      box.append(h("h2", { style: { marginTop: "16px" } }, "Timeline"));
      if (!this.timeline.length) box.append(h("div", { class: "muted small" }, "Events are logged after each turn."));
      const tl = h("div", { class: "tl" });
      for (const t of this.timeline) tl.append(h("div", { class: `tl-item ${t.kind}`, title: new Date(t.created_at).toLocaleString(), onClick: () => t.message_id && document.getElementById("m-" + t.message_id)?.scrollIntoView({ block: "center", behavior: "smooth" }) }, t.kind === "fact" ? "📌 " : t.kind === "note" ? "📝 " : "", t.text));
      box.append(tl);
    } else {
      box.append(h("h2", {}, "Story so far", h("button", { class: "btn sm ghost", onClick: async (e) => { e.currentTarget.disabled = true; try { const r = await api.job(`/api/ai/chats/${c.id}/summarize`); this.chat = { ...this.chat, ...r.chat }; this.drawPanel(); toast("Summary updated", "ok"); } catch (err) { toast(err.message, "error"); } } }, "↻ Summarize now")));
      if (c.premise) box.append(h("div", { class: "state-block" }, h("b", {}, "Premise"), h("div", { class: "summary-text", style: { marginTop: "4px" } }, c.premise)));
      const ta = textarea(c.summary || "", { rows: 12, class: "input summary-text", placeholder: "When the story outgrows the context budget, older messages are condensed here so nothing important is forgotten. You can edit it." });
      box.append(ta, h("div", { class: "row", style: { marginTop: "8px" } }, h("button", { class: "btn sm", onClick: async () => { await api.put(`/api/chats/${c.id}`, { summary: ta.value }); c.summary = ta.value; toast("Saved", "ok"); } }, "Save summary")));
      if (c.director_note) box.append(h("div", { class: "state-block", style: { marginTop: "12px" } }, h("b", {}, "Director's note"), h("div", { class: "summary-text" }, c.director_note)));
    }
    this.panel.append(box);
  }
}
