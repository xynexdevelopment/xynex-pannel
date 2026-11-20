import fs from "fs-extra";
import path from "path";
import crypto from "crypto";
import { ZipArchive } from "archiver";
import { serverRoot } from "../utils/security.js";
import extract from "../utils/safeZip.js";
import {
  CHECKSUM_EXT,
  ArchiveReport,
  dirSizeBytes,
  freeDiskBytes,
  verifyBackupArchive,
  writeChecksum,
} from "../utils/backupIntegrity.js";

/* Backup creation / restore core, shared by the HTTP controller (and usable by schedulers).

   Environment (all optional):
     MAX_BACKUP_BYTES=<n>        refuse/abort a backup larger than this (default 0 = unlimited)
     MIN_FREE_DISK_BYTES=<n>     keep at least this much disk free (default 1 GiB)
     RESTORE_RECOVERY_KEEP=<n>   how many automatic pre-restore recovery points to keep (default 3)
     BACKUP_RETENTION_COUNT=<n>  keep only the newest n regular backups per server (default 0 = keep all)
*/

export class BackupError extends Error {
  constructor(message: string, public status = 500) { super(message); }
}

export const backupsDirFor = (serverId: string) => path.join(process.cwd(), ".data", "backups", serverId);
export const RECOVERY_PREFIX = "pre-restore-";
export const BACKUP_PREFIX = "backup-";

const envInt = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};
const minFree = () => envInt("MIN_FREE_DISK_BYTES", 1024 ** 3);

async function ensureRoom(dir: string, needBytes: number, what: string) {
  const free = await freeDiskBytes(dir);
  if (free === null) return; // platform can't report - don't block
  if (free < needBytes + minFree()) {
    throw new BackupError(`Not enough free disk space to ${what} (need about ${Math.ceil(needBytes / 1024 ** 2)} MiB plus a safety reserve).`, 507);
  }
}

/** Removes leftovers of interrupted backups. Caller must hold the server's operation lock. */
export async function cleanupPartialBackups(serverId: string): Promise<number> {
  const dir = backupsDirFor(serverId);
  let removed = 0;
  try {
    for (const f of await fs.readdir(dir)) {
      if (f.endsWith(".partial")) { await fs.remove(path.join(dir, f)); removed++; }
    }
  } catch { /* directory may not exist yet */ }
  return removed;
}

export async function createBackupArchive(
  serverId: string,
  opts: { prefix?: string; ignoreSizeCap?: boolean } = {},
): Promise<{ filename: string; size: number; sha256: string }> {
  const serverDir = serverRoot(serverId);
  const dir = backupsDirFor(serverId);
  await fs.ensureDir(dir);
  await fs.ensureDir(serverDir);
  await cleanupPartialBackups(serverId);

  const cap = opts.ignoreSizeCap ? 0 : envInt("MAX_BACKUP_BYTES", 0);
  const sourceSize = await dirSizeBytes(serverDir);
  if (cap > 0 && sourceSize > cap * 20) {
    // The compressed size can't be known up front; this only rejects the obviously hopeless case early.
    throw new BackupError("Server data is far larger than the configured backup size limit.", 413);
  }
  await ensureRoom(dir, cap > 0 ? Math.min(sourceSize, cap) : sourceSize, "create the backup");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${opts.prefix ?? BACKUP_PREFIX}${stamp}.zip`;
  const finalPath = path.join(dir, filename);
  const tmpPath = finalPath + ".partial";

  const sha256: string = await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmpPath, { mode: 0o600 });
    const archive = new ZipArchive({ zlib: { level: 6 } });
    const hash = crypto.createHash("sha256");
    let failed = false;
    const fail = (e: unknown) => {
      if (failed) return;
      failed = true;
      try { archive.abort(); } catch { /* already finished */ }
      out.destroy();
      fs.remove(tmpPath).finally(() => reject(e instanceof Error ? e : new Error(String(e))));
    };

    archive.on("data", (chunk: Buffer) => hash.update(chunk));
    archive.on("error", fail);
    archive.on("warning", (w: any) => { if (w?.code !== "ENOENT") fail(w); }); // a file vanishing mid-backup is tolerated, anything else is not
    if (cap > 0) {
      archive.on("progress", () => { if (archive.pointer() > cap) fail(new BackupError(`Backup exceeds the size limit (${Math.round(cap / 1024 ** 2)} MiB).`, 413)); });
    }
    out.on("error", fail);
    out.on("close", () => { if (!failed) resolve(hash.digest("hex")); });

    archive.pipe(out);
    archive.directory(serverDir, false);
    archive.finalize().catch(fail);
  });

  // Make sure what we wrote is a readable archive before it is allowed to count as a backup.
  const quick = await verifyBackupArchive(tmpPath);
  if (!quick.ok) {
    await fs.remove(tmpPath);
    throw new BackupError(`Backup failed verification and was discarded: ${quick.error}`, 500);
  }
  await fs.rename(tmpPath, finalPath);
  await writeChecksum(finalPath, sha256);
  const size = (await fs.stat(finalPath)).size;
  return { filename, size, sha256 };
}

async function removeBackupFiles(dir: string, filename: string) {
  await fs.remove(path.join(dir, filename));
  await fs.remove(path.join(dir, filename + CHECKSUM_EXT));
}

/** Keep only the newest `keep` files with the given prefix (0 = keep everything). */
export async function pruneByPrefix(serverId: string, prefix: string, keep: number): Promise<string[]> {
  if (keep <= 0) return [];
  const dir = backupsDirFor(serverId);
  const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => f.startsWith(prefix) && f.endsWith(".zip"));
  const withTime = await Promise.all(names.map(async (f) => ({ f, t: (await fs.stat(path.join(dir, f))).mtimeMs })));
  withTime.sort((a, b) => b.t - a.t);
  const doomed = withTime.slice(keep).map((x) => x.f);
  for (const f of doomed) await removeBackupFiles(dir, f);
  return doomed;
}

export const applyRetention = (serverId: string) => pruneByPrefix(serverId, BACKUP_PREFIX, envInt("BACKUP_RETENTION_COUNT", 0));

/** Snapshot of the server's current data, taken automatically before a restore overwrites it. */
export async function createRecoveryPoint(serverId: string): Promise<string | null> {
  const serverDir = serverRoot(serverId);
  if (!(await fs.pathExists(serverDir)) || (await fs.readdir(serverDir)).length === 0) return null;
  const { filename } = await createBackupArchive(serverId, { prefix: RECOVERY_PREFIX, ignoreSizeCap: true });
  await pruneByPrefix(serverId, RECOVERY_PREFIX, Math.max(1, envInt("RESTORE_RECOVERY_KEEP", 3)));
  return filename;
}

export interface RestoreResult { recoveryPoint: string | null; report: ArchiveReport }

/**
 * Restore `filename` into the server directory.
 * Order matters: verify the archive -> check disk -> take a recovery point -> only then touch live data.
 * If extraction fails after data was changed, the recovery point is restored automatically.
 * The caller must hold the server's operation lock and have confirmed the server is stopped.
 */
export async function restoreFromArchive(serverId: string, filename: string, opts: { truncate: boolean }): Promise<RestoreResult> {
  const dir = backupsDirFor(serverId);
  const archivePath = path.join(dir, filename);
  const serverDir = serverRoot(serverId);

  const report = await verifyBackupArchive(archivePath);
  if (!report.ok) throw new BackupError(`Backup cannot be restored: ${report.error}`, 422);

  await fs.ensureDir(serverDir);
  const recoveryPoint = await createRecoveryPoint(serverId).catch((e) => {
    throw new BackupError(`Could not create a recovery point, so nothing was changed: ${e.message}`, e instanceof BackupError ? e.status : 500);
  });

  await ensureRoom(serverDir, report.uncompressedBytes, "restore the backup");

  try {
    if (opts.truncate) await fs.emptyDir(serverDir);
    await extract(archivePath, { dir: serverDir });
  } catch (e: any) {
    let rolledBack = false;
    if (recoveryPoint) {
      try {
        await fs.emptyDir(serverDir);
        await extract(path.join(dir, recoveryPoint), { dir: serverDir });
        rolledBack = true;
      } catch (rbErr) {
        console.error(`[backup] rollback after failed restore of ${serverId} failed:`, rbErr);
      }
    }
    throw new BackupError(
      `Restore failed: ${e.message}. ` + (recoveryPoint
        ? (rolledBack ? "Your previous data was restored automatically." : `Automatic rollback also failed - your previous data is in the recovery point "${recoveryPoint}".`)
        : "There was no previous data to roll back to."),
      500,
    );
  }
  return { recoveryPoint, report };
}
