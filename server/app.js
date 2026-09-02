import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { api } from "./routes/api.js";
import { aiRoutes } from "./routes/ai.js";
import { describeError } from "./claude.js";
import { sessionMiddleware } from "./auth.js";
import { createRequire } from "node:module";

const APP_VERSION = createRequire(import.meta.url)("../package.json").version;

const here = path.dirname(fileURLToPath(import.meta.url));

/** Short git commit of the running code (from TAVERN_COMMIT or the checkout's .git), or null. */
function readCommit() {
  if (process.env.TAVERN_COMMIT) return process.env.TAVERN_COMMIT.slice(0, 7);
  try {
    const git = path.join(here, "..", ".git");
    const head = fs.readFileSync(path.join(git, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref: ")) return head.slice(0, 7);
    const ref = head.slice(5);
    try { return fs.readFileSync(path.join(git, ref), "utf8").trim().slice(0, 7); }
    catch { return fs.readFileSync(path.join(git, "packed-refs"), "utf8").split("\n").find((l) => l.endsWith(" " + ref))?.split(" ")[0].slice(0, 7) || null; }
  } catch { return null; }
}
const APP_COMMIT = readCommit();

export const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "20mb" }));

// Unauthenticated health check for load balancers / Kubernetes probes; also shows what is deployed.
app.get("/healthz", (req, res) => res.json({ ok: true, version: APP_VERSION, commit: APP_COMMIT }));

// Optional protection for internet-facing deployments: set APP_PASSWORD (and optionally APP_USER).
if (process.env.APP_PASSWORD) {
  const user = process.env.APP_USER || "tavern";
  app.use((req, res, next) => {
    const hdr = req.headers.authorization || "";
    const [scheme, b64] = hdr.split(" ");
    if (scheme === "Basic" && b64) {
      const [u, ...rest] = Buffer.from(b64, "base64").toString().split(":");
      if (u === user && rest.join(":") === process.env.APP_PASSWORD) return next();
    }
    res.setHeader("WWW-Authenticate", 'Basic realm="Tavern"');
    res.status(401).send("Authentication required");
  });
}

app.set("trust proxy", 1);
app.use(sessionMiddleware);
app.use("/api/ai", aiRoutes);
app.use("/api", api);

app.use(express.static(path.join(here, "..", "public"), { extensions: ["html"] }));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(here, "..", "public", "index.html")));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || 500;
  if (res.headersSent) return res.end();
  res.status(status).json({ error: describeError(err) });
});
