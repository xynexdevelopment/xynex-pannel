import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs-extra";
import os from "os";
import path from "path";
import { makeZip } from "./helpers";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xynex-backup-"));
const cwd = process.cwd();
const ID = "srv-test-1";
let svc: typeof import("../src/server/services/backupService");
let integ: typeof import("../src/server/utils/backupIntegrity");
let recovery: typeof import("../src/server/services/recovery");
let db: typeof import("../src/server/services/db");

const serverDir = () => path.join(tmp, ".data", "servers", ID);
const backupsDir = () => path.join(tmp, ".data", "backups", ID);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const listZips = (prefix: string) => fs.readdirSync(backupsDir()).filter((f) => f.startsWith(prefix) && f.endsWith(".zip"));

beforeAll(async () => {
  process.chdir(tmp);
  process.env.MIN_FREE_DISK_BYTES = "0";
  svc = await import("../src/server/services/backupService");
  integ = await import("../src/server/utils/backupIntegrity");
  recovery = await import("../src/server/services/recovery");
  db = await import("../src/server/services/db");
});
afterAll(() => { process.chdir(cwd); fs.removeSync(tmp); });

beforeEach(async () => {
  delete process.env.MAX_BACKUP_BYTES;
  delete process.env.BACKUP_RETENTION_COUNT;
  delete process.env.RESTORE_RECOVERY_KEEP;
  process.env.MIN_FREE_DISK_BYTES = "0";
  await fs.remove(path.join(tmp, ".data"));
  await fs.outputFile(path.join(serverDir(), "world", "level.dat"), "ORIGINAL-WORLD");
  await fs.outputFile(path.join(serverDir(), "server.properties"), "motd=hello");
});

describe("archive integrity", () => {
  const zipPath = () => path.join(tmp, "t.zip");
  // Each test starts without the previous test's zip or checksum sidecar.
  beforeEach(() => { fs.removeSync(zipPath()); fs.removeSync(zipPath() + ".sha256"); });

  it("accepts a good archive (shallow and deep)", async () => {
    await fs.writeFile(zipPath(), makeZip([{ name: "a.txt", data: "hello" }, { name: "d/b.txt", data: "world" }]));
    const shallow = await integ.verifyBackupArchive(zipPath());
    expect(shallow).toMatchObject({ ok: true, entries: 2, checksum: "missing" });
    const deep = await integ.verifyBackupArchive(zipPath(), { deep: true });
    expect(deep.ok).toBe(true);
  });

  it("detects a flipped byte via the SHA-256 sidecar", async () => {
    const buf = makeZip([{ name: "a.txt", data: "hello world" }]);
    await fs.writeFile(zipPath(), buf);
    await integ.writeChecksum(zipPath(), await integ.sha256File(zipPath()));
    expect((await integ.verifyBackupArchive(zipPath())).checksum).toBe("verified");
    buf[35] ^= 0xff;
    await fs.writeFile(zipPath(), buf);
    const r = await integ.verifyBackupArchive(zipPath());
    expect(r.ok).toBe(false);
    expect(r.checksum).toBe("mismatch");
  });

  it("deep mode catches corrupted file data even without a sidecar (CRC)", async () => {
    const buf = makeZip([{ name: "a.txt", data: "hello world" }]);
    const at = buf.indexOf("hello world");
    buf[at] ^= 0x01;
    await fs.writeFile(zipPath(), buf);
    expect((await integ.verifyBackupArchive(zipPath())).ok).toBe(true);               // structure alone looks fine
    const deep = await integ.verifyBackupArchive(zipPath(), { deep: true });
    expect(deep.ok).toBe(false);
    expect(deep.error).toMatch(/CRC/i);
  });

  it("rejects path traversal, absolute paths, garbage and missing files", async () => {
    await fs.writeFile(zipPath(), makeZip([{ name: "../../evil.txt", data: "x" }]));
    const traversal = await integ.verifyBackupArchive(zipPath());
    expect(traversal.ok).toBe(false);
    // yauzl itself rejects "../" names while reading; our own check is the second line of defence.
    expect(traversal.error).toMatch(/Unsafe path|invalid relative path/);
    await fs.writeFile(zipPath(), makeZip([{ name: "/etc/cron.d/x", data: "x" }]));
    expect((await integ.verifyBackupArchive(zipPath())).ok).toBe(false);
    await fs.writeFile(zipPath(), "this is not a zip");
    expect((await integ.verifyBackupArchive(zipPath())).error).toMatch(/Not a valid zip/);
    expect((await integ.verifyBackupArchive(path.join(tmp, "missing.zip"))).ok).toBe(false);
  });

  it("enforces entry-count and size ceilings (zip bomb limits)", async () => {
    await fs.writeFile(zipPath(), makeZip([{ name: "a", data: "1" }, { name: "b", data: "2" }]));
    expect((await integ.verifyBackupArchive(zipPath(), { maxEntries: 1 })).error).toMatch(/too many/);
    await fs.writeFile(zipPath(), makeZip([{ name: "big", data: "x".repeat(5000) }]));
    expect((await integ.verifyBackupArchive(zipPath(), { maxTotalBytes: 1000 })).error).toMatch(/too large/);
  });
});

describe("creating backups", () => {
  it("writes a verified archive with a matching checksum sidecar and no leftovers", async () => {
    const { filename, sha256 } = await svc.createBackupArchive(ID);
    const file = path.join(backupsDir(), filename);
    expect(filename).toMatch(/^backup-.*\.zip$/);
    expect(await integ.sha256File(file)).toBe(sha256);
    expect(await integ.readChecksum(file)).toBe(sha256);
    expect(fs.readdirSync(backupsDir()).some((f) => f.endsWith(".partial"))).toBe(false);
    const deep = await integ.verifyBackupArchive(file, { deep: true });
    expect(deep).toMatchObject({ ok: true, checksum: "verified" });
  });

  it("removes the half-written file when the size limit is exceeded", async () => {
    await fs.outputFile(path.join(serverDir(), "random.bin"), (await import("crypto")).randomBytes(60_000));
    process.env.MAX_BACKUP_BYTES = "10000";
    await expect(svc.createBackupArchive(ID)).rejects.toMatchObject({ status: 413 });
    const left = fs.existsSync(backupsDir()) ? fs.readdirSync(backupsDir()) : [];
    expect(left).toEqual([]);
  });

  it("refuses to start when there is not enough free disk space", async () => {
    process.env.MIN_FREE_DISK_BYTES = String(10 ** 15);
    await expect(svc.createBackupArchive(ID)).rejects.toMatchObject({ status: 507 });
  });

  it("sweeps leftovers of an interrupted backup", async () => {
    await fs.outputFile(path.join(backupsDir(), "backup-crashed.zip.partial"), "junk");
    await svc.createBackupArchive(ID);
    expect(fs.readdirSync(backupsDir()).some((f) => f.endsWith(".partial"))).toBe(false);
  });

  it("retention keeps only the newest N regular backups and their sidecars", async () => {
    for (let i = 0; i < 4; i++) { await svc.createBackupArchive(ID); await sleep(20); }
    process.env.BACKUP_RETENTION_COUNT = "2";
    const removed = await svc.applyRetention(ID);
    expect(removed).toHaveLength(2);
    expect(listZips("backup-")).toHaveLength(2);
    expect(fs.readdirSync(backupsDir()).filter((f) => f.endsWith(".sha256"))).toHaveLength(2);
  });

  it("retention is off by default (keeps everything)", async () => {
    for (let i = 0; i < 3; i++) { await svc.createBackupArchive(ID); await sleep(20); }
    expect(await svc.applyRetention(ID)).toEqual([]);
    expect(listZips("backup-")).toHaveLength(3);
  });
});

describe("restoring backups", () => {
  it("overwrites changed files, keeps new ones, and takes a recovery point of the data it replaced", async () => {
    const { filename } = await svc.createBackupArchive(ID);
    await fs.writeFile(path.join(serverDir(), "world", "level.dat"), "CORRUPTED-LATER");
    await fs.outputFile(path.join(serverDir(), "new.txt"), "added after backup");

    const res = await svc.restoreFromArchive(ID, filename, { truncate: false });

    expect(await fs.readFile(path.join(serverDir(), "world", "level.dat"), "utf8")).toBe("ORIGINAL-WORLD");
    expect(await fs.pathExists(path.join(serverDir(), "new.txt"))).toBe(true);
    expect(res.recoveryPoint).toMatch(/^pre-restore-.*\.zip$/);

    // The recovery point really contains the state that was overwritten.
    const probe = path.join(tmp, "probe"); await fs.ensureDir(probe);
    const { default: extract } = await import("../src/server/utils/safeZip");
    await extract(path.join(backupsDir(), res.recoveryPoint!), { dir: probe });
    expect(await fs.readFile(path.join(probe, "world", "level.dat"), "utf8")).toBe("CORRUPTED-LATER");
    expect(await fs.pathExists(path.join(probe, "new.txt"))).toBe(true);
  });

  it("truncate removes everything that is not in the backup", async () => {
    const { filename } = await svc.createBackupArchive(ID);
    await fs.outputFile(path.join(serverDir(), "new.txt"), "added after backup");
    await svc.restoreFromArchive(ID, filename, { truncate: true });
    expect(await fs.pathExists(path.join(serverDir(), "new.txt"))).toBe(false);
    expect(await fs.readFile(path.join(serverDir(), "server.properties"), "utf8")).toBe("motd=hello");
  });

  it("refuses a tampered archive and leaves live data and recovery points untouched", async () => {
    const { filename } = await svc.createBackupArchive(ID);
    const file = path.join(backupsDir(), filename);
    const buf = await fs.readFile(file); buf[buf.length >> 1] ^= 0xff; await fs.writeFile(file, buf);
    await fs.writeFile(path.join(serverDir(), "server.properties"), "motd=live-data");

    await expect(svc.restoreFromArchive(ID, filename, { truncate: true })).rejects.toMatchObject({ status: 422 });

    expect(await fs.readFile(path.join(serverDir(), "server.properties"), "utf8")).toBe("motd=live-data");
    expect(listZips("pre-restore-")).toHaveLength(0);
  });

  it("refuses a hostile archive (path traversal) before touching anything", async () => {
    await fs.outputFile(path.join(backupsDir(), "backup-evil.zip"), makeZip([{ name: "../../../escape.txt", data: "pwned" }]));
    await expect(svc.restoreFromArchive(ID, "backup-evil.zip", { truncate: false })).rejects.toMatchObject({ status: 422 });
    expect(await fs.pathExists(path.join(tmp, "escape.txt"))).toBe(false);
    expect(await fs.pathExists(path.join(tmp, ".data", "escape.txt"))).toBe(false);
  });

  it("rolls back automatically when extraction fails after the folder was wiped", async () => {
    // Passes verification (valid structure) but cannot be extracted: "a" is a file, then "a/b" needs "a" to be a directory.
    await fs.outputFile(path.join(backupsDir(), "backup-bad.zip"), makeZip([{ name: "a", data: "x" }, { name: "a/b", data: "y" }]));

    await expect(svc.restoreFromArchive(ID, "backup-bad.zip", { truncate: true })).rejects.toThrow(/restored automatically/);

    expect(await fs.readFile(path.join(serverDir(), "world", "level.dat"), "utf8")).toBe("ORIGINAL-WORLD");
    expect(await fs.readFile(path.join(serverDir(), "server.properties"), "utf8")).toBe("motd=hello");
    expect(await fs.pathExists(path.join(serverDir(), "a"))).toBe(false);
  });

  it("does not wipe anything when a recovery point cannot be made (no disk room)", async () => {
    const { filename } = await svc.createBackupArchive(ID);
    process.env.MIN_FREE_DISK_BYTES = String(10 ** 15);
    await expect(svc.restoreFromArchive(ID, filename, { truncate: true })).rejects.toMatchObject({ status: 507 });
    expect(await fs.readFile(path.join(serverDir(), "server.properties"), "utf8")).toBe("motd=hello");
  });

  it("keeps only the newest few recovery points", async () => {
    const { filename } = await svc.createBackupArchive(ID);
    for (let i = 0; i < 5; i++) { await svc.restoreFromArchive(ID, filename, { truncate: false }); await sleep(25); }
    expect(listZips("pre-restore-").length).toBeLessThanOrEqual(3);
    expect(listZips("pre-restore-").length).toBeGreaterThanOrEqual(1);
    process.env.RESTORE_RECOVERY_KEEP = "1";
    await svc.restoreFromArchive(ID, filename, { truncate: false });
    expect(listZips("pre-restore-")).toHaveLength(1);
  });

  it("restoring into an empty server directory needs no recovery point", async () => {
    const { filename } = await svc.createBackupArchive(ID);
    await fs.emptyDir(serverDir());
    const res = await svc.restoreFromArchive(ID, filename, { truncate: false });
    expect(res.recoveryPoint).toBeNull();
    expect(await fs.pathExists(path.join(serverDir(), "server.properties"))).toBe(true);
  });
});

describe("recovery after a restart", () => {
  it("marks interrupted installs as failed (so the UI is never stuck) and removes partial backups", async () => {
    await db.writeJSON("servers.json", [
      { id: "a", status: "installing" },
      { id: "b", status: "offline" },
    ]);
    await fs.outputFile(path.join(backupsDir(), "backup-x.zip.partial"), "junk");
    const r = await recovery.recoverInterruptedOperations();
    expect(r).toEqual({ installs: 1, partialBackups: 1 });
    const servers = await db.readJSON("servers.json");
    expect(servers[0].status).toBe("install_failed");
    expect(servers[0].installError).toMatch(/restart/i);
    expect(servers[1].status).toBe("offline");
    expect(fs.existsSync(path.join(backupsDir(), "backup-x.zip.partial"))).toBe(false);
  });

  it("does nothing when nothing was interrupted", async () => {
    await db.writeJSON("servers.json", [{ id: "b", status: "online" }]);
    expect(await recovery.recoverInterruptedOperations()).toEqual({ installs: 0, partialBackups: 0 });
  });
});
