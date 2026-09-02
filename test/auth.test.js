import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Spawn the real server with an env and wait for /healthz. */
async function launch(env) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tavern-auth-"));
  const port = 3900 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", "server/index.js"], {
    env: { ...process.env, PORT: String(port), DATA_DIR: tmp, ...env }, stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/healthz")).ok) break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { base, stop: () => { child.kill(); fs.rmSync(tmp, { recursive: true, force: true }); } };
}
const status = (u, headers) => fetch(u, { headers }).then((r) => r.status);
const basic = (u, p) => ({ Authorization: "Basic " + Buffer.from(`${u}:${p}`).toString("base64") });

test("APP_PASSWORD gates everything except /healthz", async () => {
  const { base, stop } = await launch({ APP_PASSWORD: "s3cret", APP_USER: "" });
  try {
    assert.equal(await status(base + "/healthz"), 200);
    assert.equal(await status(base + "/"), 401);
    assert.equal(await status(base + "/api/auth/me"), 401);
    assert.equal(await status(base + "/", basic("tavern", "wrong")), 401);
    assert.equal(await status(base + "/", basic("tavern", "s3cret")), 200);
    assert.equal(await status(base + "/js/app.js", basic("tavern", "s3cret")), 200);
    assert.equal(await status(base + "/api/auth/me", basic("tavern", "s3cret")), 200, "app auth endpoint reachable once past the gate");
  } finally { stop(); }
});

test("without APP_PASSWORD the app is open", async () => {
  const { base, stop } = await launch({ APP_PASSWORD: "" });
  try {
    assert.equal(await status(base + "/api/auth/me"), 200);
    assert.equal(await status(base + "/api/stats"), 401, "account login still required");
  } finally { stop(); }
});
