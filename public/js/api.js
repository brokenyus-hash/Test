// Thin API client + SSE-over-POST stream reader. A 401 anywhere raises the sign-in screen.
export class ApiError extends Error { constructor(message, status, code) { super(message); this.status = status; this.code = code; } }

async function req(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" });
  if (!res.ok) {
    let msg = res.statusText, code;
    try { const j = await res.json(); msg = j.error || msg; code = j.code; } catch { /* ignore */ }
    if (res.status === 401 && code === "unauthenticated") window.dispatchEvent(new CustomEvent("auth:required"));
    throw new ApiError(msg, res.status, code);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("json") ? res.json() : res.text();
}
export const get = (u) => req("GET", u);
export const post = (u, b = {}) => req("POST", u, b);
export const put = (u, b = {}) => req("PUT", u, b);
export const del = (u) => req("DELETE", u);

/** POST and consume a Server-Sent-Events response; onEvent(name, data). The returned promise has .abort(). */
export function stream(url, body, onEvent) {
  const ac = new AbortController();
  const p = (async () => {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}), signal: ac.signal, credentials: "same-origin" });
    if (!res.ok) {
      let msg = res.statusText, code;
      try { const j = await res.json(); msg = j.error || msg; code = j.code; } catch { /* ignore */ }
      if (res.status === 401 && code === "unauthenticated") window.dispatchEvent(new CustomEvent("auth:required"));
      throw new ApiError(msg, res.status, code);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let ev = "message", data = "";
        for (const line of chunk.split("\n")) {
          if (line.startsWith("event:")) ev = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data) continue;
        try { onEvent(ev, JSON.parse(data)); } catch (e) { console.warn("bad sse", e); }
      }
    }
  })();
  p.abort = () => ac.abort();
  return p;
}

/** POST a long-running AI job (SSE: status/result/error) and resolve with the result. */
export async function job(url, body, onStatus) {
  let result, error;
  await stream(url, body, (ev, d) => {
    if (ev === "result") result = d;
    else if (ev === "error") error = d.error;
    else if (ev === "status") onStatus?.(d.text);
  });
  if (error) throw new Error(error);
  if (result === undefined) throw new Error("The connection dropped before the result arrived. Please try again.");
  return result;
}
