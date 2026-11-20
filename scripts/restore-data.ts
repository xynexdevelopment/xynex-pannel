import path from "path";
import { restoreData } from "../src/server/utils/dataBackup";

// Usage: npm run restore -- <backup.zip> [--force]   (stop the panel first)
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) { console.error("Usage: npm run restore -- <backup.zip> [--force]"); process.exit(1); }
restoreData(path.resolve(file), path.join(process.cwd(), ".data"), { force: args.includes("--force") })
  .then((r) => console.log(`Restored: ${r.restored.join(", ")}${r.savedTo ? `\nPrevious files were saved to ${r.savedTo}` : ""}\nRestart the panel.`))
  .catch((e) => { console.error("Restore failed:", e.message); process.exit(1); });
