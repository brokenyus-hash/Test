// DOM helpers, modals, toasts, and story-text rendering.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "html") el.innerHTML = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k in el && typeof v !== "string" && k !== "value") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Render roleplay prose: *actions* -> italic, "dialogue" -> highlighted, paragraphs, minimal markdown. */
export function renderStory(text) {
  let s = esc(text || "");
  // Work on escaped text; quotes are now &quot; so we tag dialogue first with placeholders,
  // then actions, so that inserted markup is never re-matched.
  s = s.replace(/```([\s\S]*?)```/g, (m, code) => `<pre>${code}</pre>`);
  s = s.replace(/(&quot;|[“])([^“”\n]*?[^&\n]|)(&quot;|[”])/g, (m, o, inner, c) => (inner.includes("&quot;") ? m : `\u0001${o}${inner}${c}\u0002`));
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*\n][^*]*?)\*/g, '<span class="action">$1</span>');
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,;!?)]|$)/g, '$1<span class="action">$2</span>');
  s = s.replace(/\u0001/g, '<span class="say">').replace(/\u0002/g, "</span>");
  s = s.replace(/\(OOC:([^)]*)\)/gi, '<span class="muted">(OOC:$1)</span>');
  const paras = s.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`);
  return paras.join("");
}

export function avatar(entity, size = "") {
  const a = entity?.avatar || "";
  const color = entity?.color || "#4b5563";
  const isImg = a.startsWith("data:") || a.startsWith("http");
  const el = h("div", { class: `avatar ${size}`, style: { background: isImg ? "transparent" : color } });
  if (isImg) el.append(h("img", { src: a, alt: "" }));
  else el.textContent = a && [...a].length <= 2 ? a : (entity?.name || "?").trim().slice(0, 1).toUpperCase();
  return el;
}

export function toast(msg, kind = "") {
  const t = h("div", { class: `toast ${kind}` }, msg);
  $("#toasts").append(t);
  setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .3s"; setTimeout(() => t.remove(), 300); }, kind === "error" ? 6000 : 2800);
}

/** Modal: returns { close, body, foot } */
export function modal({ title, body, foot, wide = false, onClose } = {}) {
  const back = h("div", { class: "modal-back" });
  const bodyEl = h("div", { class: "m-body" }, body);
  const footEl = h("div", { class: "m-foot" }, foot);
  const box = h("div", { class: `modal ${wide ? "wide" : ""}` },
    h("div", { class: "m-head" }, h("span", {}, title), h("button", { class: "btn ghost icon", onClick: () => close() }, "✕")),
    bodyEl, foot ? footEl : null,
  );
  back.append(box);
  const close = () => { back.remove(); document.removeEventListener("keydown", onKey); onClose?.(); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  back.addEventListener("mousedown", (e) => { if (e.target === back) close(); });
  document.body.append(back);
  return { close, body: bodyEl, foot: footEl, el: box };
}

export function confirm(message, { okText = "Confirm", danger = false } = {}) {
  return new Promise((resolve) => {
    const m = modal({
      title: "Are you sure?",
      body: h("p", { style: { margin: 0 } }, message),
      foot: [
        h("button", { class: "btn", onClick: () => { resolve(false); m.close(); } }, "Cancel"),
        h("button", { class: `btn ${danger ? "danger" : "primary"}`, onClick: () => { resolve(true); m.close(); } }, okText),
      ],
      onClose: () => resolve(false),
    });
  });
}

export function prompt(title, { value = "", placeholder = "", multiline = false, okText = "OK", hint = "" } = {}) {
  return new Promise((resolve) => {
    const input = multiline
      ? h("textarea", { class: "input", rows: 5, placeholder })
      : h("input", { class: "input", placeholder });
    input.value = value;
    const submit = () => { resolve(input.value); m.close(); };
    const m = modal({
      title,
      body: [input, hint ? h("div", { class: "muted small", style: { marginTop: "8px" } }, hint) : null],
      foot: [h("button", { class: "btn", onClick: () => { resolve(null); m.close(); } }, "Cancel"), h("button", { class: "btn primary", onClick: submit }, okText)],
      onClose: () => resolve(null),
    });
    setTimeout(() => input.focus(), 30);
    if (!multiline) input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  });
}

export function field(label, input, { hint, action } = {}) {
  return h("label", { class: "field" }, h("span", {}, h("span", {}, label, hint ? h("span", { class: "hint" }, " · ", hint) : null), action || null), input);
}

export function textarea(value = "", attrs = {}) {
  const t = h("textarea", { class: "input", ...attrs });
  t.value = value ?? "";
  return t;
}
export function input(value = "", attrs = {}) {
  const t = h("input", { class: "input", ...attrs });
  t.value = value ?? "";
  return t;
}
export function select(options, value, attrs = {}) {
  const s = h("select", { class: "input", ...attrs }, options.map((o) => h("option", { value: o.value ?? o.id ?? o }, o.label ?? o.name ?? o)));
  s.value = value ?? "";
  return s;
}
export function toggle(label, checked, onChange) {
  const inp = h("input", { type: "checkbox" });
  inp.checked = !!checked;
  inp.addEventListener("change", () => onChange?.(inp.checked));
  return h("label", { class: "switch" }, inp, h("span", { class: "track" }), h("span", {}, label));
}

export const timeAgo = (ts) => {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 7 * 86400) return `${Math.floor(d / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
};

export function autoGrow(ta) {
  const fit = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 220) + "px"; };
  ta.addEventListener("input", fit);
  setTimeout(fit, 0);
  return fit;
}

export function download(filename, content, type = "application/json") {
  const blob = new Blob([typeof content === "string" ? content : JSON.stringify(content, null, 2)], { type });
  const a = h("a", { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a); a.click(); a.remove();
}

export function readFile(accept = "application/json") {
  return new Promise((resolve) => {
    const inp = h("input", { type: "file", accept, style: { display: "none" } });
    inp.addEventListener("change", () => {
      const f = inp.files[0];
      if (!f) return resolve(null);
      const r = new FileReader();
      r.onload = () => resolve({ name: f.name, text: r.result });
      r.readAsText(f);
    });
    document.body.append(inp); inp.click(); inp.remove();
  });
}

export function readImageAsDataUrl(maxSize = 256) {
  return new Promise((resolve) => {
    const inp = h("input", { type: "file", accept: "image/*", style: { display: "none" } });
    inp.addEventListener("change", () => {
      const f = inp.files[0];
      if (!f) return resolve(null);
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        const s = Math.min(1, maxSize / Math.max(img.width, img.height));
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL("image/jpeg", 0.85));
      };
      img.src = URL.createObjectURL(f);
    });
    document.body.append(inp); inp.click(); inp.remove();
  });
}
