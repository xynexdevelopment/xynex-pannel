import "dotenv/config";
import express from "express";
import path from "path";
import cors from "cors";
import helmet from "helmet";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import { createServer as createViteServer } from "vite";
import fs from "fs-extra";
import { verifySessionToken, getJwtSecret, isValidServerId } from "./src/server/utils/security.js";
import { apiLimiter } from "./src/server/middleware/rateLimit.js";
import { checkIpBanMiddleware } from "./src/server/middleware/ipBan.js";
import { trackTraffic } from "./src/server/middleware/trafficStats.js";
import { setIO } from "./src/server/services/socket.js";

import { validateConfig } from "./src/server/config.js";
{
  const report = validateConfig();
  report.warnings.forEach((w) => console.warn(`[config] ${w}`));
  if (report.errors.length) {
    report.errors.forEach((e) => console.error(`[config] ${e}`));
    console.error("[config] Invalid configuration - refusing to start. Fix .env and restart.");
    process.exit(1);
  }
}

// Resolves (or generates + persists) a strong random signing secret; never a hardcoded default.
getJwtSecret();

// Allowed browser origins for CORS / websockets. Set ALLOWED_ORIGINS="https://panel.example.com,https://x.com"
// in .env. If unset, only same-origin requests (no cross-site access) are allowed.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map((o) => o.trim()).filter(Boolean);
const originAllowed = (origin: string | undefined, host: string | undefined) => {
  if (!origin) return true; // non-browser clients / same-origin navigation
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try { return !!host && new URL(origin).host === host; } catch { return false; }
};

const app = express();

// Which reverse proxies may set X-Forwarded-For. Default: only a proxy on this machine
// (cloudflared / nginx on localhost). Set TRUST_PROXY to a hop count ("1"), a subnet list, or
// "false" if the panel is exposed directly. A wrong value here lets clients spoof their IP.
const trustProxyEnv = (process.env.TRUST_PROXY ?? "loopback").trim();
app.set(
  "trust proxy",
  trustProxyEnv === "false" ? false : /^\d+$/.test(trustProxyEnv) ? Number(trustProxyEnv) : trustProxyEnv
);

const httpServer = createServer(app);
export const io = new SocketIOServer(httpServer, {
  cors: { origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : false },
  allowRequest: (req, cb) => cb(null, originAllowed(req.headers.origin as string | undefined, req.headers.host)),
  maxHttpBufferSize: 1e6,
});
app.set("io", io);
setIO(io);

// Initialize data folders
const DATA_DIR = path.join(process.cwd(), ".data");
const SERVERS_DIR = path.join(DATA_DIR, "servers");
const BACKUPS_DIR = path.join(process.cwd(), "backups");

fs.ensureDirSync(DATA_DIR);
fs.ensureDirSync(SERVERS_DIR);
fs.ensureDirSync(BACKUPS_DIR);
fs.ensureDirSync(path.join(DATA_DIR, "temp"));

if (!fs.existsSync(path.join(DATA_DIR, "users.json"))) fs.writeFileSync(path.join(DATA_DIR, "users.json"), "[]");
if (!fs.existsSync(path.join(DATA_DIR, "servers.json"))) fs.writeFileSync(path.join(DATA_DIR, "servers.json"), "[]");
if (!fs.existsSync(path.join(DATA_DIR, "settings.json"))) fs.writeFileSync(path.join(DATA_DIR, "settings.json"), "{}");

import { attachContainerSocket, getContainerLogs } from "./src/server/services/docker.js";

io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token || typeof token !== "string") return next(new Error("Authentication error"));
  try {
    const verified = verifySessionToken(token);
    // Re-check against the DB so deleted users / changed passwords / demoted roles apply to sockets too
    const users = JSON.parse(await fs.readFile(path.join(DATA_DIR, "users.json"), "utf8"));
    const dbUser = Array.isArray(users) ? users.find((u: any) => u.id === verified.id) : null;
    if (verified.id !== "temp-admin") {
      if (!dbUser || dbUser.suspended || (dbUser.passwordVersion || 0) !== (verified.passwordVersion || 0)) {
        return next(new Error("Authentication error"));
      }
      verified.role = dbUser.role || "user";
    }
    (socket as any).user = verified;
    next();
  } catch (err) {
    next(new Error("Authentication error"));
  }
});

const isStaff = (u: any) => u && (u.role === "admin" || u.role === "owner");

async function canAccessServer(user: any, serverId: string): Promise<boolean> {
  if (!isValidServerId(serverId)) return false;
  if (isStaff(user)) return true;
  try {
    const servers = JSON.parse(await fs.readFile(path.join(DATA_DIR, "servers.json"), "utf8"));
    const server = Array.isArray(servers) ? servers.find((s: any) => s.id === serverId) : null;
    if (!server) return false;
    return server.owner === user.id || (Array.isArray(server.subUsers) && server.subUsers.some((su: any) => su.userId === user.id));
  } catch { return false; }
}

async function canAccessTicket(user: any, ticketId: string): Promise<boolean> {
  if (isStaff(user)) return true;
  try {
    const tickets = JSON.parse(await fs.readFile(path.join(DATA_DIR, "support-tickets.json"), "utf8"));
    const t = Array.isArray(tickets) ? tickets.find((x: any) => x.id === ticketId) : null;
    return !!t && (t.userId === user.id || t.user_id === user.id || t.createdBy === user.id);
  } catch { return false; }
}

io.on("connection", (socket) => {
  // Support chat rooms: staff auto-join the admin broadcast room; everyone
  // gets their own user room so ticket updates reach them regardless of
  // which specific ticket room they're currently viewing.
  const socketUser = (socket as any).user;
  if (socketUser) {
    if (isStaff(socketUser)) {
      socket.join("support_admins");
    }
    socket.join(`support_user_${socketUser.id}`);
  }
  socket.on("joinTicket", async (ticketId) => {
    if (typeof ticketId !== "string" && typeof ticketId !== "number") return;
    if (!(await canAccessTicket(socketUser, String(ticketId)))) return;
    socket.join(`support_${ticketId}`);
  });
  socket.on("leaveTicket", (ticketId) => {
    socket.leave(`support_${ticketId}`);
  });

  socket.on("joinServer", async (serverId) => {
    if (!(await canAccessServer(socketUser, serverId))) return;
    socket.join(`server_${serverId}`);
    
    // Ensure logs are streamed if container is already running
    try {
      const serversJSON = await fs.readFile(path.join(DATA_DIR, "servers.json"), "utf8");
      const servers = JSON.parse(serversJSON);
      const server = Array.isArray(servers) ? servers.find((s: any) => s.id === serverId) : null;
      if (server && server.containerId) {
        const logs = await getContainerLogs(server.containerId);
        if (logs) {
           socket.emit("log", logs.trim() + "\n");
        }
        await attachContainerSocket(server.containerId, serverId);
      } else if (server && server.status === "installing") {
        // No container yet: the install is still running in the background.
        // Replay whatever the install script has printed so far so the
        // console isn't empty; live output follows via the room.
        socket.emit("log", "[System] Server is installing, please wait...\r\n");
        const installLog = await fs.readFile(path.join(DATA_DIR, "install-logs", `${serverId}.log`), "utf8").catch(() => "");
        if (installLog) socket.emit("log", installLog.split("\n").slice(-100).join("\n") + "\n");
      } else if (server && server.status === "install_failed") {
        socket.emit("log", `[System Error] Installation failed: ${server.installError || "unknown error"}\r\n`);
      }
    } catch (e) {
      console.error(e);
    }
  });
  socket.on("leaveServer", (serverId) => {
    socket.leave(`server_${serverId}`);
  });
});

const PORT = process.env.PORT || 6767;

// Security headers (helmet). In production the panel ships a Content-Security-Policy that
// blocks injected/inline scripts (the main XSS escalation path) while still allowing the
// Google fonts, Remix icons and Firebase Google-login the UI uses. Styles stay 'unsafe-inline'
// because React/Tailwind set inline style attributes. Dev mode (Vite HMR) needs inline scripts,
// so CSP is only enforced when NODE_ENV=production. CSP_MODE=report-only|off overrides.
const cspMode = (process.env.CSP_MODE || (process.env.NODE_ENV === "production" ? "enforce" : "off")).toLowerCase();
app.use(
  helmet({
    contentSecurityPolicy:
      cspMode === "off"
        ? false
        : {
            reportOnly: cspMode === "report-only",
            useDefaults: true,
            directives: {
              "default-src": ["'self'"],
              "script-src": ["'self'", "https://apis.google.com"],
              "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
              "font-src": ["'self'", "data:", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
              "img-src": ["'self'", "data:", "blob:", "https:"],
              "connect-src": ["'self'", "ws:", "wss:", "https:"],
              "frame-src": ["'self'", "https://accounts.google.com", "https://*.firebaseapp.com"],
              "object-src": ["'none'"],
              "base-uri": ["'self'"],
              "form-action": ["'self'"],
              "frame-ancestors": ["'self'"],
            },
          },
    crossOriginEmbedderPolicy: false,
    // Firebase popup sign-in needs window.opener, so don't isolate the opener.
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
  })
);

// File uploads go through multer (multipart), not these parsers, so JSON bodies stay bounded.
app.disable("x-powered-by");
// JSON bodies are small (settings, commands, base64 logos at most); 50mb let any client
// make the server buffer and parse huge payloads. Override with JSON_BODY_LIMIT if needed.
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || "5mb";
app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: JSON_BODY_LIMIT }));
app.use(
  cors({
    origin: (origin, cb) => cb(null, !origin || ALLOWED_ORIGINS.includes(origin) ? true : false),
  })
);

// Count every request per-IP (even ones that will be rejected below) so a
// flood shows up in the admin "Traffic" tab regardless of outcome.
app.use(trackTraffic);

// Reject banned IPs before they can burn rate-limit quota or reach any route.
app.use(checkIpBanMiddleware);

// General abuse-prevention limiter across the whole API. Auth routes get
// their own, much stricter limiter (see src/server/middleware/rateLimit.ts).
app.use("/api", apiLimiter);

import apiRoutes from "./src/server/routes/api.js";
app.use("/api", apiRoutes);

import { initSFTPServer, stopSFTPServer } from "./src/server/services/sftp.js";
import { startAutoSuspensionScheduler, stopAutoSuspensionScheduler } from "./src/server/services/scheduler.js";
import { startTaskScheduler, stopTaskScheduler } from "./src/server/services/taskScheduler.js";

async function startServer() {
  await initSFTPServer();
  startAutoSuspensionScheduler();
  startTaskScheduler();

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  httpServer.listen(PORT, () => {
    console.log(`XyneX Panel running on port ${PORT}`);
  });
}

startServer();

// After an uncaught exception the process state is undefined, so log it and exit; pm2
// (see ecosystem.config.cjs) restarts the panel cleanly. Unhandled rejections are logged
// but not fatal, so one failed background task doesn't take every server's console down.
function writeCrashLog(label: string, detail: unknown) {
  try {
    const text = detail instanceof Error ? detail.stack || detail.message : String(detail);
    const crashLog = path.join(DATA_DIR, "crash.log");
    // keep one previous generation instead of growing without bound
    if (fs.existsSync(crashLog) && fs.statSync(crashLog).size > 1024 * 1024) fs.renameSync(crashLog, crashLog + ".1");
    fs.appendFileSync(crashLog, `[${new Date().toISOString()}] ${label}: ${text}\n`, { mode: 0o600 });
  } catch { /* logging must never throw */ }
}
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
  writeCrashLog("uncaughtException", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
  writeCrashLog("unhandledRejection", reason);
});
// One idempotent shutdown path: stop accepting work, stop background timers, close SFTP + sockets,
// then let the HTTP server drain. A second signal or a stuck close cannot hang the process (8s cap).
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  setTimeout(() => process.exit(0), 8000).unref();
  stopAutoSuspensionScheduler();
  stopTaskScheduler();
  await stopSFTPServer().catch((e) => console.error("SFTP shutdown failed:", e));
  io.close();
  httpServer.close(() => process.exit(0));
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { void shutdown(signal); });
}
