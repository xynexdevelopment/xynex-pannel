import fs from "fs-extra";
import path from "path";
import { readJSON, updateJSON } from "./db.js";

/* State recovery after a panel restart / VPS reboot.
   Long-running operations (install, reinstall, backups) run inside the panel process, so a restart
   mid-operation would otherwise leave servers stuck in "installing" forever and half-written
   ".partial" backup files on disk. Runs once at startup, before the panel accepts requests. */

export async function recoverInterruptedOperations(): Promise<{ installs: number; partialBackups: number }> {
  let installs = 0;
  const servers: any[] = (await readJSON("servers.json")) || [];
  if (servers.some((s) => s?.status === "installing")) {
    await updateJSON<any[]>("servers.json", [], (current) => {
      for (const s of current) {
        if (s?.status === "installing") {
          s.status = "install_failed";
          s.installError = "The installation was interrupted by a panel restart. Use Reinstall to run it again.";
          installs++;
        }
      }
      return current;
    });
  }

  let partialBackups = 0;
  const root = path.join(process.cwd(), ".data", "backups");
  try {
    for (const serverId of await fs.readdir(root)) {
      const dir = path.join(root, serverId);
      let files: string[] = [];
      try { files = await fs.readdir(dir); } catch { continue; }
      for (const f of files) {
        if (f.endsWith(".partial")) { await fs.remove(path.join(dir, f)); partialBackups++; }
      }
    }
  } catch { /* no backups yet */ }

  if (installs || partialBackups) {
    console.warn(`[recovery] marked ${installs} interrupted install(s) as failed, removed ${partialBackups} partial backup file(s)`);
  }
  return { installs, partialBackups };
}
