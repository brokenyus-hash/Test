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
