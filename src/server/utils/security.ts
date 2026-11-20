import crypto from "crypto";
import fs from "fs";
import path from "path";
import jwt from "jsonwebtoken";

/** bcrypt work factor for newly created hashes (existing hashes keep verifying at their own cost). */
export const BCRYPT_ROUNDS = 12;

/* ── JWT secret ─────────────────────────────────────────────────────────────
   Never fall back to a hardcoded/guessable secret. If JWT_SECRET isn't set in
   the environment, a strong random one is generated once and persisted in
   .data/jwt.secret (mode 0600) so sessions survive restarts. */
let cachedSecret: string | null = null;
export function getJwtSecret(): string {
  if (cachedSecret) return cachedSecret;
  const envSecret = process.env.JWT_SECRET;
  if (envSecret && envSecret.length >= 16) {
    cachedSecret = envSecret;
    return cachedSecret;
  }
  const dataDir = path.join(process.cwd(), ".data");
  const file = path.join(dataDir, "jwt.secret");
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(file)) {
      const existing = fs.readFileSync(file, "utf8").trim();
      if (existing.length >= 32) { cachedSecret = existing; return cachedSecret; }
    }
    const generated = crypto.randomBytes(64).toString("hex");
    fs.writeFileSync(file, generated, { mode: 0o600 });
    cachedSecret = generated;
    console.warn("[SECURITY] JWT_SECRET not set (or too short) - generated a random one in .data/jwt.secret");
    return cachedSecret;
  } catch {
    // Last resort: random per-process secret (sessions reset on restart, but never guessable)
    cachedSecret = crypto.randomBytes(64).toString("hex");
    return cachedSecret;
  }
}

/** Verifies a *session* token only. Pre-auth (2FA stage) tokens, Discord OAuth
 *  state tokens, etc. share the same signing key but must never act as sessions. */
export function verifySessionToken(token: string): any {
  const decoded = jwt.verify(token, getJwtSecret(), { algorithms: ["HS256"] }) as any;
  if (!decoded || typeof decoded !== "object" || decoded.stage || decoded.purpose || !decoded.id) {
    throw new Error("Not a session token");
  }
  return decoded;
}

/* ── Safe path resolution ───────────────────────────────────────────────────
   The old `target.startsWith(base)` check let "<base>-other" siblings through
   and ignored symlinks. This resolves inside `base` only, using path.relative
   plus a realpath check on the deepest existing ancestor. */
/** True when a path.relative() result leaves its base: exactly "..", starts with "../" (or "..\\" on
 *  Windows), or is absolute. A bare textual prefix test (`startsWith("..")`) also rejected valid
 *  file names such as "..hidden" or "...". */
function escapesBase(rel: string): boolean {
  return rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
}

export function safeResolve(base: string, ...parts: string[]): string | null {
  const baseResolved = path.resolve(base);
  const target = path.resolve(baseResolved, ...parts.map((p) => String(p ?? "").replace(/^[/\\]+/, "")));
  const rel = path.relative(baseResolved, target);
  if (escapesBase(rel)) return null;
  if (String(parts.join("")).includes("\0")) return null;

  // Symlink escape: resolve the deepest existing ancestor and re-check.
  try {
    let probe = target;
    while (!fs.existsSync(probe) && probe !== baseResolved) probe = path.dirname(probe);
    if (fs.existsSync(probe)) {
      const realProbe = fs.realpathSync(probe);
      const realBase = fs.existsSync(baseResolved) ? fs.realpathSync(baseResolved) : baseResolved;
      const relReal = path.relative(realBase, realProbe);
      if (escapesBase(relReal)) return null;
    }
  } catch {
    return null;
  }
  return target;
}

export const SERVER_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
export function isValidServerId(id: unknown): id is string {
  return typeof id === "string" && SERVER_ID_RE.test(id);
}

/** Directory that holds one server's files. The id is validated here so a hostile id can never
 *  become part of a filesystem path (this replaces ~30 copies of the same path.join). */
export function serverRoot(id: string): string {
  if (!isValidServerId(id)) throw new Error("Invalid server id");
  return path.join(process.cwd(), ".data", "servers", id);
}

/** Joins a user-supplied (relative or "/"-rooted) path onto `root` and returns it only if it stays
 *  inside `root` (no "..", NUL bytes, absolute escapes or symlink escapes). Non-strings are rejected. */
export function resolveUserPath(root: string, userPath: unknown): string | null {
  if (typeof userPath !== "string" || userPath.includes("\0")) return null;
  const target = path.join(root, userPath);
  return isInside(root, target) ? target : null;
}

/** True only if `target` is `base` itself or strictly inside it (no sibling-prefix tricks,
 *  no `..`, and no symlink pointing outside of base). */
export function isInside(base: string, target: string): boolean {
  if (String(base).includes("\0") || String(target).includes("\0")) return false;
  const b = path.resolve(base);
  const t = path.resolve(target);
  const rel = path.relative(b, t);
  if (escapesBase(rel)) return false;
  try {
    let probe = t;
    while (!fs.existsSync(probe) && probe !== b && probe !== path.dirname(probe)) probe = path.dirname(probe);
    if (fs.existsSync(probe) && fs.existsSync(b)) {
      const relReal = path.relative(fs.realpathSync(b), fs.realpathSync(probe));
      if (escapesBase(relReal)) return false;
    }
  } catch {
    return false;
  }
  return true;
}

/* ── SSRF guard ─────────────────────────────────────────────────────────────
   Only allows http(s) URLs whose host resolves to a public address, so a user
   can't make the panel fetch internal services (127.0.0.1, 169.254.169.254
   cloud metadata, docker socket proxies, LAN hosts, ...). */
import dns from "dns/promises";
import net from "net";

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l.startsWith("::ffff:")) return isPrivateIp(l.slice(7));
    return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80");
  }
  return true;
}

export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("Invalid URL"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Only http(s) URLs are allowed");
  if (u.username || u.password) throw new Error("Credentials in URLs are not allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error("URL points to a private or internal address");
  return u;
}


/* ── Secrets at rest (2FA seeds) ────────────────────────────────────────────
   AES-256-GCM with a dedicated key in .data/secret.key (0600). It is deliberately NOT derived from the
   JWT secret, so rotating JWT_SECRET cannot lock 2FA users out. Stored form: "enc:v1:<iv>:<tag>:<data>".
   Values without that prefix are legacy plaintext and are still readable (and get re-sealed on use). */
let cachedBoxKey: Buffer | null = null;
let cachedBoxDir = "";
function boxKey(): Buffer {
  const dir = path.join(process.cwd(), ".data");
  if (cachedBoxKey && cachedBoxDir === dir) return cachedBoxKey;
  const file = path.join(dir, "secret.key");
  fs.mkdirSync(dir, { recursive: true });
  let key: Buffer;
  if (fs.existsSync(file) && fs.readFileSync(file).length === 32) key = fs.readFileSync(file);
  else { key = crypto.randomBytes(32); fs.writeFileSync(file, key, { mode: 0o600 }); }
  cachedBoxKey = key; cachedBoxDir = dir;
  return key;
}
export const isSealed = (v: unknown): boolean => typeof v === "string" && v.startsWith("enc:v1:");
export function sealSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", boxKey(), iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `enc:v1:${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${data.toString("base64")}`;
}
export function openSecret(stored: string): string {
  if (!isSealed(stored)) return stored; // legacy plaintext
  const [, , iv, tag, data] = stored.split(":");
  const d = crypto.createDecipheriv("aes-256-gcm", boxKey(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
}
