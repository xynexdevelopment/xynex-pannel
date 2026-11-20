import path from "path";
import { backupData } from "../src/server/utils/dataBackup";

// Usage: npm run backup [-- <output-dir>]   (default: ./backups/panel-data)
const out = process.argv[2] || path.join(process.cwd(), "backups", "panel-data");
backupData(path.join(process.cwd(), ".data"), out)
  .then((r) => console.log(`Backed up ${r.entries.length} files -> ${r.file}\nThis archive contains secrets (password hashes, 2FA secrets): keep it private.`))
  .catch((e) => { console.error("Backup failed:", e.message); process.exit(1); });
