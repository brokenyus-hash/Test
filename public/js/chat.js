// Chat view: streaming messages, message tools, narrator controls, world-state panel.
import * as api from "./api.js";
import { h, avatar, renderStory, toast, modal, confirm, prompt, field, input, textarea, select, toggle, timeAgo, autoGrow, download } from "./ui.js";
import { state, navigate, loadLists, renderSidebar, toggleSidebar, togglePanel } from "./app.js";

export async function renderChat(main, panel, chatId) {
  const data = await api.get(`/api/chats/${chatId}`);
  const view = new ChatView(main, panel, data);
  view.mount();
}

class ChatView {
  constructor(main, panel, data) {
    this.main = main; this.panel = panel;
    this.chat = data.chat; this.messages = data.messages; this.timeline = data.timeline;
    this.character = data.character; this.persona = data.persona; this.world = data.world;
    this.busy = null; // in-flight stream promise
    this.suggestions = [];
    this.panelTab = "state";
  }
  get charName() { return this.character?.name || "Narrator"; }
  get userName() { return this.persona?.name || "You"; }

  mount() {
    this.main.innerHTML = "";
    this.scroll = h("div", { class: "chat-scroll" });
    this.inner = h("div", { class: "chat-inner" });
    this.scroll.append(this.inner);
    this.statusEl = h("div", { class: "status-line", style: { display: "none" } });
    this.suggestEl = h("div", { class: "suggestions" });
    this.main.append(this.header(), this.scroll, this.composer());
    this.inner.append(this.statusEl, this.suggestEl);
    this.drawMessages();
    this.drawPanel();
    this.scrollToBottom(true);
  }

  // ---------------------------------------------------------------- header
  header() {
    const c = this.chat;
    const menu = () => {
      const m = modal({ title: c.title, body: h("div", { class: "row", style: { flexDirection: "column", alignItems: "stretch" } },
        h("button", { class: "btn", onClick: async () => { const t = await prompt("Rename chat", { value: c.title }); if (t) { await api.put(`/api/chats/${c.id}`, { title: t }); c.title = t; await loadLists(); renderSidebar(); this.mount(); } m.close(); } }, "✏️ Rename"),
        h("button", { class: "btn", onClick: async () => { await api.put(`/api/chats/${c.id}`, { pinned: !c.pinned }); c.pinned = !c.pinned; await loadLists(); renderSidebar(); m.close(); } }, c.pinned ? "📌 Unpin" : "📌 Pin"),
        h("button", { class: "btn", onClick: () => { m.close(); this.chatSettings(); } }, "🎛 Chat settings (persona, world, style)"),
        h("button", { class: "btn", onClick: async () => { m.close(); const nc = await api.post(`/api/chats/${c.id}/branch`, {}); await loadLists(); navigate("chat", { id: nc.id }); toast("Branched"); } }, "🌿 Branch this chat"),
        h("button", { class: "btn", onClick: async () => { download(`${c.title}.json`, await api.get(`/api/chats/${c.id}/export`)); m.close(); } }, "⬇ Export JSON"),
        h("button", { class: "btn", onClick: async () => { download(`${c.title}.md`, await api.get(`/api/chats/${c.id}/export?format=md`), "text/markdown"); m.close(); } }, "⬇ Export transcript (.md)"),
        h("button", { class: "btn", onClick: async () => { m.close(); if (await confirm("Clear the tracked world state, memory, summary and timeline? Messages are kept.", { okText: "Reset memory", danger: true })) { this.chat = await api.post(`/api/chats/${c.id}/reset-memory`); this.timeline = []; this.drawPanel(); toast("Memory reset"); } } }, "🧹 Reset memory & state"),
        h("button", { class: "btn danger", onClick: async () => { m.close(); if (await confirm("Delete this chat permanently?", { okText: "Delete", danger: true })) { await api.del(`/api/chats/${c.id}`); await loadLists(); navigate("home"); } } }, "🗑 Delete chat"),
      ) });
    };
    return h("div", { class: "chat-head" },
      avatar(this.character || { name: "N", avatar: "📜" }),
      h("div", { class: "grow" },
        h("div", { class: "title" }, c.title),
        h("div", { class: "sub" }, `${this.charName} · ${c.mode === "narrator" ? "Narrator mode" : "Character chat"} · as ${this.userName}${this.world ? " · " + this.world.name : ""}`),
      ),
      h("button", { class: "btn ghost icon", title: "World state", onClick: () => togglePanel(!document.getElementById("app").classList.contains("panel-open")) }, "🌍"),
      h("button", { class: "btn ghost icon", title: "Chat menu", onClick: menu }, "⋯"),
    );
  }

  async chatSettings() {
    const c = this.chat;
    const s = c.settings || {};
    const g = state.settings?.settings || {};
    const personaSel = select(state.personas.map((p) => ({ value: p.id, label: p.name })), c.persona_id || "");
    const worldSel = select([{ value: "", label: "— none —" }, ...state.worlds.map((w) => ({ value: w.id, label: w.name }))], c.world_id || "");
    const modeSel = select([{ value: "character", label: "Character chat" }, { value: "narrator", label: "Narrator / Game Master" }], c.mode || "character");
    const inherit = (v) => [{ value: "", label: `(global: ${v})` }];
    const len = select([...inherit(g.replyLength), "short", "medium", "long", "epic"], s.replyLength || "");
    const realism = select([...inherit(g.realism), "cinematic", "grounded", "brutal"], s.realism || "");
    const effort = select([...inherit(g.effort), "low", "medium", "high", "xhigh", "max"], s.effort || "");
    const model = select([...inherit(g.model), ...(state.settings?.models || [])], s.model || "");
    const director = textarea(c.director_note || "", { rows: 3, placeholder: "Standing direction the AI always follows in this chat, e.g. 'Keep the tone noir; the city should feel hostile at night.'" });
    const scenario = textarea(c.scenario || "", { rows: 3, placeholder: "Scenario override for this chat" });
    const m = modal({ title: "Chat settings", body: [
      h("div", { class: "grid-2" }, field("Persona", personaSel), field("World / lorebook", worldSel), field("Mode", modeSel), field("Model", model), field("Reply length", len), field("Realism", realism), field("Effort", effort)),
      field("Director's standing note", director), field("Scenario", scenario),
    ], foot: [h("button", { class: "btn", onClick: () => m.close() }, "Cancel"), h("button", { class: "btn primary", onClick: async () => {
      const settings = { ...s };
      for (const [k, el] of [["replyLength", len], ["realism", realism], ["effort", effort], ["model", model]]) { if (el.value) settings[k] = el.value; else delete settings[k]; }
      await api.put(`/api/chats/${c.id}`, { persona_id: personaSel.value, world_id: worldSel.value || null, mode: modeSel.value, settings, director_note: director.value, scenario: scenario.value });
      m.close(); await loadLists(); navigate("chat", { id: c.id });
    } }, "Save")] });
  }

  // ---------------------------------------------------------------- messages
  drawMessages() {
    for (const el of [...this.inner.querySelectorAll(".msg")]) el.remove();
    for (const m of this.messages) this.inner.insertBefore(this.messageEl(m), this.statusEl);
  }
  messageEl(m) {
    const isA = m.role === "assistant";
    const who = isA ? this.character || { name: "Narrator", avatar: "📜" } : this.persona || { name: "You", avatar: "🙂", color: "#2563eb" };
    const text = m.alternatives?.[m.active ?? 0] ?? "";
    const el = h("div", { class: `msg ${isA ? "assistant" : "user"} ${m.kind === "direction" ? "direction" : ""} ${m.hidden ? "hidden-msg" : ""} ${m.bookmark ? "bookmarked" : ""}`, id: "m-" + m.id });
    const body = h("div", { class: "body", html: m.kind === "direction" ? "🎬 " + renderStory(text) : renderStory(text) });
    const swipes = h("div", { class: "swipes" });
    if (isA && (m.alternatives || []).length > 1) {
      swipes.append(
        h("button", { onClick: () => this.swipe(m, -1) }, "‹"),
        h("span", {}, `${(m.active ?? 0) + 1} / ${m.alternatives.length}`),
        h("button", { onClick: () => this.swipe(m, +1) }, "›"),
      );
    }
    const tools = h("div", { class: "tools" },
      h("button", { title: "Edit", onClick: () => this.editMessage(m, el) }, "✏️"),
      isA ? h("button", { title: "Regenerate (new alternative)", onClick: () => this.regenerate(m) }, "🔄") : null,
      isA && m === this.messages[this.messages.length - 1] ? h("button", { title: "Continue this reply", onClick: () => this.continueReply() }, "⏩") : null,
      h("button", { title: "Copy", onClick: () => { navigator.clipboard.writeText(text); toast("Copied"); } }, "📋"),
      h("button", { title: m.bookmark ? "Remove bookmark" : "Bookmark", onClick: async () => { Object.assign(m, await api.put(`/api/messages/${m.id}`, { bookmark: !m.bookmark })); el.replaceWith(this.messageEl(m)); } }, "🔖"),
      h("button", { title: "Branch from here", onClick: async () => { const nc = await api.post(`/api/chats/${this.chat.id}/branch`, { message_id: m.id }); await loadLists(); navigate("chat", { id: nc.id }); } }, "🌿"),
      h("button", { title: m.hidden ? "Unhide (include in context)" : "Hide from AI context", onClick: async () => { Object.assign(m, await api.put(`/api/messages/${m.id}`, { hidden: !m.hidden })); el.replaceWith(this.messageEl(m)); } }, m.hidden ? "👁️" : "🙈"),
      h("button", { title: "Delete", onClick: () => this.deleteMessage(m) }, "🗑"),
    );
    const usage = m.usage ? h("div", { class: "usage" }, `${m.usage.output ?? "?"} out · ${m.usage.input ?? 0} in${m.usage.cache_read ? ` · ${m.usage.cache_read} cached` : ""}${m.edited ? " · edited" : ""}${m.stopped ? " · stopped" : ""}`) : (m.edited ? h("div", { class: "usage" }, "edited") : null);
    el.append(
      avatar(who),
      h("div", { class: "bubble" },
        h("div", { class: "who" }, who.name, h("span", { class: "time" }, timeAgo(m.created_at))),
        m.thinking ? h("details", { class: "thinking" }, h("summary", {}, "💭 thinking"), m.thinking) : null,
        body, swipes, usage,
      ),
      tools,
    );
    return el;
  }

  async swipe(m, dir) {
    const n = (m.alternatives || []).length;
    const next = ((m.active ?? 0) + dir + n) % n;
    Object.assign(m, await api.put(`/api/messages/${m.id}`, { active: next }));
    document.getElementById("m-" + m.id)?.replaceWith(this.messageEl(m));
  }
  editMessage(m, el) {
    const ta = textarea(m.alternatives?.[m.active ?? 0] ?? "", { class: "input edit-area", rows: 8 });
    const body = el.querySelector(".body");
    const orig = body.innerHTML;
    el.classList.add("editing");
    body.innerHTML = "";
    body.append(ta, h("div", { class: "row", style: { marginTop: "8px" } },
      h("button", { class: "btn sm primary", onClick: async () => { Object.assign(m, await api.put(`/api/messages/${m.id}`, { text: ta.value })); el.replaceWith(this.messageEl(m)); } }, "Save"),
      h("button", { class: "btn sm", onClick: () => { body.innerHTML = orig; el.classList.remove("editing"); } }, "Cancel"),
    ));
    ta.focus();
  }
  async deleteMessage(m) {
    const idx = this.messages.indexOf(m);
    const after = this.messages.length - idx - 1;
    let cascade = false;
    if (after > 0) {
      const choice = await new Promise((resolve) => {
        const md = modal({ title: "Delete message", body: h("p", {}, `Delete just this message, or this and the ${after} after it?`), foot: [
          h("button", { class: "btn", onClick: () => { resolve(null); md.close(); } }, "Cancel"),
          h("button", { class: "btn danger", onClick: () => { resolve("one"); md.close(); } }, "This only"),
          h("button", { class: "btn danger", onClick: () => { resolve("cascade"); md.close(); } }, `This + ${after} after`),
        ], onClose: () => resolve(null) });
      });
      if (!choice) return;
      cascade = choice === "cascade";
    } else if (!(await confirm("Delete this message?", { okText: "Delete", danger: true }))) return;
    await api.del(`/api/messages/${m.id}${cascade ? "?cascade=1" : ""}`);
    this.messages = cascade ? this.messages.slice(0, idx) : this.messages.filter((x) => x !== m);
    this.drawMessages();
  }

  // ---------------------------------------------------------------- composer
  composer() {
    this.ta = h("textarea", { placeholder: `Write as ${this.userName}… (*actions* in asterisks, "dialogue" in quotes; (OOC: …) to talk to the AI directly)`, rows: 1 });
    autoGrow(this.ta);
    this.ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.send(); }
      if (e.key === "ArrowUp" && !this.ta.value) { const last = [...this.messages].reverse().find((m) => m.role === "user"); if (last) { this.ta.value = last.alternatives[last.active ?? 0]; this.ta.dispatchEvent(new Event("input")); } }
    });
    this.sendBtn = h("button", { class: "btn primary send", title: "Send (Enter)", onClick: () => (this.busy ? this.stop() : this.send()) }, "➤");
    const tb = h("div", { class: "toolbar" },
      h("button", { class: "btn sm", title: "Let the AI suggest what you could do next", onClick: () => this.suggest() }, "💡 Suggest"),
      h("button", { class: "btn sm", title: "AI writes your next message in your persona's voice", onClick: () => this.impersonate() }, "🪄 Write for me"),
      h("button", { class: "btn sm", title: "Advance in-world time", onClick: () => this.direct("time") }, "⏱ Time skip"),
      h("button", { class: "btn sm", title: "Throw in an unexpected complication", onClick: () => this.direct("event") }, "🎲 Twist"),
      h("button", { class: "btn sm", title: "Cut to a different scene", onClick: () => this.direct("scene") }, "🎬 Scene"),
      h("button", { class: "btn sm", title: "Give the narrator a direct instruction", onClick: () => this.direct("narrate") }, "📣 Narrate"),
      h("button", { class: "btn sm", title: "One-off instruction attached to the next reply", onClick: () => this.oocReply() }, "🎯 Steer"),
      h("button", { class: "btn sm ghost", title: "Ask the character to continue without you writing anything", onClick: () => this.continueScene() }, "▶ Continue"),
    );
    this.ctxBar = h("div", { class: "hint" }, h("span", {}, "Enter to send · Shift+Enter for newline · ↑ recalls your last message"), h("span", { class: "ctx-bar" }));
    return h("div", { class: "composer" }, h("div", { class: "composer-inner" }, tb, h("div", { class: "box" }, this.ta, this.sendBtn), this.ctxBar));
  }
  setBusy(on) {
    this.sendBtn.classList.toggle("stop", on);
    this.sendBtn.textContent = on ? "■" : "➤";
    this.sendBtn.title = on ? "Stop generating" : "Send";
    for (const b of this.main.querySelectorAll(".toolbar .btn")) b.disabled = on;
  }
  status(text) {
    if (!text) { this.statusEl.style.display = "none"; return; }
    this.statusEl.style.display = "";
    this.statusEl.innerHTML = "";
    this.statusEl.append(h("span", { class: "spinner" }), text);
  }
  scrollToBottom(force = false) {
    const nearBottom = this.scroll.scrollHeight - this.scroll.scrollTop - this.scroll.clientHeight < 160;
    if (force || nearBottom) this.scroll.scrollTop = this.scroll.scrollHeight;
  }

  async send() {
    const text = this.ta.value.trim();
    if (!text || this.busy) return;
    this.ta.value = ""; this.ta.dispatchEvent(new Event("input"));
    this.suggestEl.innerHTML = "";
    await this.run(`/api/ai/chats/${this.chat.id}/reply`, { text, mode: "reply" });
  }
  async continueScene() { if (!this.busy) await this.run(`/api/ai/chats/${this.chat.id}/reply`, { mode: "reply", instruction: "The user is silent for a beat. Continue the scene naturally from the character's side; something should happen or be said." }); }
  async continueReply() { if (!this.busy) await this.run(`/api/ai/chats/${this.chat.id}/reply`, { mode: "continue" }); }
  async regenerate(m) {
    if (this.busy) return;
    await this.run(`/api/ai/chats/${this.chat.id}/reply`, { mode: "regen", target_message_id: m.id }, m);
  }
  async oocReply() {
    const text = this.ta.value.trim();
    const instr = await prompt("Steer the next reply", { placeholder: "e.g. Have her finally admit what she saw. Make it rain. Keep it under 150 words.", hint: "Applied to the next reply only. The character never sees this as dialogue.", okText: "Send with instruction" });
    if (instr == null) return;
    this.ta.value = ""; this.ta.dispatchEvent(new Event("input"));
    await this.run(`/api/ai/chats/${this.chat.id}/reply`, { text: text || undefined, mode: "reply", instruction: instr });
  }
  async direct(kind) {
    const prompts = {
      time: ["Advance time", "e.g. Three hours pass. / The next morning. / A week later."],
      event: ["Introduce a twist", "Optional: what kind of complication? Leave blank to let the AI surprise you."],
      scene: ["Change scene", "e.g. Cut to the harbor at dusk, two days later."],
      narrate: ["Narrator instruction", "e.g. A stranger enters the tavern and asks for {{user}} by name."],
    };
    const [title, placeholder] = prompts[kind];
    const detail = await prompt(title, { placeholder, okText: "Go" });
    if (detail == null) return;
    if (!detail.trim() && kind !== "event") return;
    await this.run(`/api/ai/chats/${this.chat.id}/direct`, { kind, detail });
  }

  /** Run a streaming request and render it live. */
  async run(url, body, regenTarget = null) {
    this.setBusy(true);
    let streamingEl = null, bodyEl = null, thinkEl = null, buf = "", think = "";
    const startStreamEl = () => {
      const who = this.character || { name: "Narrator", avatar: "📜" };
      bodyEl = h("div", { class: "body cursor" });
      thinkEl = h("div", { class: "thinking", style: { display: "none" } });
      streamingEl = h("div", { class: "msg assistant" }, avatar(who), h("div", { class: "bubble" }, h("div", { class: "who" }, who.name, h("span", { class: "time" }, "now")), thinkEl, bodyEl));
      if (regenTarget) document.getElementById("m-" + regenTarget.id)?.replaceWith(streamingEl);
      else this.inner.insertBefore(streamingEl, this.statusEl);
    };
    let raf = null;
    const paint = () => { raf = null; if (bodyEl) { bodyEl.innerHTML = renderStory(buf); this.scrollToBottom(); } };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(paint); };

    try {
      this.busy = api.stream(url, body, (ev, d) => {
        switch (ev) {
          case "user_message":
            this.messages.push(d.message);
            this.inner.insertBefore(this.messageEl(d.message), this.statusEl);
            this.scrollToBottom(true);
            break;
          case "status":
            this.status(d.text);
            if (d.stats) this.showStats(d.stats);
            break;
          case "summary":
            this.chat.summary = d.summary; this.chat.summary_seq = d.summary_seq; this.drawPanel();
            toast("Older messages folded into the story summary.");
            break;
          case "thinking":
            if (!streamingEl) startStreamEl();
            think += d.text; thinkEl.style.display = ""; thinkEl.textContent = "💭 " + think; break;
          case "delta":
            if (!streamingEl) startStreamEl();
            this.status(null);
            buf += d.text; schedule(); break;
          case "done": {
            if (raf) cancelAnimationFrame(raf);
            const msg = d.message;
            if (body.mode === "regen" && regenTarget) { Object.assign(regenTarget, msg); streamingEl?.replaceWith(this.messageEl(regenTarget)); }
            else if (body.mode === "continue") { const t = this.messages.find((x) => x.id === msg.id); if (t) { Object.assign(t, msg); document.getElementById("m-" + t.id)?.replaceWith(this.messageEl(t)); } streamingEl?.remove(); }
            else { this.messages.push(msg); streamingEl ? streamingEl.replaceWith(this.messageEl(msg)) : this.inner.insertBefore(this.messageEl(msg), this.statusEl); }
            streamingEl = null;
            this.status(null);
            this.scrollToBottom();
            break;
          }
          case "state":
            this.chat.state = d.state; this.chat.memory = d.memory; this.timeline = d.timeline; this.drawPanel(); this.status(null);
            break;
          case "suggestions": this.showSuggestions(d.suggestions); break;
          case "title": this.chat.title = d.title; this.main.querySelector(".chat-head .title").textContent = d.title; loadLists().then(renderSidebar); break;
          case "error": toast(d.error, "error"); this.status(null); break;
        }
      });
      await this.busy;
    } catch (e) {
      if (e.name !== "AbortError") toast(e.message, "error");
    } finally {
      this.busy = null;
      this.setBusy(false);
      this.status(null);
      if (streamingEl) {
        // Aborted mid-stream: reload to pick up whatever the server persisted.
        const d = await api.get(`/api/chats/${this.chat.id}`);
        this.messages = d.messages; this.chat = d.chat; this.drawMessages();
      }
      loadLists().then(renderSidebar);
      this.ta.focus();
    }
  }
  stop() { this.busy?.abort(); }

  showStats(st) {
    const bar = this.ctxBar.querySelector(".ctx-bar");
    bar.innerHTML = "";
    bar.append(...[
      h("span", { title: "Estimated tokens: character card + rules" }, `sys ${st.systemTokens}`),
      h("span", { title: "Estimated tokens of verbatim history" }, `history ${st.historyTokens} (${st.historyMessages} msgs)`),
      st.summarizedMessages ? h("span", { title: "Messages folded into the rolling summary" }, `📚 ${st.summarizedMessages} summarized`) : null,
      st.loreTriggered?.length ? h("span", { title: "Lorebook entries injected" }, `📖 ${st.loreTriggered.join(", ")}`) : null,
    ].filter(Boolean));
  }
  showSuggestions(list) {
    this.suggestEl.innerHTML = "";
    for (const s of list || []) {
      this.suggestEl.append(h("button", { class: "suggestion", title: s.text, onClick: () => { this.ta.value = s.text; this.ta.dispatchEvent(new Event("input")); this.ta.focus(); } }, h("span", { class: "tone" }, s.tone), s.label));
    }
    this.scrollToBottom();
  }
  async suggest() {
    if (this.busy) return;
    this.status("Thinking about what you could do…");
    try { this.showSuggestions((await api.post(`/api/ai/chats/${this.chat.id}/suggest`)).suggestions); }
    catch (e) { toast(e.message, "error"); } finally { this.status(null); }
  }
  async impersonate() {
    if (this.busy) return;
    const hint = await prompt("Write for me", { placeholder: "Optional direction, e.g. 'be flirtatious but guarded'", okText: "Write" });
    if (hint === null) return;
    this.status(`Writing as ${this.userName}…`);
    try { const r = await api.post(`/api/ai/chats/${this.chat.id}/impersonate`, { hint }); this.ta.value = r.text; this.ta.dispatchEvent(new Event("input")); this.ta.focus(); }
    catch (e) { toast(e.message, "error"); } finally { this.status(null); }
  }

  // ---------------------------------------------------------------- world state panel
  drawPanel() {
    const c = this.chat; const st = c.state;
    this.panel.innerHTML = "";
    const tabs = h("div", { class: "panel-tabs" }, ["state", "memory", "timeline", "story"].map((t) => h("button", { class: t === this.panelTab ? "active" : "", onClick: () => { this.panelTab = t; this.drawPanel(); } }, { state: "🌍 World", memory: "🧠 Memory", timeline: "📜 Timeline", story: "📚 Story" }[t])));
    const box = h("div", { class: "panel-inner" }, h("div", { class: "row between", style: { marginBottom: "10px" } }, h("b", {}, "Living world"), h("button", { class: "btn ghost icon only-mobile", onClick: () => togglePanel(false) }, "✕")), tabs);
    const refreshBtn = h("button", { class: "btn sm ghost", title: "Re-derive state from the latest messages", onClick: async () => { refreshBtn.disabled = true; try { const r = await api.post(`/api/ai/chats/${c.id}/refresh-state`); c.state = r.state; c.memory = r.memory; this.timeline = r.timeline; this.drawPanel(); } catch (e) { toast(e.message, "error"); } finally { refreshBtn.disabled = false; } } }, "↻");

    if (this.panelTab === "state") {
      box.append(h("h2", {}, "Now", refreshBtn));
      if (!st) box.append(h("div", { class: "muted small" }, "World state appears after the first reply. It tracks time, place, weather, mood, relationship, items and plot threads automatically."));
      else {
        const rel = st.relationship || {};
        const pct = Math.max(0, Math.min(100, ((Number(rel.score) || 0) + 100) / 2));
        box.append(
          h("div", { class: "state-block" }, h("div", { class: "kv" },
            h("span", { class: "k" }, "🕰"), h("span", { class: "v" }, st.time || "—"),
            h("span", { class: "k" }, "📍"), h("span", { class: "v" }, st.location || "—"),
            h("span", { class: "k" }, "🌦"), h("span", { class: "v" }, st.weather || "—"),
          )),
          h("div", { class: "state-block" },
            h("div", { class: "row between" }, h("b", {}, this.charName), h("span", { class: "pill" }, st.character_mood || "—")),
            h("div", { class: "small muted", style: { marginTop: "4px" } }, st.character_status || ""),
            st.character_goals?.length ? h("div", { style: { marginTop: "8px" } }, h("div", { class: "muted small" }, "Wants:"), h("ul", { style: { margin: "4px 0 0", paddingLeft: "18px", fontSize: "13px" } }, st.character_goals.map((g) => h("li", {}, g)))) : null,
          ),
          h("div", { class: "state-block" },
            h("div", { class: "row between" }, h("b", {}, "Relationship"), h("span", { class: "pill" }, rel.label || "—")),
            h("div", { class: "meter" }, h("i"), h("b", { style: pct >= 50 ? { left: "50%", width: (pct - 50) + "%" } : { left: pct + "%", width: (50 - pct) + "%" } })),
            h("div", { class: "row between small muted" }, h("span", {}, "hostile"), h("span", {}, `${rel.score ?? 0}`), h("span", {}, "devoted")),
            rel.note ? h("div", { class: "small", style: { marginTop: "6px" } }, rel.note) : null,
          ),
          st.present_npcs?.length ? h("div", { class: "state-block" }, h("b", {}, "Also present"), h("div", { style: { marginTop: "6px" } }, st.present_npcs.map((n) => h("div", { class: "small" }, h("b", {}, n.name), n.role ? ` · ${n.role}` : "", n.disposition ? h("span", { class: "muted" }, ` — ${n.disposition}`) : "")))) : null,
          h("div", { class: "state-block" }, h("b", {}, "Inventory"), h("div", { class: "pill-list", style: { marginTop: "6px" } }, st.inventory?.length ? st.inventory.map((i) => h("span", { class: "pill" }, i)) : h("span", { class: "muted small" }, "nothing notable"))),
          h("div", { class: "state-block" }, h("b", {}, "Threads & quests"), (st.active_threads || []).length ? st.active_threads.map((t) => h("div", { class: "thread" }, h("b", {}, t.title), h("span", { class: `st ${t.status}` }, t.status), t.note ? h("div", { class: "muted small" }, t.note) : null)) : h("div", { class: "muted small" }, "none yet")),
        );
      }
    } else if (this.panelTab === "memory") {
      const mem = c.memory || [];
      const saveMem = async () => { await api.put(`/api/chats/${c.id}`, { memory: c.memory }); this.drawPanel(); };
      box.append(h("h2", {}, `Long-term memory (${mem.length})`, h("button", { class: "btn sm ghost", onClick: async () => { const t = await prompt("Add a fact the AI must remember", { placeholder: "e.g. Kael is allergic to silver." }); if (t) { c.memory = [...mem, { text: t, at: Date.now(), pinned: true }]; saveMem(); } } }, "＋")));
      if (!mem.length) box.append(h("div", { class: "muted small" }, "Durable facts are extracted automatically as the story progresses. Pin the important ones; delete mistakes."));
      mem.slice().reverse().forEach((f) => {
        const obj = typeof f === "string" ? { text: f } : f;
        box.append(h("div", { class: `mem ${obj.pinned ? "pinned" : ""}` }, h("span", { class: "t" }, obj.text),
          h("button", { title: obj.pinned ? "Unpin" : "Pin (never pruned)", onClick: () => { obj.pinned = !obj.pinned; c.memory = mem.map((x) => (x === f ? obj : x)); saveMem(); } }, obj.pinned ? "📌" : "📍"),
          h("button", { title: "Forget", onClick: () => { c.memory = mem.filter((x) => x !== f); saveMem(); } }, "✕")));
      });
    } else if (this.panelTab === "timeline") {
      box.append(h("h2", {}, "What happened", h("button", { class: "btn sm ghost", onClick: async () => { const t = await prompt("Add a note to the timeline"); if (t) { this.timeline = await api.post(`/api/chats/${c.id}/timeline`, { kind: "note", text: t }); this.drawPanel(); } } }, "＋")));
      if (!this.timeline.length) box.append(h("div", { class: "muted small" }, "Events are logged automatically after each reply."));
      const tl = h("div", { class: "tl" });
      for (const t of this.timeline) tl.append(h("div", { class: `tl-item ${t.kind}`, title: new Date(t.created_at).toLocaleString(), onClick: () => t.message_id && document.getElementById("m-" + t.message_id)?.scrollIntoView({ block: "center", behavior: "smooth" }) }, t.kind === "fact" ? "📌 " : t.kind === "note" ? "📝 " : "", t.text));
      box.append(tl);
    } else {
      box.append(h("h2", {}, "Story so far", h("button", { class: "btn sm ghost", title: "Fold older messages into the summary now", onClick: async (e) => { e.currentTarget.disabled = true; try { const r = await api.post(`/api/ai/chats/${c.id}/summarize`); this.chat = r.chat; this.drawPanel(); toast("Summary updated", "ok"); } catch (err) { toast(err.message, "error"); } } }, "↻ Summarize now")));
      if (!c.summary) box.append(h("div", { class: "muted small" }, "When the conversation outgrows the context budget, older messages are condensed here so nothing important is forgotten. You can also edit this by hand."));
      const ta = textarea(c.summary || "", { rows: 14, class: "input summary-text" });
      box.append(ta, h("div", { class: "row", style: { marginTop: "8px" } }, h("button", { class: "btn sm", onClick: async () => { await api.put(`/api/chats/${c.id}`, { summary: ta.value }); c.summary = ta.value; toast("Saved", "ok"); } }, "Save summary")));
      box.append(h("div", { class: "muted small", style: { marginTop: "10px" } }, `${(c.summary_seq ?? -1) + 1 > 0 ? this.messages.filter((m) => m.seq <= c.summary_seq).length : 0} messages are covered by this summary and no longer sent verbatim.`));
      if (c.director_note) box.append(h("h2", { style: { marginTop: "16px" } }, "Director's note"), h("div", { class: "summary-text" }, c.director_note));
    }
    this.panel.append(box);
  }
}
