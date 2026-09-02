import { app } from "./app.js";
import { dbPath } from "./db.js";

// Make crashes visible in host logs instead of dying silently.
process.on("uncaughtException", (e) => { console.error("[fatal] uncaughtException", e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error("[fatal] unhandledRejection", e); process.exit(1); });
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { console.log(`[exit] received ${sig}`); process.exit(0); });

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Tavern AI running at http://localhost:${port} (node ${process.version}, pid ${process.pid})`);
  console.log(`Database: ${dbPath}`);
});
