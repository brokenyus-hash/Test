import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { api } from "./routes/api.js";
import { aiRoutes } from "./routes/ai.js";
import { describeError } from "./claude.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "20mb" }));

// Unauthenticated health check for load balancers / Kubernetes probes.
app.get("/healthz", (req, res) => res.json({ ok: true }));

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
