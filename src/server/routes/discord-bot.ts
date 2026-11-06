import express from "express";
import { requireAdmin } from "../middleware/auth.js";
import { readJSON, writeJSON } from "../services/db.js";
import { sealSecret, openSecret } from "../utils/security.js";

/**
 * Settings for the XyneX Discord bot (discord-bot/ folder).
 *  - Admin UI (API Keys tab -> Discord Bot) reads/writes them with a normal login session.
 *  - The bot itself pulls them with its API key (GET /bot-config) and reports a heartbeat.
 * The Discord token is stored encrypted and is NEVER sent back to the browser.
 */
const router = express.Router();
router.use(requireAdmin);

const FILE = "discord_bot.json";
const ID_RE = /^\d{5,25}$/;
const TOKEN_RE = /^[\w-]{15,}\.[\w-]{4,}\.[\w-]{20,}$/;
const MAX_IDS = 100;

const uiOnly: express.RequestHandler = (req, res, next) => {
  if ((req as any).user?.isApiKey) return res.status(403).json({ error: "Use a login session for this endpoint" });
  next();
};
const botOnly: express.RequestHandler = (req, res, next) => {
  if (!(req as any).user?.isApiKey) return res.status(403).json({ error: "This endpoint is for the bot's API key only" });
  next();
};

type BotStatus = { state: string; tag: string | null; guilds: number; error: string | null; lastSeen: number };
let status: BotStatus = { state: "offline", tag: null, guilds: 0, error: null, lastSeen: 0 };

const load = async () => ((await readJSON(FILE)) as any) || {};
const idList = (v: unknown): string[] =>
  (Array.isArray(v) ? v : String(v ?? "").split(/[\s,]+/)).map((s) => String(s).trim()).filter(Boolean);
const clean = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max);

/** The first token segment is the bot's user id (= application id) in base64. */
const clientIdFromToken = (token: string) => {
  try { const id = Buffer.from(token.split(".")[0], "base64").toString("utf8"); return ID_RE.test(id) ? id : ""; } catch { return ""; }
};

function publicView(c: any) {
  const now = Date.now();
  const alive = status.lastSeen && now - status.lastSeen < 90_000;
  let tokenHint = "";
  if (c.tokenSealed) { try { tokenHint = openSecret(c.tokenSealed).slice(-4); } catch { /* unreadable */ } }
  return {
    enabled: c.enabled !== false,
    tokenSet: !!c.tokenSealed,
    tokenHint,
    clientId: c.clientId || "",
    guildId: c.guildId || "",
    allowedUserIds: c.allowedUserIds || [],
    allowedRoleIds: c.allowedRoleIds || [],
    adminUserIds: c.adminUserIds || [],
    adminRoleIds: c.adminRoleIds || [],
    notifyChannelId: c.notifyChannelId || "",
    logChannelId: c.logChannelId || "",
    rev: c.rev || 0,
    status: {
      state: alive ? status.state : "offline",
      tag: alive ? status.tag : null,
      guilds: alive ? status.guilds : 0,
      error: alive ? status.error : null,
      lastSeenSecondsAgo: status.lastSeen ? Math.round((now - status.lastSeen) / 1000) : null,
    },
  };
}

// ---------- Admin UI ----------
router.get("/", uiOnly, async (_req, res) => {
  res.json(publicView(await load()));
});

router.put("/", uiOnly, async (req, res) => {
  const b = req.body || {};
  const c = await load();

  for (const k of ["clientId", "guildId", "notifyChannelId", "logChannelId"] as const) {
    if (b[k] === undefined) continue;
    const v = clean(b[k], 25);
    if (v && !ID_RE.test(v)) return res.status(400).json({ error: `${k} must be a Discord ID (digits only)` });
    c[k] = v;
  }
  for (const k of ["allowedUserIds", "allowedRoleIds", "adminUserIds", "adminRoleIds"] as const) {
    if (b[k] === undefined) continue;
    const list = idList(b[k]);
    if (list.length > MAX_IDS) return res.status(400).json({ error: `${k}: max ${MAX_IDS} IDs` });
    if (list.some((x) => !ID_RE.test(x))) return res.status(400).json({ error: `${k}: every entry must be a Discord ID (digits only)` });
    c[k] = [...new Set(list)];
  }
  if (b.enabled !== undefined) c.enabled = !!b.enabled;

  if (b.clearToken) delete c.tokenSealed;
  else if (typeof b.token === "string" && b.token.trim()) {
    const t = b.token.trim();
    if (t.length > 120 || !TOKEN_RE.test(t)) return res.status(400).json({ error: "That doesn't look like a Discord bot token (Developer Portal -> Bot -> Reset Token)" });
    c.tokenSealed = sealSecret(t);
  }

  c.rev = Date.now(); // the bot notices this and restarts itself with the new settings
  await writeJSON(FILE, c);
  res.json(publicView(c));
});

// Make the bot reload (it exits; PM2 brings it straight back)
router.post("/restart", uiOnly, async (_req, res) => {
  const c = await load();
  c.rev = Date.now();
  await writeJSON(FILE, c);
  res.json({ success: true });
});

// ---------- Bot (API key) ----------
router.get("/bot-config", botOnly, async (_req, res) => {
  const c = await load();
  let token = "";
  if (c.tokenSealed) { try { token = openSecret(c.tokenSealed); } catch { token = ""; } }
  res.set("Cache-Control", "no-store");
  res.json({
    enabled: c.enabled !== false,
    token,
    clientId: c.clientId || (token ? clientIdFromToken(token) : ""),
    guildId: c.guildId || "",
    allowedUserIds: c.allowedUserIds || [],
    allowedRoleIds: c.allowedRoleIds || [],
    adminUserIds: c.adminUserIds || [],
    adminRoleIds: c.adminRoleIds || [],
    notifyChannelId: c.notifyChannelId || "",
    logChannelId: c.logChannelId || "",
    rev: c.rev || 0,
  });
});

router.post("/heartbeat", botOnly, (req, res) => {
  const b = req.body || {};
  const state = ["online", "waiting", "disabled", "error"].includes(b.state) ? b.state : "online";
  status = {
    state,
    tag: b.tag ? clean(b.tag, 80) : null,
    guilds: Math.max(0, Math.min(100000, Number(b.guilds) || 0)),
    error: b.error ? clean(b.error, 200) : null,
    lastSeen: Date.now(),
  };
  res.json({ ok: true });
});

export default router;
