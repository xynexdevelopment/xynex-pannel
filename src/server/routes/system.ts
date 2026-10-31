import express from "express";
import { BCRYPT_ROUNDS } from "../utils/security.js";
import { getVersions } from "../services/docker.js";
import { requireAuth } from "../middleware/auth.js";
import os from "os";
import { readJSON, writeJSON, updateJSON } from "../services/db.js";
import { logActivity, requestActor } from "../services/activityLog.js";
import bcrypt from "bcryptjs";
import { upsertTunnelHostname, upsertTunnelDns } from "../services/cloudflare.js";
import { banIp, unbanIp, listBannedIps } from "../middleware/ipBan.js";
import { getTrafficSnapshot, getTrackedIpCount } from "../middleware/trafficStats.js";

const router = express.Router();

router.use(requireAuth);

// Role hierarchy: only an "owner" may create, modify, delete or take over an "owner" account,
// so a regular admin (or a leaked admin API key) can't escalate to / lock out the owner.
const VALID_ROLES = ["user", "admin", "owner"];
const targetProtected = (actor: any, target: any) =>
  target && (target.role === "owner") && actor.role !== "owner";

router.get("/next-port", async (req, res) => {
  try {
    const settings = await readJSON("settings.json") || {};
    // Default to a 19100-50000 auto-incrementing range out of the box so
    // server creation always gets a free port without an admin having to
    // configure a node port range first. An admin-configured range (if set)
    // still takes priority.
    const start = Number(settings.nodePortRangeStart) || 19100;
    const end = Number(settings.nodePortRangeEnd) || 50000;
    if (end < start) {
      return res.json({ available: false, message: "No port range configured for this node yet." });
    }
    const servers = await readJSON("servers.json") || [];
    const usedPorts = new Set(servers.map((s: any) => Number(s.port)));
    for (let p = start; p <= end; p++) {
      if (!usedPorts.has(p)) {
        return res.json({ available: true, port: p, nodeIp: settings.nodeIp || "0.0.0.0" });
      }
    }
    res.json({ available: false, message: "Every port in the configured range is already in use." });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to find an available port" });
  }
});

router.get("/versions", async (req, res) => {
  const type = (req.query.type as string) || "PAPER";
  const versions = await getVersions(type);
  res.json(versions);
});

// Deprecated endpoint for backward compatibility
router.get("/paper-versions", async (req, res) => {
  const versions = await getVersions("PAPER");
  res.json(versions);
});

// Real host CPU% sampled in the background (delta of os.cpus() times), so the
// dashboard shows an actual percentage instead of a load-average guess.
let lastCpu = os.cpus().map((c) => ({ ...c.times }));
let cpuPercent = 0;
const sampleCpu = () => {
  const now = os.cpus().map((c) => ({ ...c.times }));
  let idle = 0;
  let total = 0;
  now.forEach((t, i) => {
    const prev = lastCpu[i] || t;
    const d = {
      user: t.user - prev.user, nice: t.nice - prev.nice, sys: t.sys - prev.sys,
      idle: t.idle - prev.idle, irq: t.irq - prev.irq,
    };
    idle += d.idle;
    total += d.user + d.nice + d.sys + d.idle + d.irq;
  });
  lastCpu = now;
  if (total > 0) cpuPercent = Math.max(0, Math.min(100, Math.round((1 - idle / total) * 100)));
};
setInterval(sampleCpu, 3000).unref();

router.get("/stats", async (req, res) => {
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();

  // Real disk usage of the volume the panel runs on (fs.statfs, Node 18.15+).
  let totalDisk = 0;
  let usedDisk = 0;
  let diskUsage = 0;
  try {
    const st: any = await (await import("fs")).promises.statfs(process.cwd());
    totalDisk = Number(st.blocks) * Number(st.bsize);
    usedDisk = (Number(st.blocks) - Number(st.bavail)) * Number(st.bsize);
    diskUsage = totalDisk > 0 ? Math.round((usedDisk / totalDisk) * 100) : 0;
  } catch { /* statfs unavailable: leave zeros */ }

  res.json({
    cpuUsage: Math.round(os.loadavg()[0] * 100) / 100, // load average (kept for existing screens)
    cpuPercent,
    cpuCores: os.cpus().length,
    totalMemory,
    freeMemory,
    ramUsage: Math.round(((totalMemory - freeMemory) / totalMemory) * 100),
    totalDisk,
    usedDisk,
    diskUsage,
    uptimeSeconds: Math.round(os.uptime()),
  });
});

// ---------------------------------------------------------------------------
// Users (Pterodactyl-style admin user management)
// ---------------------------------------------------------------------------
const isStaffUser = (u: any) => u && (u.role === "admin" || u.role === "owner");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const cleanText = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// Everything the admin UI needs about an account - never the password hash / 2FA secrets / avatar blob.
function publicUser(u: any, servers: any[]) {
  const owned = servers.filter((s: any) => s.owner === u.id);
  const shared = servers.filter((s: any) => s.owner !== u.id && Array.isArray(s.subUsers) && s.subUsers.some((su: any) => su.userId === u.id));
  return {
    id: u.id,
    username: u.username,
    email: u.email || null,
    firstName: u.firstName || "",
    lastName: u.lastName || "",
    role: u.role || "user",
    isGoogleUser: !!u.googleId,
    twoFactorEnabled: !!u.twoFactorEnabled,
    discordConnected: !!u.discordId,
    suspended: !!u.suspended,
    suspendedReason: u.suspendedReason || "",
    notes: u.notes || "",
    createdAt: u.createdAt || null,
    lastIp: u.lastIp || null,
    lastLoginAt: u.lastLoginAt || null,
    serversOwned: owned.length,
    canAccess: shared.length,
  };
}

router.get("/users", async (req, res) => {
  const user = (req as any).user;
  if (!isStaffUser(user)) return res.status(403).json({ error: "Forbidden" });
  const users = (await readJSON("users.json")) || [];
  const servers = (await readJSON("servers.json")) || [];
  res.json(users.map((u: any) => publicUser(u, servers)));
});

router.get("/users/:id", async (req, res) => {
  const actor = (req as any).user;
  if (!isStaffUser(actor)) return res.status(403).json({ error: "Forbidden" });
  const users = (await readJSON("users.json")) || [];
  const target = users.find((u: any) => u.id === req.params.id);
  if (!target) return res.status(404).json({ error: "User not found" });
  const servers = (await readJSON("servers.json")) || [];
  const brief = (s: any) => ({ id: s.id, name: s.name, type: s.type || null });
  res.json({
    ...publicUser(target, servers),
    ownedServers: servers.filter((s: any) => s.owner === target.id).map(brief),
    sharedServers: servers
      .filter((s: any) => s.owner !== target.id && Array.isArray(s.subUsers) && s.subUsers.some((su: any) => su.userId === target.id))
      .map(brief),
  });
});

router.post("/users", async (req, res) => {
  const user = (req as any).user;
  if (!isStaffUser(user)) return res.status(403).json({ error: "Forbidden" });
  if ((user as any).isApiKey) return res.status(403).json({ error: "API keys cannot create users" });

  const { password, role } = req.body || {};
  const username = cleanText(req.body?.username, 64);
  const email = cleanText(req.body?.email, 254).toLowerCase();
  const firstName = cleanText(req.body?.firstName, 64);
  const lastName = cleanText(req.body?.lastName, 64);
  const notes = cleanText(req.body?.notes, 1000);

  if (!username || typeof password !== "string" || typeof role !== "string") return res.status(400).json({ error: "Missing fields" });
  if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: "Invalid role" });
  if (role === "owner" && user.role !== "owner") return res.status(403).json({ error: "Only an owner can create owner accounts" });
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: "Username must be 3-32 characters (letters, numbers, dot, dash, underscore)" });
  if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: "Please enter a valid email address" });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });

  const users = (await readJSON("users.json")) || [];
  if (users.find((u: any) => String(u.username).toLowerCase() === username.toLowerCase())) return res.status(400).json({ error: "Username taken" });
  if (email && users.find((u: any) => u.email && String(u.email).toLowerCase() === email)) return res.status(400).json({ error: "This email address is already in use" });

  const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const newUserId = Date.now().toString();
  users.push({
    id: newUserId,
    username,
    ...(email ? { email } : {}),
    ...(firstName ? { firstName } : {}),
    ...(lastName ? { lastName } : {}),
    ...(notes ? { notes } : {}),
    password: hashedPassword,
    role,
    passwordVersion: 0,
    createdAt: new Date().toISOString(),
  });

  await writeJSON("users.json", users);
  logActivity({ ...requestActor(req), action: "user.create", description: `Created user "${username}" (${role})` });
  res.json({ success: true, id: newUserId, username, role });
});

// Edit identity + role + admin notes of an account.
router.patch("/users/:id", async (req, res) => {
  const actor = (req as any).user;
  if (!isStaffUser(actor)) return res.status(403).json({ error: "Forbidden" });

  const users = (await readJSON("users.json")) || [];
  const idx = users.findIndex((u: any) => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "User not found" });
  const target = users[idx];
  if (targetProtected(actor, target)) return res.status(403).json({ error: "Only an owner can edit an owner account" });
  if (target.id === "temp-admin") return res.status(400).json({ error: "The default admin account cannot be edited" });

  const body = req.body || {};
  const changes: string[] = [];

  if (body.username !== undefined) {
    const username = cleanText(body.username, 64);
    if (username !== target.username) {
      if (!USERNAME_RE.test(username)) return res.status(400).json({ error: "Username must be 3-32 characters (letters, numbers, dot, dash, underscore)" });
      if (users.some((u: any) => u.id !== target.id && String(u.username).toLowerCase() === username.toLowerCase())) return res.status(400).json({ error: "Username taken" });
      target.username = username;
      changes.push("username");
    }
  }

  if (body.email !== undefined) {
    const email = cleanText(body.email, 254).toLowerCase();
    if (email !== String(target.email || "").toLowerCase()) {
      if (target.googleId) return res.status(400).json({ error: "The email of a Google account can't be changed" });
      if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: "Please enter a valid email address" });
      if (email && users.some((u: any) => u.id !== target.id && u.email && String(u.email).toLowerCase() === email)) return res.status(400).json({ error: "This email address is already in use" });
      if (email) target.email = email; else delete target.email;
      changes.push("email");
    }
  }

  for (const key of ["firstName", "lastName"] as const) {
    if (body[key] !== undefined) {
      const val = cleanText(body[key], 64);
      if (val !== (target[key] || "")) {
        if (val) target[key] = val; else delete target[key];
        changes.push(key);
      }
    }
  }

  if (body.notes !== undefined) {
    const notes = cleanText(body.notes, 1000);
    if (notes !== (target.notes || "")) {
      if (notes) target.notes = notes; else delete target.notes;
      changes.push("notes");
    }
  }

  if (body.role !== undefined && body.role !== (target.role || "user")) {
    if (typeof body.role !== "string" || !VALID_ROLES.includes(body.role)) return res.status(400).json({ error: "Invalid role" });
    if (target.id === actor.id) return res.status(400).json({ error: "You cannot change your own role" });
    if (body.role === "owner" && actor.role !== "owner") return res.status(403).json({ error: "Only an owner can promote someone to owner" });
    target.role = body.role;
    // Make sure the role change applies to already-issued tokens/sockets right away.
    target.passwordVersion = (target.passwordVersion || 0) + 1;
    changes.push("role");
  }

  if (changes.length === 0) return res.json({ success: true, unchanged: true });

  await writeJSON("users.json", users);
  logActivity({ ...requestActor(req), action: "user.update", description: `Updated user "${target.username}" (${changes.join(", ")})` });
  const servers = (await readJSON("servers.json")) || [];
  res.json({ success: true, user: publicUser(target, servers) });
});

// Suspend / unsuspend: a suspended account can't log in, use its API keys or open sockets.
router.put("/users/:id/suspend", async (req, res) => {
  const actor = (req as any).user;
  if (!isStaffUser(actor)) return res.status(403).json({ error: "Forbidden" });
  const suspended = req.body?.suspended === true;
  const reason = cleanText(req.body?.reason, 200);

  const users = (await readJSON("users.json")) || [];
  const idx = users.findIndex((u: any) => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "User not found" });
  const target = users[idx];
  if (target.id === actor.id) return res.status(400).json({ error: "You cannot suspend your own account" });
  if (targetProtected(actor, target)) return res.status(403).json({ error: "Only an owner can suspend an owner account" });

  if (suspended) {
    target.suspended = true;
    if (reason) target.suspendedReason = reason; else delete target.suspendedReason;
    target.passwordVersion = (target.passwordVersion || 0) + 1; // kill live sessions immediately
  } else {
    delete target.suspended;
    delete target.suspendedReason;
  }
  await writeJSON("users.json", users);
  logActivity({ ...requestActor(req), action: suspended ? "user.suspend" : "user.unsuspend", description: `${suspended ? "Suspended" : "Unsuspended"} user "${target.username}"${suspended && reason ? ` (${reason})` : ""}` });
  res.json({ success: true, suspended });
});

// Admin escape hatch for someone who lost their authenticator device.
router.post("/users/:id/reset-2fa", async (req, res) => {
  const actor = (req as any).user;
  if (!isStaffUser(actor)) return res.status(403).json({ error: "Forbidden" });
  const users = (await readJSON("users.json")) || [];
  const idx = users.findIndex((u: any) => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "User not found" });
  const target = users[idx];
  if (targetProtected(actor, target)) return res.status(403).json({ error: "Only an owner can reset an owner's 2FA" });
  if (!target.twoFactorEnabled) return res.status(400).json({ error: "Two-factor authentication is not enabled for this user" });

  target.twoFactorEnabled = false;
  delete target.twoFactorSecret;
  delete target.twoFactorTempSecret;
  delete target.twoFactorLastStep;
  target.passwordVersion = (target.passwordVersion || 0) + 1;
  await writeJSON("users.json", users);
  logActivity({ ...requestActor(req), action: "user.2fa_reset", description: `Reset two-factor authentication for "${target.username}"` });
  res.json({ success: true });
});

// Delete: like Pterodactyl, refuses while the user still owns servers - unless the admin
// chooses to hand those servers over via ?reassignTo=<userId>.
router.delete("/users/:id", async (req, res) => {
  const user = (req as any).user;
  if (!isStaffUser(user)) return res.status(403).json({ error: "Forbidden" });

  let users = (await readJSON("users.json")) || [];
  const victim = users.find((u: any) => u.id === req.params.id);
  if (victim && targetProtected(user, victim)) return res.status(403).json({ error: "Only an owner can delete an owner account" });
  if (req.params.id === user.id) return res.status(400).json({ error: "You cannot delete your own account" });
  if (!victim) return res.status(404).json({ error: "User not found" });

  const servers = (await readJSON("servers.json")) || [];
  const owned = servers.filter((s: any) => s.owner === victim.id);
  const reassignTo = typeof req.query.reassignTo === "string" ? req.query.reassignTo : "";

  if (owned.length > 0) {
    if (!reassignTo) {
      return res.status(409).json({ error: `This user still owns ${owned.length} server(s). Reassign them first.`, serversOwned: owned.length });
    }
    const validTarget = reassignTo !== victim.id && (reassignTo === user.id || users.some((u: any) => u.id === reassignTo));
    if (!validTarget) return res.status(400).json({ error: "Invalid user to reassign servers to" });
  }

  users = users.filter((u: any) => u.id !== req.params.id);
  await writeJSON("users.json", users);

  // Hand over owned servers and drop the account from everyone else's sub-user lists.
  if (owned.length > 0 || servers.some((s: any) => Array.isArray(s.subUsers) && s.subUsers.some((su: any) => su.userId === victim.id))) {
    await updateJSON<any[]>("servers.json", [], (current) => {
      for (const s of current) {
        if (s.owner === victim.id && reassignTo) s.owner = reassignTo;
        if (Array.isArray(s.subUsers)) s.subUsers = s.subUsers.filter((su: any) => su.userId !== victim.id);
      }
      return current;
    });
  }

  logActivity({ ...requestActor(req), action: "user.delete", description: `Deleted user "${victim.username}"${owned.length ? ` (${owned.length} server(s) reassigned)` : ""}` });
  res.json({ success: true });
});


router.put("/users/:id/password", async (req, res) => {
  const user = (req as any).user;
  if(user.role !== "admin" && user.role !== "owner") return res.status(403).json({ error: "Forbidden"});
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }
  
  const users = await readJSON("users.json") || [];
  const targetIndex = users.findIndex((u: any) => u.id === req.params.id);
  if (targetIndex === -1) return res.status(404).json({ error: "User not found" });
  if (targetProtected(user, users[targetIndex])) return res.status(403).json({ error: "Only an owner can change an owner's password" });
  
  if (users[targetIndex].id === "temp-admin") {
    return res.status(400).json({ error: "Cannot change password of default admin account." });
  }

  if (users[targetIndex].googleId || !users[targetIndex].password) {
    return res.status(400).json({ error: "Cannot change password for Google authenticated accounts." });
  }
  
  const bcrypt = await import("bcryptjs");
  const hashedPassword = await bcrypt.default.hash(newPassword, 10);
  users[targetIndex].password = hashedPassword;
  users[targetIndex].passwordVersion = (users[targetIndex].passwordVersion || 0) + 1;
  await writeJSON("users.json", users);
  res.json({ success: true });
});

// Force-logout a user everywhere immediately by bumping their
// passwordVersion - every existing JWT for that account fails the
// passwordVersion check in requireAuth/requireAdmin on its very next
// request, without needing a server-side session store.
router.post("/users/:id/terminate", async (req, res) => {
  const admin = (req as any).user;
  if (admin.role !== "admin" && admin.role !== "owner") return res.status(403).json({ error: "Forbidden" });

  const users = await readJSON("users.json") || [];
  const targetIndex = users.findIndex((u: any) => u.id === req.params.id);
  if (targetIndex === -1) return res.status(404).json({ error: "User not found" });
  if (targetProtected(admin, users[targetIndex])) return res.status(403).json({ error: "Only an owner can terminate an owner's sessions" });

  if (users[targetIndex].id === "temp-admin") {
    return res.status(400).json({ error: "Cannot terminate sessions for the default admin account." });
  }

  users[targetIndex].passwordVersion = (users[targetIndex].passwordVersion || 0) + 1;
  await writeJSON("users.json", users);
  res.json({ success: true });
});

// Ban the last IP address a given user logged in from. Requires the user
// to have logged in at least once since IP tracking was added.
router.post("/users/:id/ban-ip", async (req, res) => {
  const admin = (req as any).user;
  if (admin.role !== "admin" && admin.role !== "owner") return res.status(403).json({ error: "Forbidden" });

  const users = await readJSON("users.json") || [];
  const target = users.find((u: any) => u.id === req.params.id);
  if (!target) return res.status(404).json({ error: "User not found" });

  if (!target.lastIp) {
    return res.status(400).json({ error: "No known IP address on record for this user yet (they need to log in at least once first)." });
  }

  await banIp(target.lastIp, `Banned via Admin Panel (user: ${target.username})`, admin.username || admin.id);
  res.json({ success: true, ip: target.lastIp });
});

router.get("/banned-ips", async (req, res) => {
  const user = (req as any).user;
  if (user.role !== "admin" && user.role !== "owner") return res.status(403).json({ error: "Forbidden" });
  res.json(await listBannedIps());
});

router.post("/banned-ips", async (req, res) => {
  const admin = (req as any).user;
  if (admin.role !== "admin" && admin.role !== "owner") return res.status(403).json({ error: "Forbidden" });
  const { ip, reason } = req.body;
  if (!ip || typeof ip !== "string") return res.status(400).json({ error: "An IP address is required" });
  await banIp(ip.trim(), reason || "", admin.username || admin.id);
  res.json({ success: true });
});

router.delete("/banned-ips/:ip", async (req, res) => {
  const admin = (req as any).user;
  if (admin.role !== "admin" && admin.role !== "owner") return res.status(403).json({ error: "Forbidden" });
  await unbanIp(decodeURIComponent(req.params.ip));
  res.json({ success: true });
});

// Live per-IP traffic snapshot (requests in the last ~60s), for the admin
// "Traffic" tab. Lets an admin spot a flood and ban the source IP directly.
router.get("/traffic", async (req, res) => {
  const user = (req as any).user;
  if (user.role !== "admin" && user.role !== "owner") return res.status(403).json({ error: "Forbidden" });
  res.json({
    rows: getTrafficSnapshot(50),
    trackedIps: getTrackedIpCount(),
  });
});

router.get("/cloudflare", async (req, res) => {
  const user = (req as any).user;
  if (user.role !== "admin" && user.role !== "owner") return res.status(403).json({ error: "Forbidden" });
  const settings = await readJSON("settings.json") || {};
  res.json({
    cloudflareDomain: settings.cloudflareDomain || "",
    cloudflareApiToken: settings.cloudflareApiToken || "",
    cloudflareAccountId: settings.cloudflareAccountId || "",
    cloudflareTunnelId: settings.cloudflareTunnelId || "",
    cloudflareNoTlsVerify: settings.cloudflareNoTlsVerify !== undefined ? settings.cloudflareNoTlsVerify : true,
  });
});

router.post("/cloudflare/connect", async (req, res) => {
  const user = (req as any).user;
  if (user.role !== "admin" && user.role !== "owner") return res.status(403).json({ error: "Forbidden" });

  const settings = await readJSON("settings.json") || {};
  const { cloudflareDomain, cloudflareApiToken, cloudflareAccountId, cloudflareTunnelId, cloudflareNoTlsVerify } = settings;

  if (!cloudflareDomain || !cloudflareApiToken || !cloudflareAccountId || !cloudflareTunnelId) {
    return res.status(400).json({ error: "Domain, API Token, Account ID, and Tunnel ID are all required." });
  }

  try {
    const creds = { apiToken: cloudflareApiToken, accountId: cloudflareAccountId, tunnelId: cloudflareTunnelId };
    await upsertTunnelHostname(creds, cloudflareDomain, "http://localhost:6767", cloudflareNoTlsVerify !== false);

    let dnsConfigured = false;
    try {
      dnsConfigured = await upsertTunnelDns(creds, cloudflareDomain);
    } catch (e) {
      dnsConfigured = false;
    }

    res.json({
      success: true,
      dnsConfigured,
      message: dnsConfigured
        ? `${cloudflareDomain} is now routed to this panel over HTTPS.`
        : `Route configured, but DNS could not be created automatically — add a CNAME record for ${cloudflareDomain} pointing to ${cloudflareTunnelId}.cfargotunnel.com manually.`,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to configure Cloudflare Tunnel" });
  }
});

router.get("/integrations", async (req, res) => {
  const user = (req as any).user;
  if (user.role !== "admin" && user.role !== "owner") return res.status(403).json({ error: "Forbidden" });
  const settings = await readJSON("settings.json") || {};
  res.json({
    curseforgeApiKey: settings.curseforgeApiKey || "",
    aiSupportEnabled: settings.aiSupportEnabled !== undefined ? settings.aiSupportEnabled : false,
    aiSupportProvider: settings.aiSupportProvider || "groq",
    aiSupportGroqApiKey: settings.aiSupportGroqApiKey || "",
    aiSupportGeminiApiKey: settings.aiSupportGeminiApiKey || "",
    aiSupportName: settings.aiSupportName || "",
    aiSupportLogo: settings.aiSupportLogo || "",
    discordClientId: settings.discordClientId || "",
    discordClientSecret: settings.discordClientSecret || "",
    enableDiscordConnect: settings.enableDiscordConnect !== undefined ? settings.enableDiscordConnect : false,
    discordWebhookUrl: settings.discordWebhookUrl || "",
    discordNotifyServerEvents: settings.discordNotifyServerEvents !== undefined ? settings.discordNotifyServerEvents : false,
  });
});

router.post("/test-discord-webhook", async (req, res) => {
  const user = (req as any).user;
  if (user.role !== "admin" && user.role !== "owner") return res.status(403).json({ error: "Forbidden" });
  const { webhookUrl } = req.body;
  const url = webhookUrl || (await readJSON("settings.json") || {}).discordWebhookUrl;
  if (!url) return res.status(400).json({ error: "No webhook URL configured." });
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [{ title: "✅ Test Notification", description: "Your XyneX Panel Discord webhook is working!", color: 0x6366f1, timestamp: new Date().toISOString() }],
      }),
    });
    if (!resp.ok) return res.status(400).json({ error: `Discord rejected the request (HTTP ${resp.status}). Double-check the webhook URL.` });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to reach Discord." });
  }
});

router.put("/settings", async (req, res) => {
  const user = (req as any).user;
  if(user.role !== "admin" && user.role !== "owner") return res.status(403).json({ error: "Forbidden"});
  const { 
    panelName, panelLogo, panelBackgroundImage, panelBackgroundBlur, 
    enablePlayit, enableTutorial, enableLoginAnimation, enableRegistration, theme, customTheme,
    navLayout, announcementEnabled, announcementText, announcementColor,
    enableGoogleLogin, firebaseApiKey, firebaseAuthDomain, firebaseProjectId,
    firebaseStorageBucket, firebaseMessagingSenderId, firebaseAppId,
    cloudflareDomain, cloudflareApiToken, cloudflareAccountId, cloudflareTunnelId, cloudflareNoTlsVerify,
    nodeIp, nodePortRangeStart, nodePortRangeEnd,
    curseforgeApiKey, aiSupportEnabled, aiSupportProvider, aiSupportGroqApiKey, aiSupportGeminiApiKey, aiSupportName, aiSupportLogo,
    discordClientId, discordClientSecret, enableDiscordConnect,
    maintenanceMode, maintenanceMessage,
    discordWebhookUrl, discordNotifyServerEvents
  } = req.body;
  const settings = await readJSON("settings.json") || {};
  if (panelName !== undefined) {
    settings.panelName = panelName || "XyneX Panel";
    try {
      const fs = await import("fs/promises");
      const path = await import("path");
      const targetPaths = [
        path.join(process.cwd(), "index.html"),
        path.join(process.cwd(), "dist", "index.html")
      ];
      for (const p of targetPaths) {
        try {
          let html = await fs.readFile(p, "utf-8");
          html = html.replace(/<title>.*<\/title>/i, `<title>${settings.panelName}</title>`);
          await fs.writeFile(p, html, "utf-8");
        } catch (e) {
          // Ignore if file doesn't exist
        }
      }
    } catch (err) {
      console.error("Error updating html title:", err);
    }
  }
  if (panelLogo !== undefined) settings.panelLogo = panelLogo;
  if (panelBackgroundImage !== undefined) settings.panelBackgroundImage = panelBackgroundImage;
  if (panelBackgroundBlur !== undefined) settings.panelBackgroundBlur = panelBackgroundBlur;
  if (enablePlayit !== undefined) settings.enablePlayit = enablePlayit;
  if (enableTutorial !== undefined) settings.enableTutorial = enableTutorial;
  if (enableLoginAnimation !== undefined) settings.enableLoginAnimation = enableLoginAnimation;
  if (enableRegistration !== undefined) settings.enableRegistration = enableRegistration;
  if (theme !== undefined) settings.theme = theme;
  if (customTheme !== undefined) settings.customTheme = customTheme;
  if (navLayout !== undefined) settings.navLayout = navLayout;
  if (announcementEnabled !== undefined) settings.announcementEnabled = announcementEnabled;
  if (announcementText !== undefined) settings.announcementText = announcementText;
  if (announcementColor !== undefined) settings.announcementColor = announcementColor;
  if (enableGoogleLogin !== undefined) settings.enableGoogleLogin = enableGoogleLogin;
  if (firebaseApiKey !== undefined) settings.firebaseApiKey = firebaseApiKey;
  if (firebaseAuthDomain !== undefined) settings.firebaseAuthDomain = firebaseAuthDomain;
  if (firebaseProjectId !== undefined) settings.firebaseProjectId = firebaseProjectId;
  if (firebaseStorageBucket !== undefined) settings.firebaseStorageBucket = firebaseStorageBucket;
  if (firebaseMessagingSenderId !== undefined) settings.firebaseMessagingSenderId = firebaseMessagingSenderId;
  if (firebaseAppId !== undefined) settings.firebaseAppId = firebaseAppId;
  if (cloudflareDomain !== undefined) settings.cloudflareDomain = cloudflareDomain;
  if (cloudflareApiToken !== undefined) settings.cloudflareApiToken = cloudflareApiToken;
  if (cloudflareAccountId !== undefined) settings.cloudflareAccountId = cloudflareAccountId;
  if (cloudflareTunnelId !== undefined) settings.cloudflareTunnelId = cloudflareTunnelId;
  if (cloudflareNoTlsVerify !== undefined) settings.cloudflareNoTlsVerify = cloudflareNoTlsVerify;
  if (nodeIp !== undefined) settings.nodeIp = nodeIp;
  if (maintenanceMode !== undefined) settings.maintenanceMode = maintenanceMode;
  if (maintenanceMessage !== undefined) settings.maintenanceMessage = maintenanceMessage;
  if (discordWebhookUrl !== undefined) settings.discordWebhookUrl = discordWebhookUrl;
  if (discordNotifyServerEvents !== undefined) settings.discordNotifyServerEvents = discordNotifyServerEvents;
  if (nodePortRangeStart !== undefined) settings.nodePortRangeStart = nodePortRangeStart;
  if (nodePortRangeEnd !== undefined) settings.nodePortRangeEnd = nodePortRangeEnd;
  if (curseforgeApiKey !== undefined) settings.curseforgeApiKey = curseforgeApiKey;
  if (aiSupportEnabled !== undefined) settings.aiSupportEnabled = aiSupportEnabled;
  if (aiSupportProvider !== undefined) settings.aiSupportProvider = aiSupportProvider;
  if (aiSupportGroqApiKey !== undefined) settings.aiSupportGroqApiKey = aiSupportGroqApiKey;
  if (aiSupportGeminiApiKey !== undefined) settings.aiSupportGeminiApiKey = aiSupportGeminiApiKey;
  if (aiSupportName !== undefined) settings.aiSupportName = aiSupportName;
  if (aiSupportLogo !== undefined) settings.aiSupportLogo = aiSupportLogo;
  if (discordClientId !== undefined) settings.discordClientId = String(discordClientId).trim();
  if (discordClientSecret !== undefined) settings.discordClientSecret = String(discordClientSecret).trim();
  if (enableDiscordConnect !== undefined) settings.enableDiscordConnect = enableDiscordConnect;
  await writeJSON("settings.json", settings);
  req.app.get("io")?.emit("settings_updated");
  res.json({ success: true });
});

router.post("/update", async (req, res) => {
  const user = (req as any).user;
  if(user.role !== "admin" && user.role !== "owner") return res.status(403).json({ error: "Forbidden"});

  // Broadcast to all clients to refresh in a few seconds
  const io = req.app.get("io");
  if (io) {
    io.emit("system_update_started");
  }

  res.json({ success: true, message: "Update process started" });

  const { execFile } = await import("child_process");
  setTimeout(() => {
    execFile("bash", ["update.sh"], { cwd: process.cwd(), timeout: 15 * 60 * 1000 }, (error, stdout, stderr) => {
      if (stdout) console.log(`[update] stdout: ${stdout}`);
      if (stderr) console.error(`[update] stderr: ${stderr}`);
      if (error) console.error("[update] failed:", error.message);
    });
  }, 1000);
});





export default router;
