import { app } from "./app.js";
import { dbPath } from "./db.js";

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Tavern AI running at http://localhost:${port}`);
  console.log(`Database: ${dbPath}`);
});
