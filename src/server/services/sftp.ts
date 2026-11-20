import ssh2 from "ssh2";
import type { Connection } from "ssh2";
import crypto from "crypto";
import fs from "fs-extra";
import { promises as fsp, constants as C } from "fs";
import path from "path";
import bcrypt from "bcryptjs";
import { AttemptThrottle } from "../middleware/rateLimit.js";
import { BCRYPT_ROUNDS, isInside, resolveUserPath, isValidServerId } from "../utils/security.js";
import { readJSON, writeJSON } from "./db.js";

const { Server, utils } = ssh2;
const STATUS = utils.sftp.STATUS_CODE;

const SFTP_DB_FILE = "sftp_users.json";
const MAX_HANDLES_PER_SESSION = 64;
const MAX_READ_BYTES = 256 * 1024;
const MAX_CONNECTIONS = 50;

// SFTP is exposed directly on its own port (not behind the HTTP rate limiters), so it needs its own
// brute-force protection: failures per client address and per account name.
export const sftpIpAttempts = new AttemptThrottle({ max: 20, windowMs: 15 * 60 * 1000 });
export const sftpUserAttempts = new AttemptThrottle({ max: 10, windowMs: 15 * 60 * 1000 });
// Burned when the username is unknown so the response time does not reveal which usernames exist.
const DUMMY_HASH = bcrypt.hashSync("xynex-dummy-password", 4);

const dataDir = () => path.join(process.cwd(), ".data");

async function ensureHostKey(): Promise<Buffer> {
  const dir = path.join(dataDir(), "ssh");
  await fs.ensureDir(dir);
  const hostKeyPath = path.join(dir, "host_rsa");
  if (!fs.existsSync(hostKeyPath)) {
    const { privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 3072,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
    });
    fs.writeFileSync(hostKeyPath, privateKey, { mode: 0o600 });
  }
  await fsp.chmod(hostKeyPath, 0o600).catch(() => undefined); // tighten keys created by older versions
  return fs.readFileSync(hostKeyPath);
}

function statusFor(err: any): number {
  switch (err?.code) {
    case "ENOENT": case "ENOTDIR": return STATUS.NO_SUCH_FILE;
    case "EACCES": case "EPERM": case "EROFS": return STATUS.PERMISSION_DENIED;
    default: return STATUS.FAILURE;
  }
}

function attrsOf(st: fs.Stats) {
  return { mode: st.mode, uid: st.uid, gid: st.gid, size: st.size, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) };
}

function longName(name: string, st: fs.Stats): string {
  const t = st.isDirectory() ? "d" : st.isSymbolicLink() ? "l" : "-";
  const bits = "rwxrwxrwx";
  let perm = "";
  for (let i = 0; i < 9; i++) perm += st.mode & (1 << (8 - i)) ? bits[i] : "-";
  const d = new Date(st.mtimeMs);
  const mon = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  return `${t}${perm} 1 panel panel ${String(st.size).padStart(10)} ${mon} ${String(d.getUTCDate()).padStart(2)} ${String(d.getUTCFullYear())} ${name}`;
}

/** ssh2's fopen mode string -> numeric flags, always with O_NOFOLLOW: if the final path component is swapped for a
 *  symlink between the containment check and open(), the open fails (ELOOP) instead of following it out of the jail. */
function openFlags(mode: string): number | null {
  const base: Record<string, number> = {
    r: C.O_RDONLY, "r+": C.O_RDWR,
    w: C.O_WRONLY | C.O_CREAT | C.O_TRUNC, "w+": C.O_RDWR | C.O_CREAT | C.O_TRUNC,
    a: C.O_WRONLY | C.O_CREAT | C.O_APPEND, "a+": C.O_RDWR | C.O_CREAT | C.O_APPEND,
    wx: C.O_WRONLY | C.O_CREAT | C.O_EXCL, "wx+": C.O_RDWR | C.O_CREAT | C.O_EXCL,
    ax: C.O_WRONLY | C.O_CREAT | C.O_APPEND | C.O_EXCL, "ax+": C.O_RDWR | C.O_CREAT | C.O_APPEND | C.O_EXCL,
  };
  return mode in base ? base[mode] | C.O_NOFOLLOW : null;
}

type Handle = { kind: "file"; fh: fsp.FileHandle } | { kind: "dir"; real: string; names: string[]; sent: boolean };

/** Serves ONE server's folder over SFTP. Every client path goes through resolveUserPath (join onto the
 *  server root, reject `..`, NUL bytes and symlink escapes), so the client can never leave its folder.
 *  Symlink creation/readlink are refused, and rename never overwrites (SFTP v3 semantics). */
function serveSftp(sftp: any, root: string) {
  const handles = new Map<string, Handle>();
  let counter = 0;
  const real = (p: unknown) => resolveUserPath(root, typeof p === "string" ? p : "");
  const isRoot = (r: string) => path.resolve(r) === path.resolve(root);
  const deny = (reqid: number) => sftp.status(reqid, STATUS.PERMISSION_DENIED);
  const fail = (reqid: number, err: any) => sftp.status(reqid, statusFor(err));
  const newHandle = (h: Handle): Buffer | null => {
    if (handles.size >= MAX_HANDLES_PER_SESSION) return null;
    const id = Buffer.alloc(4);
    id.writeUInt32BE(++counter);
    handles.set(id.toString("hex"), h);
    return id;
  };
  const getHandle = (h: Buffer) => handles.get(Buffer.from(h).toString("hex"));

  sftp.on("REALPATH", (reqid: number, p: string) => {
    const virtual = path.posix.resolve("/", String(p).replace(/\\/g, "/"));
    if (!real(virtual)) return deny(reqid);
    sftp.name(reqid, [{ filename: virtual, longname: virtual, attrs: {} }]);
  });

  const statLike = (follow: boolean) => async (reqid: number, p: string) => {
    const r = real(p); if (!r) return deny(reqid);
    try { sftp.attrs(reqid, attrsOf(follow ? await fsp.stat(r) : await fsp.lstat(r))); } catch (e) { fail(reqid, e); }
  };
  sftp.on("STAT", statLike(true));
  sftp.on("LSTAT", statLike(false));

  sftp.on("FSTAT", async (reqid: number, h: Buffer) => {
    const hd = getHandle(h);
    if (!hd || hd.kind !== "file") return sftp.status(reqid, STATUS.FAILURE);
    try { sftp.attrs(reqid, attrsOf(await hd.fh.stat())); } catch (e) { fail(reqid, e); }
  });

  sftp.on("OPEN", async (reqid: number, filename: string, flags: number, attrs: any) => {
    const r = real(filename); if (!r || isRoot(r)) return deny(reqid);
    const modeStr = utils.sftp.flagsToString(flags);
    const mode = modeStr ? openFlags(modeStr) : null;
    if (mode === null) return sftp.status(reqid, STATUS.FAILURE);
    try {
      const existing = await fsp.stat(r).catch(() => null);
      if (existing?.isDirectory()) return sftp.status(reqid, STATUS.FAILURE);
      const fh = await fsp.open(r, mode, (attrs?.mode ?? 0o644) & 0o666);
      const id = newHandle({ kind: "file", fh });
      if (!id) { await fh.close(); return sftp.status(reqid, STATUS.FAILURE); }
      sftp.handle(reqid, id);
    } catch (e) { fail(reqid, e); }
  });

  sftp.on("READ", async (reqid: number, h: Buffer, offset: number, length: number) => {
    const hd = getHandle(h);
    if (!hd || hd.kind !== "file") return sftp.status(reqid, STATUS.FAILURE);
    try {
      const buf = Buffer.alloc(Math.min(length, MAX_READ_BYTES));
      const { bytesRead } = await hd.fh.read(buf, 0, buf.length, offset);
      if (bytesRead === 0) return sftp.status(reqid, STATUS.EOF);
      sftp.data(reqid, buf.subarray(0, bytesRead));
    } catch (e) { fail(reqid, e); }
  });

  sftp.on("WRITE", async (reqid: number, h: Buffer, offset: number, data: Buffer) => {
    const hd = getHandle(h);
    if (!hd || hd.kind !== "file") return sftp.status(reqid, STATUS.FAILURE);
    try { await hd.fh.write(data, 0, data.length, offset); sftp.status(reqid, STATUS.OK); } catch (e) { fail(reqid, e); }
  });

  sftp.on("CLOSE", async (reqid: number, h: Buffer) => {
    const key = Buffer.from(h).toString("hex");
    const hd = handles.get(key);
    if (!hd) return sftp.status(reqid, STATUS.FAILURE);
    handles.delete(key);
    try { if (hd.kind === "file") await hd.fh.close(); sftp.status(reqid, STATUS.OK); } catch (e) { fail(reqid, e); }
  });

  sftp.on("OPENDIR", async (reqid: number, p: string) => {
    const r = real(p); if (!r) return deny(reqid);
    try {
      const st = await fsp.stat(r);
      if (!st.isDirectory()) return sftp.status(reqid, STATUS.FAILURE);
      const names = await fsp.readdir(r);
      const id = newHandle({ kind: "dir", real: r, names, sent: false });
      if (!id) return sftp.status(reqid, STATUS.FAILURE);
      sftp.handle(reqid, id);
    } catch (e) { fail(reqid, e); }
  });

  sftp.on("READDIR", async (reqid: number, h: Buffer) => {
    const hd = getHandle(h);
    if (!hd || hd.kind !== "dir") return sftp.status(reqid, STATUS.FAILURE);
    if (hd.sent) return sftp.status(reqid, STATUS.EOF);
    hd.sent = true;
    const out: { filename: string; longname: string; attrs: any }[] = [];
    for (const name of hd.names) {
      const full = path.join(hd.real, name);
      // Entries that are symlinks leading outside the server folder are not listed.
      if (!isInside(root, full)) continue;
      try { const st = await fsp.lstat(full); out.push({ filename: name, longname: longName(name, st), attrs: attrsOf(st) }); } catch { /* vanished */ }
    }
    if (!out.length) return sftp.status(reqid, STATUS.EOF);
    sftp.name(reqid, out);
  });

  sftp.on("MKDIR", async (reqid: number, p: string, attrs: any) => {
    const r = real(p); if (!r || isRoot(r)) return deny(reqid);
    try { await fsp.mkdir(r, (attrs?.mode ?? 0o755) & 0o777); sftp.status(reqid, STATUS.OK); } catch (e) { fail(reqid, e); }
  });

  sftp.on("RMDIR", async (reqid: number, p: string) => {
    const r = real(p); if (!r || isRoot(r)) return deny(reqid);
    try { await fsp.rmdir(r); sftp.status(reqid, STATUS.OK); } catch (e) { fail(reqid, e); }
  });

  sftp.on("REMOVE", async (reqid: number, p: string) => {
    const r = real(p); if (!r || isRoot(r)) return deny(reqid);
    try {
      if ((await fsp.lstat(r)).isDirectory()) return sftp.status(reqid, STATUS.FAILURE);
      await fsp.unlink(r); sftp.status(reqid, STATUS.OK);
    } catch (e) { fail(reqid, e); }
  });

  sftp.on("RENAME", async (reqid: number, from: string, to: string) => {
    const a = real(from), b = real(to);
    if (!a || !b || isRoot(a) || isRoot(b)) return deny(reqid);
    try {
      if (await fsp.lstat(b).then(() => true, () => false)) return sftp.status(reqid, STATUS.FAILURE); // never overwrite
      await fsp.rename(a, b); sftp.status(reqid, STATUS.OK);
    } catch (e) { fail(reqid, e); }
  });

  const setattr = async (reqid: number, target: string | Handle | undefined, attrs: any) => {
    try {
      let p: string | undefined; let fh: fsp.FileHandle | undefined;
      if (typeof target === "string") p = target; else if (target && target.kind === "file") fh = target.fh; else return sftp.status(reqid, STATUS.FAILURE);
      if (attrs && typeof attrs.mode === "number") { const m = attrs.mode & 0o777; if (fh) await fh.chmod(m); else await fsp.chmod(p!, m); } // never setuid/setgid/sticky
      if (attrs && typeof attrs.atime === "number" && typeof attrs.mtime === "number") { if (fh) await fh.utimes(attrs.atime, attrs.mtime); else await fsp.utimes(p!, attrs.atime, attrs.mtime); }
      sftp.status(reqid, STATUS.OK);
    } catch (e) { fail(reqid, e); }
  };
  sftp.on("SETSTAT", (reqid: number, p: string, attrs: any) => { const r = real(p); if (!r || isRoot(r)) return deny(reqid); void setattr(reqid, r, attrs); });
  sftp.on("FSETSTAT", (reqid: number, h: Buffer, attrs: any) => void setattr(reqid, getHandle(h), attrs));

  // A symlink created here could point anywhere; there is no safe use for them in a per-server jail.
  sftp.on("SYMLINK", (reqid: number) => deny(reqid));
  sftp.on("READLINK", (reqid: number) => deny(reqid));

  const closeAll = () => { for (const h of handles.values()) if (h.kind === "file") h.fh.close().catch(() => undefined); handles.clear(); };
  sftp.on("end", closeAll);
  sftp.on("close", closeAll);
}

/** Builds (but does not start listening on) the SFTP server. Exported so tests can bind a free port. */
export async function createSftpServer() {
  const hostKey = await ensureHostKey();
  const clients = new Set<Connection>();

  const server = new Server({ hostKeys: [hostKey] }, (client: Connection, info: { ip?: string }) => {
    clients.add(client);
    const ip = info?.ip || "unknown";
    let sftpUser: any = null;
    let failures = 0;

    client.on("authentication", async (ctx: any) => {
      if (ctx.method !== "password") return ctx.reject(["password"]); // includes the initial "none" probe
      const ipKey = `ip:${ip}`;
      const userKey = `user:${String(ctx.username).toLowerCase().slice(0, 64)}`;
      const blocked = sftpIpAttempts.check(ipKey).blocked || sftpUserAttempts.check(userKey).blocked;
      const failAuth = () => {
        sftpIpAttempts.fail(ipKey); sftpUserAttempts.fail(userKey);
        if (++failures >= 3) client.end(); // no unlimited guesses on one connection
        ctx.reject(["password"]);
      };
      try {
        const users = (await readJSON(SFTP_DB_FILE)) || [];
        const user = users.find((u: any) => u.username === ctx.username);
        // Always spend a bcrypt comparison, even when throttled or the user is unknown.
        const ok = await bcrypt.compare(String(ctx.password ?? ""), user?.passwordHash || DUMMY_HASH);
        if (blocked || !user || !ok || !isValidServerId(user.serverId)) return failAuth();
        const servers = (await readJSON("servers.json")) || [];
        if (!servers.some((s: any) => s.id === user.serverId)) return failAuth();
        sftpUserAttempts.reset(userKey);
        sftpUser = user;
        ctx.accept();
      } catch (err) {
        console.error("SFTP auth error:", err);
        ctx.reject(["password"]);
      }
    });

    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        // Only the sftp subsystem is served: no shell, no exec (ssh2 refuses requests with no handler).
        session.on("sftp", (acceptSftp) => {
          if (!sftpUser) return;
          const root = path.join(dataDir(), "servers", sftpUser.serverId);
          fs.ensureDirSync(root);
          serveSftp(acceptSftp(), root);
        });
      });
    });

    client.on("error", () => { /* client disconnects / protocol errors */ });
    client.on("close", () => { clients.delete(client); });
  });
  server.maxConnections = MAX_CONNECTIONS;

  const stop = () => new Promise<void>((resolve) => {
    for (const c of clients) c.end();
    server.close(() => resolve());
    setTimeout(resolve, 2000).unref();
  });
  return { server, stop };
}

let running: { stop: () => Promise<void> } | null = null;

export async function initSFTPServer() {
  if (running) return;
  const port = Number(process.env.SFTP_PORT) || 6868;
  const host = process.env.SFTP_HOST || "0.0.0.0";
  if (!fs.existsSync(path.join(dataDir(), SFTP_DB_FILE))) await writeJSON(SFTP_DB_FILE, []);
  const { server, stop } = await createSftpServer();
  server.on("error", (err: any) => console.error(`SFTP server error (port ${port}):`, err?.message || err));
  await new Promise<void>((resolve) => server.listen(port, host, () => { console.log(`SFTP server listening on ${host}:${port}`); resolve(); }));
  running = { stop };
}

/** Stops the SFTP listener and drops open sessions (called from the panel's shutdown path). */
export async function stopSFTPServer() {
  const r = running; running = null;
  if (r) await r.stop();
}

export async function createSftpUser(serverId: string) {
  const users = await readJSON(SFTP_DB_FILE) || [];
  
  if (users.find((u: any) => u.serverId === serverId)) {
    throw new Error("SFTP user already exists for this server");
  }

  const username = "srv_" + crypto.randomBytes(3).toString("hex");
  const password = crypto.randomBytes(8).toString("hex") + "!";
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const newUser = {
    id: crypto.randomUUID(),
    serverId,
    username,
    passwordHash,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  users.push(newUser);
  await writeJSON(SFTP_DB_FILE, users);

  return { username, password };
}

export async function resetSftpPassword(serverId: string) {
  const users = await readJSON(SFTP_DB_FILE) || [];
  const userIndex = users.findIndex((u: any) => u.serverId === serverId);
  
  if (userIndex === -1) {
    throw new Error("SFTP user not found");
  }

  const password = crypto.randomBytes(8).toString("hex") + "!";
  users[userIndex].passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  users[userIndex].updatedAt = new Date().toISOString();

  await writeJSON(SFTP_DB_FILE, users);

  return { username: users[userIndex].username, password };
}

export async function getSftpUser(serverId: string) {
  const users = await readJSON(SFTP_DB_FILE) || [];
  return users.find((u: any) => u.serverId === serverId);
}

export async function deleteSftpUser(serverId: string) {
  const users = await readJSON(SFTP_DB_FILE) || [];
  const filtered = users.filter((u: any) => u.serverId !== serverId);
  await writeJSON(SFTP_DB_FILE, filtered);
}
