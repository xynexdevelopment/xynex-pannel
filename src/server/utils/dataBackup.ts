import { ZipArchive } from "archiver";
import fs from "fs-extra";
import path from "path";
import os from "os";
import safeExtractZip from "./safeZip.js";

/* Backup / restore of the panel's own data (users, servers, settings, api keys, ... = the *.json files
   in .data, plus the session secret and SFTP host key). Game-server files are NOT included: those have
   their own per-server backups. The archive contains secrets (password hashes, 2FA secrets), so it is
   written 0600 - store it somewhere private.
   Restore never deletes anything: without `force` it refuses to overwrite existing files; with `force`
   it first copies the current files into .data/restore-backup-<timestamp>/. */

const DATA_FILE = /^[a-zA-Z0-9._-]+\.json$/;
const EXTRA_FILES = ["jwt.secret", "secret.key", path.join("ssh", "host_rsa")];

function listBackupFiles(dataDir: string): string[] {
  const out: string[] = [];
  if (fs.existsSync(dataDir)) for (const f of fs.readdirSync(dataDir)) if (DATA_FILE.test(f) && fs.statSync(path.join(dataDir, f)).isFile()) out.push(f);
  for (const f of EXTRA_FILES) if (fs.existsSync(path.join(dataDir, f))) out.push(f);
  return out;
}

export async function backupData(dataDir: string, outDir: string): Promise<{ file: string; entries: string[] }> {
  const entries = listBackupFiles(dataDir);
  if (!entries.length) throw new Error(`Nothing to back up in ${dataDir}`);
  await fs.ensureDir(outDir);
  const file = path.join(outDir, `xynex-data-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`);
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(file, { mode: 0o600 });
    const zip = new ZipArchive({ zlib: { level: 6 } });
    out.on("close", resolve);
    out.on("error", reject);
    zip.on("error", reject);
    zip.pipe(out);
    for (const e of entries) zip.file(path.join(dataDir, e), { name: e.split(path.sep).join("/") });
    void zip.finalize();
  });
  await fs.chmod(file, 0o600);
  return { file, entries };
}

export async function restoreData(zipFile: string, dataDir: string, opts: { force?: boolean } = {}): Promise<{ restored: string[]; savedTo?: string }> {
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), "xynex-restore-"));
  try {
    await safeExtractZip(zipFile, { dir: stage });
    const staged: string[] = [];
    for (const f of [...(await fs.readdir(stage)).filter((n) => DATA_FILE.test(n)), ...EXTRA_FILES.filter((f) => fs.existsSync(path.join(stage, f)))]) {
      if (f.endsWith(".json")) {
        try { JSON.parse(await fs.readFile(path.join(stage, f), "utf8")); }
        catch { throw new Error(`${f} in the backup is not valid JSON - nothing was restored`); }
      }
      staged.push(f);
    }
    if (!staged.length) throw new Error("The archive contains no panel data files - nothing was restored");

    const conflicts = staged.filter((f) => fs.existsSync(path.join(dataDir, f)));
    if (conflicts.length && !opts.force) throw new Error(`Would overwrite existing files (${conflicts.join(", ")}). Re-run with --force; current copies are saved first.`);

    await fs.ensureDir(dataDir);
    let savedTo: string | undefined;
    if (conflicts.length) {
      savedTo = path.join(dataDir, `restore-backup-${Date.now()}`);
      for (const f of conflicts) { await fs.ensureDir(path.dirname(path.join(savedTo, f))); await fs.copy(path.join(dataDir, f), path.join(savedTo, f)); }
      await fs.chmod(savedTo, 0o700);
    }
    for (const f of staged) {
      const dest = path.join(dataDir, f);
      await fs.ensureDir(path.dirname(dest));
      const tmp = `${dest}.restore-${process.pid}.tmp`;
      await fs.copy(path.join(stage, f), tmp);
      await fs.chmod(tmp, 0o600);
      await fs.rename(tmp, dest); // atomic replace
    }
    return { restored: staged, savedTo };
  } finally {
    await fs.remove(stage).catch(() => undefined);
  }
}
