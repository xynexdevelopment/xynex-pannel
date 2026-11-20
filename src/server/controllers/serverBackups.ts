import { Request, Response } from "express";
import fs from "fs-extra";
import path from "path";
import { isInside } from "../utils/security.js";
import { getContainerStatus } from "../services/docker.js";
import { logActivity, requestActor } from "../services/activityLog.js";
import { readJSON } from "../services/db.js";
import { acquireServerLock, busyMessage } from "../services/serverLocks.js";
import {
  BACKUP_PREFIX,
  RECOVERY_PREFIX,
  BackupError,
  applyRetention,
  backupsDirFor,
  createBackupArchive,
  restoreFromArchive,
} from "../services/backupService.js";
import { CHECKSUM_EXT, verifyBackupArchive } from "../utils/backupIntegrity.js";

const SAFE_ZIP_NAME = /^[\w.-]+\.zip$/;

const canManageBackups = (req: Request) => {
  const access = (req as any).serverAccess;
  return !!access && !!(access.staff || access.isOwner);
};

const sendError = (res: Response, e: any, fallback: string) => {
  if (res.headersSent) return;
  const status = e instanceof BackupError ? e.status : 500;
  res.status(status).json({ error: e?.message || fallback });
};

/* Per-server backups. */
export const getBackups = async (req: Request, res: Response) => {
  const { id } = req.params;
  const backupsDir = backupsDirFor(id);
  await fs.ensureDir(backupsDir);

  try {
    const files = await fs.readdir(backupsDir);
    const backups = [];
    for (const file of files) {
      if (!file.endsWith(".zip")) continue; // in-progress ".partial" files are never listed
      const full = path.join(backupsDir, file);
      const stats = await fs.stat(full);
      backups.push({
        filename: file,
        size: stats.size,
        createdAt: stats.birthtime,
        kind: file.startsWith(RECOVERY_PREFIX) ? "recovery" : "backup",
        hasChecksum: await fs.pathExists(full + CHECKSUM_EXT),
      });
    }
    backups.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    res.json(backups);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
};

export const createBackup = async (req: Request, res: Response) => {
  const { id } = req.params;
  const backupsDir = backupsDirFor(id);
  await fs.ensureDir(backupsDir);

  // Application Feature Limit set at server creation (null/undefined = unlimited).
  // Automatic pre-restore recovery points are not counted against it.
  try {
    const srv = ((await readJSON("servers.json")) || []).find((x: any) => x.id === id);
    if (srv && srv.backupLimit !== null && srv.backupLimit !== undefined) {
      const existing = (await fs.readdir(backupsDir)).filter((f: string) => f.startsWith(BACKUP_PREFIX) && f.endsWith(".zip")).length;
      if (existing >= Number(srv.backupLimit)) {
        return res.status(403).json({ error: `Backup limit reached (${srv.backupLimit}) for this server.` });
      }
    }
  } catch (e) {
    console.warn("Could not check backup limit:", e);
  }

  const lock = acquireServerLock(id, "backup", 6 * 60 * 60 * 1000);
  if (!lock.ok) return res.status(409).json({ error: busyMessage(lock.busyWith) });

  try {
    const { filename, size, sha256 } = await createBackupArchive(id);
    const pruned = await applyRetention(id).catch(() => [] as string[]);
    logActivity({ ...requestActor(req), serverId: id, action: "backup.create", description: `Created backup "${filename}"${pruned.length ? ` (retention removed ${pruned.length} old)` : ""}` });
    res.json({ success: true, filename, size, sha256, pruned });
  } catch (e: any) {
    console.error("Backup failed:", e);
    sendError(res, e, "Backup failed");
  } finally {
    lock.release();
  }
};

export const downloadBackup = async (req: Request, res: Response) => {
  const { id, filename } = req.params;
  const backupPath = path.join(backupsDirFor(id), filename);

  // basic path traversal prevention
  if (!isInside(backupsDirFor(id), backupPath)) {
    return res.status(403).send("Invalid path");
  }

  if (await fs.pathExists(backupPath)) {
    res.download(backupPath);
  } else {
    res.status(404).send("Backup not found");
  }
};

export const deleteBackup = async (req: Request, res: Response) => {
  const { id, filename } = req.params;
  const backupPath = path.join(backupsDirFor(id), filename);

  if (!isInside(backupsDirFor(id), backupPath)) {
    return res.status(403).json({ error: "Invalid path" });
  }

  const lock = acquireServerLock(id, "backup-delete", 10 * 60 * 1000);
  if (!lock.ok) return res.status(409).json({ error: busyMessage(lock.busyWith) });
  try {
    await fs.remove(backupPath);
    await fs.remove(backupPath + CHECKSUM_EXT);
    logActivity({ ...requestActor(req), serverId: id, action: "backup.delete", description: `Deleted backup "${filename}"` });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  } finally {
    lock.release();
  }
};

// "Verify backup": checksum + archive structure + (deep) a full decompress/CRC pass that writes nothing to disk.
export const verifyBackup = async (req: Request, res: Response) => {
  const { id, filename } = req.params;
  if (!canManageBackups(req)) return res.status(403).json({ error: "Only the server owner or an admin can verify a backup" });
  const dir = backupsDirFor(id);
  const backupPath = path.join(dir, filename);
  if (!SAFE_ZIP_NAME.test(filename) || !isInside(dir, backupPath)) return res.status(403).json({ error: "Invalid path" });
  if (!(await fs.pathExists(backupPath))) return res.status(404).json({ error: "Backup not found" });
  try {
    const report = await verifyBackupArchive(backupPath, { deep: true });
    res.json(report);
  } catch (e: any) {
    res.status(500).json({ error: e.message || "Verification failed" });
  }
};

// Pterodactyl-style "Restore Backup". Safety rules:
//  * explicit confirmation is required by the API (not just the UI)
//  * the server must be stopped, and no other operation may be running on it
//  * the archive is verified first and a recovery point of the current data is taken
//    before anything is overwritten; a failed restore is rolled back automatically
export const restoreBackup = async (req: Request, res: Response) => {
  const { id, filename } = req.params;
  const truncate = req.body?.truncate === true;
  if (!canManageBackups(req)) {
    return res.status(403).json({ error: "Only the server owner or an admin can restore a backup" });
  }
  if (req.body?.confirm !== true) {
    return res.status(400).json({ error: "Restoring overwrites server files. Send confirm: true to proceed.", code: "confirmation_required" });
  }
  const dir = backupsDirFor(id);
  const backupPath = path.join(dir, filename);
  if (!SAFE_ZIP_NAME.test(filename) || !isInside(dir, backupPath)) {
    return res.status(403).json({ error: "Invalid path" });
  }
  if (!(await fs.pathExists(backupPath))) return res.status(404).json({ error: "Backup not found" });

  const lock = acquireServerLock(id, "restore", 4 * 60 * 60 * 1000);
  if (!lock.ok) return res.status(409).json({ error: busyMessage(lock.busyWith) });

  try {
    const srv = ((await readJSON("servers.json")) || []).find((x: any) => x.id === id);
    if (srv?.status === "installing") {
      return res.status(409).json({ error: "The server is still installing." });
    }
    if (srv?.containerId) {
      const status = await getContainerStatus(srv.containerId);
      if (status?.State?.Running) {
        return res.status(400).json({ error: "Stop the server before restoring a backup." });
      }
    }
    const { recoveryPoint, report } = await restoreFromArchive(id, filename, { truncate });
    logActivity({
      ...requestActor(req), serverId: id, serverName: srv?.name, action: "backup.restore",
      description: `Restored backup "${filename}"${truncate ? " (directory truncated)" : ""}${recoveryPoint ? `; recovery point "${recoveryPoint}"` : ""}`,
    });
    res.json({ success: true, recoveryPoint, checksum: report.checksum, entries: report.entries });
  } catch (e: any) {
    console.error("Restore failed:", e);
    sendError(res, e, "Failed to restore backup");
  } finally {
    lock.release();
  }
};
