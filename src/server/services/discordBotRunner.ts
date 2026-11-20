import { spawn, execFile, ChildProcess } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { readJSON, writeJSON } from "./db.js";
import { sealSecret, openSecret } from "../utils/security.js";

/**
 * Runs the Discord bot (discord-bot/index.js) as a child process of the panel, so the admin never
 * has to touch a terminal: saving the token in Admin -> API Keys -> Discord Bot is enough.
 *
 *  - installs the bot's npm dependencies by itself the first time
 *  - creates (and re-creates if needed) the internal API key the bot uses to talk to the panel
 *  - starts the bot when it is enabled + has a token, stops it otherwise
 *  - restarts it when it exits (settings changed, crash) with a back-off
 */

export type RunnerState = "stopped" | "installing" | "starting" | "running" | "error";

const FILE = "discord_bot.json";
const BOT_DIR = path.join(process.cwd(), "discord-bot");
const KEY_LABEL = "Discord Bot (auto)";
const MAX_LOG_LINES = 80;

let child: ChildProcess | null = null;
let state: RunnerState = "stopped";
let lastError = "";
let wanted = false;
let startedAt = 0;
let backoffMs = 2000;
let retryTimer: NodeJS.Timeout | null = null;
let chain: Promise<unknown> = Promise.resolve();
const logs: string[] = [];

// Never let a Discord token (or panel key) reach the browser through the log view.
const MASK_RE = /[\w-]{15,}\.[\w-]{4,}\.[\w-]{20,}|xynex[-_][\w-]{20,}/g;
function pushLog(chunk: string) {
  for (const raw of chunk.split(/\r?\n/)) {
    const line = raw.replace(MASK_RE, "[hidden]").trimEnd();
    if (!line) continue;
    logs.push(line.slice(0, 400));
    if (logs.length > MAX_LOG_LINES) logs.shift();
  }
}

export function getRunnerInfo() {
  return { state, error: lastError, logs: logs.slice(-40), pid: child?.pid ?? null };
}

const serialize = <T>(job: () => Promise<T>): Promise<T> => {
  const next = chain.catch(() => undefined).then(job);
  chain = next;
  return next;
};

const depsInstalled = () => fs.existsSync(path.join(BOT_DIR, "node_modules", "discord.js", "package.json"));

/** The API key the bot uses. Valid = stored, hash still in api_keys.json, not revoked/expired, creator still exists. */
async function keyIsValid(key: string): Promise<boolean> {
  const hash = crypto.createHash("sha256").update(key).digest("hex");
  const keys = ((await readJSON("api_keys.json")) as any[]) || [];
  const k = keys.find((x) => x.key_hash === hash);
  if (!k || k.revoked) return false;
  if (k.expires_at && new Date(k.expires_at) < new Date()) return false;
  if (!Array.isArray(k.scopes) || !(k.scopes.includes("*") || k.scopes.includes("write"))) return false;
  if (k.created_by === "temp-admin") return true;
  const users = ((await readJSON("users.json")) as any[]) || [];
  return users.some((u) => u.id === k.created_by && (u.role === "admin" || u.role === "owner"));
}

/** Returns a working bot key, creating one if needed. Mutates `cfg` (caller writes it). */
export async function ensureBotKey(cfg: any, creatorId: string | null): Promise<string | null> {
  if (cfg.botKeySealed) {
    try {
      const existing = openSecret(cfg.botKeySealed);
      if (await keyIsValid(existing)) return existing;
    } catch { /* unreadable -> make a new one */ }
  }
  let creator = creatorId;
  if (!creator) {
    const users = ((await readJSON("users.json")) as any[]) || [];
    creator = (users.find((u) => u.role === "owner") || users.find((u) => u.role === "admin"))?.id ?? null;
  }
  if (!creator) return null;

  const key = `xynex-${crypto.randomBytes(24).toString("base64url")}`;
  const keys = ((await readJSON("api_keys.json")) as any[]) || [];
  // drop stale auto keys so the list stays clean
  const kept = keys.filter((k) => k.label !== KEY_LABEL);
  kept.push({
    id: crypto.randomUUID(),
    key_hash: crypto.createHash("sha256").update(key).digest("hex"),
    label: KEY_LABEL,
    scopes: ["*"],
    created_by: creator,
    created_at: new Date().toISOString(),
    expires_at: null,
    last_used_at: null,
    revoked: false,
  });
  await writeJSON("api_keys.json", kept);
  cfg.botKeySealed = sealSecret(key);
  return key;
}

function runNpmInstall(): Promise<void> {
  return new Promise((resolve, reject) => {
    pushLog("[panel] Installing Discord bot files (first time only, ~1 minute)...");
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const p = spawn(npm, ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: BOT_DIR, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => { p.kill("SIGKILL"); }, 5 * 60_000);
    p.stdout?.on("data", (d) => pushLog(String(d)));
    p.stderr?.on("data", (d) => pushLog(String(d)));
    p.on("error", (e) => { clearTimeout(timer); reject(new Error(`npm could not run: ${e.message}`)); });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && depsInstalled()) resolve();
      else reject(new Error(`npm install failed (exit ${code}). Check that the server has internet access.`));
    });
  });
}

function killChild(): Promise<void> {
  return new Promise((resolve) => {
    const c = child;
    child = null; // detach first so the exit handler knows this stop was intentional
    if (!c || c.exitCode !== null) return resolve();
    const force = setTimeout(() => { try { c.kill("SIGKILL"); } catch { /* gone */ } }, 3000);
    c.once("exit", () => { clearTimeout(force); resolve(); });
    try { c.kill("SIGTERM"); } catch { clearTimeout(force); resolve(); }
  });
}

function clearRetry() { if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; } }

function scheduleRetry(ms: number) {
  clearRetry();
  retryTimer = setTimeout(() => { retryTimer = null; if (wanted) void reconcile(); }, ms);
  retryTimer.unref();
}

async function startChild(key: string) {
  // The bot fetches its Discord token from the panel itself; it is never put in env or argv.
  const port = process.env.PORT || "6767";
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    NODE_ENV: process.env.NODE_ENV,
    PANEL_URL: `http://127.0.0.1:${port}`,
    PANEL_API_KEY: key,
    XYNEX_MANAGED: "1",
  };
  state = "starting";
  startedAt = Date.now();
  const c = spawn(process.execPath, ["index.js"], { cwd: BOT_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
  child = c;
  pushLog(`[panel] Bot process started (pid ${c.pid}).`);
  c.stdout?.on("data", (d) => pushLog(String(d)));
  c.stderr?.on("data", (d) => pushLog(String(d)));
  c.on("error", (e) => { lastError = `Could not start the bot: ${e.message}`; });
  c.on("exit", (code, signal) => {
    if (child !== c) return; // an older process we already replaced
    child = null;
    const ranFor = Date.now() - startedAt;
    pushLog(`[panel] Bot process exited (${signal || `code ${code}`}).`);
    if (!wanted) { state = "stopped"; return; }
    if (ranFor > 30_000) backoffMs = 2000;
    if (code === 0) { // the bot restarts itself on purpose when settings change
      state = "starting";
      scheduleRetry(500);
    } else {
      state = "error";
      lastError = lastError || `Bot stopped unexpectedly (${signal || `exit code ${code}`}). Retrying...`;
      scheduleRetry(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 60_000);
    }
  });
}

/** Make reality match the saved settings: run the bot if enabled + token saved, otherwise stop it. */
export function reconcile(creatorId: string | null = null): Promise<void> {
  return serialize(async () => {
    clearRetry();
    const cfg = ((await readJSON(FILE)) as any) || {};
    const shouldRun = cfg.enabled !== false && !!cfg.tokenSealed;
    if (!shouldRun) {
      wanted = false;
      await killChild();
      state = "stopped";
      lastError = "";
      return;
    }
    wanted = true;
    if (child && child.exitCode === null) return; // already running with current settings

    try {
      if (!fs.existsSync(path.join(BOT_DIR, "index.js"))) throw new Error("discord-bot/index.js is missing from the panel folder.");
      if (!depsInstalled()) { state = "installing"; lastError = ""; await runNpmInstall(); }
      const before = cfg.botKeySealed;
      const key = await ensureBotKey(cfg, creatorId);
      if (!key) throw new Error("No admin account found to attach the bot's API key to.");
      if (cfg.botKeySealed !== before) {
        // re-read so we don't clobber settings saved while we were installing
        const fresh = ((await readJSON(FILE)) as any) || {};
        fresh.botKeySealed = cfg.botKeySealed;
        await writeJSON(FILE, fresh);
      }
      lastError = "";
      await startChild(key);
    } catch (err: any) {
      state = "error";
      lastError = String(err?.message || err).slice(0, 300);
      pushLog(`[panel] ${lastError}`);
      scheduleRetry(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 60_000);
    }
  });
}

/** Restart now (used by "Restart bot" and after settings are saved). */
export function restartBot(creatorId: string | null = null): Promise<void> {
  backoffMs = 2000;
  return serialize(async () => { clearRetry(); await killChild(); }).then(() => reconcile(creatorId));
}

export async function stopBot(): Promise<void> {
  wanted = false;
  clearRetry();
  await serialize(() => killChild());
  state = "stopped";
}

/** The bot reported in (heartbeat) -> it is up. */
export function markBotAlive() {
  if (child && child.exitCode === null && state !== "installing") { state = "running"; lastError = ""; backoffMs = 2000; }
}

/** Called once from server.ts on boot. */
export function startDiscordBotRunner() {
  void reconcile().catch((e) => console.error("[discord-bot] runner failed:", e?.message || e));
}

/** An old PM2-managed copy of the bot (from setup.sh) would answer every command twice. */
let pm2Cleaned = false;
export function removeLegacyPm2Bot() {
  if (pm2Cleaned) return;
  pm2Cleaned = true;
  execFile("pm2", ["delete", "xynex-bot"], { timeout: 15_000 }, (err) => {
    if (!err) { pushLog("[panel] Stopped the old PM2 copy of the bot (xynex-bot); the panel runs the bot now."); void execFile("pm2", ["save"], () => undefined); }
  });
}
