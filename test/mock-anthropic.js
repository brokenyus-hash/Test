// A tiny stand-in for the Anthropic Messages API, used by the test-suite and for
// offline demos (`npm run demo`). It streams canned prose and, for structured-output
// requests, synthesises a value that satisfies the requested JSON schema.
import http from "node:http";

/** Build a value satisfying a JSON schema (handles $ref and the SDK's "{minItems: n}" / "{enum: [...]}" description hints). */
export function instanceFromSchema(schema, hint = "", root = schema) {
  if (!schema) return null;
  if (schema.$ref) {
    const target = schema.$ref.replace(/^#\//, "").split("/").reduce((o, k) => o?.[k], root);
    return instanceFromSchema({ ...target, description: schema.description || target.description }, hint, root);
  }
  const hints = {};
  const m = typeof schema.description === "string" && schema.description.match(/\{[^{}]*\}\s*$/);
  if (m) {
    try { Object.assign(hints, JSON.parse(m[0].replace(/(\w+):/g, '"$1":'))); } catch { /* not a hint */ }
  }
  const enumVals = schema.enum || hints.enum;
  if (enumVals) return enumVals[0];
  switch (schema.type) {
    case "string": return `mock ${hint}`.trim();
    case "number": case "integer": return schema.minimum ?? hints.minimum ?? 3;
    case "boolean": return false;
    case "array": {
      const n = Math.max(schema.minItems ?? hints.minItems ?? 1, 1);
      return Array.from({ length: n }, (_, i) => instanceFromSchema(schema.items, `${hint} ${i + 1}`, root));
    }
    case "object": {
      const out = {};
      for (const [k, v] of Object.entries(schema.properties || {})) out[k] = instanceFromSchema(v, k, root);
      return out;
    }
    default:
      if (schema.anyOf) return instanceFromSchema(schema.anyOf[0], hint, root);
      return null;
  }
}

const REPLY = `*The mock character considers you for a long moment, rain ticking against the window.*\n\n"So you came after all," she says. "What do you want from me?"`;

export function startMock({ port = 0, reply = REPLY, delayMs = 2 } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = body ? JSON.parse(body) : {};
      requests.push({ url: req.url, headers: req.headers, body: json });
      if (!req.url.startsWith("/v1/messages")) { res.writeHead(404); return res.end("{}"); }
      if (!req.headers["x-api-key"] && !req.headers.authorization) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "missing key" } }));
      }
      let text = reply;
      const fmt = json.output_config?.format;
      if (fmt?.schema) text = JSON.stringify(instanceFromSchema(fmt.schema));
      const usage = { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      if (json.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const send = (ev, d) => res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`);
        send("message_start", { type: "message_start", message: { id: "msg_mock", type: "message", role: "assistant", model: json.model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 0 } } });
        send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        const chunks = text.match(/[\s\S]{1,12}/g) || [];
        let i = 0;
        const tick = () => {
          if (i < chunks.length) {
            send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunks[i++] } });
            setTimeout(tick, delayMs);
          } else {
            send("content_block_stop", { type: "content_block_stop", index: 0 });
            send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 40 } });
            send("message_stop", { type: "message_stop" });
            res.end();
          }
        };
        tick();
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "msg_mock", type: "message", role: "assistant", model: json.model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage }));
      }
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

if (process.argv[1] && process.argv[1].endsWith("mock-anthropic.js")) {
  startMock({ port: Number(process.env.MOCK_PORT) || 3999, delayMs: 15 }).then((m) => console.log(`Mock Anthropic API at ${m.url}`));
}
