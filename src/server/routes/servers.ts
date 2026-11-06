import express from "express";
import path from "path";
import { requireAuth } from "../middleware/auth.js";
import { getServers, createServer, getServer, deleteServer, startServer, stopServer, terminateServer, restartServer, changeServerVersion, getFiles, uploadFile, uploadChunk, completeUpload, deleteFile, renameFile, saveFileContent, sendCommand, runRcon, getPlayers, installExtensionItem, installExtensionResource, testVotifier, getServerStats, updateOwner, updateIpAlias, getBackups, createBackup, downloadBackup, deleteBackup, unzipFile, zipFiles, installPlugin, installMod, updateResources, updateSuspend, updateExpiration, createFile, createDirectory, getStartup, updateStartup, downloadFile, getInstallLogs, getWorlds, uploadWorld, switchWorld, downloadWorld, deleteWorld, getAddons, uploadAddon, deleteAddon, getResources, uploadResource, installResourceFromGit, toggleResource, deleteResource, installFramework, searchCurseForgeWorlds, installCurseForgeWorld, getGameRules, saveGameRules} from "../controllers/servers.js";
import { getServerNetwork, getEulaStatus, acceptEula } from "../controllers/servers.js";
import { searchModpacks, getModpackVersions, installModpack, getModpackInstallLog } from "../controllers/modpacks.js";
import { getServerDatabases, createServerDatabase, deleteServerDatabase } from "../controllers/databases.js";
import { getSchedules, createSchedule, updateSchedule, deleteSchedule, runScheduleNowHandler } from "../controllers/schedules.js";
import { getServerActivity } from "../controllers/activity.js";
import { startPlayitTunnel, getPlayitStatus } from "../services/playit.js";
import multer from "multer";
import { isValidServerId, safeResolve } from "../utils/security.js";
import { uploadLimiter, heavyLimiter } from "../middleware/rateLimit.js";
import { execFile } from "child_process";

const router = express.Router();
// Single-request uploads are capped (default 4 GiB) so one request cannot fill the disk; larger
// files should use the chunked endpoints. Override with MAX_UPLOAD_BYTES.
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES) > 0 ? Number(process.env.MAX_UPLOAD_BYTES) : 4 * 1024 * 1024 * 1024;
const upload = multer({ dest: path.join(process.cwd(), ".data/temp/"), limits: { fileSize: MAX_UPLOAD_BYTES } });

router.use(requireAuth);

// ── Access control for every /:id route ────────────────────────────────────
// Previously only some handlers verified ownership, so any logged-in user
// could read/delete another user's files, backups, console etc. just by
// knowing/guessing the server id. This runs for EVERY route that has :id.
// Admins/owners: full access. The server's owner and its sub-users: access.
// Everyone else: 403. Ids must exist and be a plain token (also blocks "../").
router.param("id", async (req, res, next, id) => {
  try {
    if (!isValidServerId(id)) return res.status(400).json({ error: "Invalid server id" });
    const user = (req as any).user;
    const { readJSON } = await import("../services/db.js");
    const servers = await readJSON("servers.json") || [];
    const server = servers.find((s: any) => s.id === id);
    if (!server) return res.status(404).json({ error: "Server not found" });
    const staff = user.role === "admin" || user.role === "owner";
    const isOwner = server.owner === user.id;
    const isSub = Array.isArray(server.subUsers) && server.subUsers.some((su: any) => su.userId === user.id);
    if (!staff && !isOwner && !isSub) return res.status(403).json({ error: "Forbidden" });
    (req as any).serverAccess = { staff, isOwner, isSub };
    next();
  } catch (err) {
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Management-only (server owner or admin; NOT sub-users): sub-user list, SFTP credentials.
const requireManager = (req: any, res: any, next: any) => {
  const a = req.serverAccess;
  if (a && (a.staff || a.isOwner)) return next();
  return res.status(403).json({ error: "Only the server owner or an admin can do this" });
};
router.use("/:id/subusers", requireManager);
router.use("/:id/sftp", requireManager);

router.get("/", getServers);
router.post("/", heavyLimiter, createServer);
router.get("/:id", getServer);
router.get("/:id/stats", getServerStats);
router.delete("/:id", deleteServer);
router.put("/:id/owner", updateOwner);
router.put("/:id/ipalias", updateIpAlias);

router.put("/:id/version", changeServerVersion);
router.get("/:id/startup", getStartup);
router.get("/:id/install-logs", getInstallLogs);

router.get("/curseforge/worlds/search", searchCurseForgeWorlds);

router.get("/:id/worlds", getWorlds);
router.post("/:id/worlds/upload", uploadLimiter, upload.single("file"), uploadWorld);
router.put("/:id/worlds/active", switchWorld);
router.get("/:id/worlds/download", downloadWorld);
router.delete("/:id/worlds", deleteWorld);
router.post("/:id/worlds/install-curseforge", heavyLimiter, installCurseForgeWorld);
router.get("/:id/worlds/gamerules", getGameRules);
router.put("/:id/worlds/gamerules", saveGameRules);

router.get("/:id/addons", getAddons);
router.post("/:id/addons/upload", uploadLimiter, upload.single("file"), uploadAddon);
router.delete("/:id/addons", deleteAddon);

router.get("/:id/resources", getResources);
router.post("/:id/resources/upload", uploadLimiter, upload.single("file"), uploadResource);
router.post("/:id/resources/git", heavyLimiter, installResourceFromGit);
router.put("/:id/resources/toggle", toggleResource);
router.delete("/:id/resources", deleteResource);
router.post("/:id/resources/framework", heavyLimiter, installFramework);

router.get("/:id/modpacks/search", searchModpacks);
router.get("/:id/modpacks/:projectId/versions", getModpackVersions);
router.post("/:id/modpacks/install", heavyLimiter, installModpack);
router.get("/:id/modpacks/install-log", getModpackInstallLog);
router.put("/:id/startup", updateStartup);
router.put("/:id/resources", updateResources);
router.put("/:id/suspend", updateSuspend);
router.put("/:id/expiration", updateExpiration);


router.post("/:id/start", startServer);
router.post("/:id/stop", stopServer);
router.post("/:id/terminate", terminateServer);
router.post("/:id/restart", restartServer);
router.post("/:id/command", sendCommand);
router.post("/:id/rcon", runRcon);
router.get("/:id/players", getPlayers);

router.get("/:id/network", getServerNetwork);
router.get("/:id/eula", getEulaStatus);
router.post("/:id/eula/accept", acceptEula);

router.get("/:id/databases", getServerDatabases);
router.post("/:id/databases", createServerDatabase);
router.delete("/:id/databases/:dbId", deleteServerDatabase);

router.get("/:id/schedules", getSchedules);
router.post("/:id/schedules", createSchedule);
router.put("/:id/schedules/:schedId", updateSchedule);
router.delete("/:id/schedules/:schedId", deleteSchedule);
router.post("/:id/schedules/:schedId/run", runScheduleNowHandler);

router.get("/:id/activity", getServerActivity);
router.post("/:id/install-item", installExtensionItem);
router.post("/:id/install-resource", installExtensionResource);
router.post("/:id/votifier-test", testVotifier);

// Simple file endpoints
router.get("/:id/files", getFiles);
router.post("/:id/files/upload", uploadLimiter, upload.single("file"), uploadFile);
router.post("/:id/files/upload-chunk", uploadLimiter, upload.single("chunk"), uploadChunk);
router.post("/:id/files/upload-complete", completeUpload);
router.post("/:id/files/rename", renameFile);
router.post("/:id/files/save", saveFileContent);
router.post("/:id/files/create", createFile);
router.post("/:id/files/mkdir", createDirectory);
router.post("/:id/files/unzip", heavyLimiter, unzipFile);
router.post("/:id/files/zip", heavyLimiter, zipFiles);
router.get("/:id/files/download", downloadFile);
router.delete("/:id/files", deleteFile);

// Backup endpoints
router.get("/:id/backups", getBackups);
router.post("/:id/backups", heavyLimiter, createBackup);
router.get("/:id/backups/:filename", downloadBackup);
router.delete("/:id/backups/:filename", deleteBackup);



// ── Playit / pm2 helpers ────────────────────────────────────────────────────
// pm2 process names are derived from the (user-editable) server name, so they are
// reduced to a safe charset and pm2 is always invoked without a shell.
async function playitProcessName(id: string): Promise<string> {
  const { readJSON } = await import("../services/db.js");
  const servers = (await readJSON("servers.json")) || [];
  const server = servers.find((s: any) => s.id === id);
  const serverName = server ? String(server.name).replace(/[^a-zA-Z0-9_-]/g, "_") : id;
  return `playit_${serverName}`;
}

function runPm2(args: string[]): Promise<void> {
  return new Promise((resolve) => {
    // Failures (e.g. "process not found") are expected and intentionally ignored.
    execFile("npx", ["pm2", ...args], { timeout: 30_000 }, () => resolve());
  });
}

router.get("/:id/playit", async (req, res) => {
  const user = (req as any).user;
  if (user.role !== "admin" && user.role !== "owner") return res.status(403).json({ error: "Forbidden" });

  const { id } = req.params;
  const serversPath = path.join(process.cwd(), ".data", "servers.json");
  const serversJSON = await (await import("fs/promises")).readFile(serversPath, "utf8");
  const servers = JSON.parse(serversJSON);
  const server = servers.find((s: any) => s.id === id);
  const serverName = server ? server.name.replace(/[^a-zA-Z0-9_-]/g, "_") : id;

  try {
    const status = await getPlayitStatus(serverName);

    // Once playit.gg provisions a public tunnel address, automatically use
    // it as this server's connect IP/alias — no need for the admin to copy
    // it over manually.
    if (status.tunnelAddress && server) {
      const host = status.tunnelAddress.split(":")[0];
      if (host && server.ipAlias !== host) {
        server.ipAlias = host;
        await (await import("fs/promises")).writeFile(serversPath, JSON.stringify(servers, null, 2));
      }
    }

    res.json(status);
  } catch (e: any) {
    res.status(500).json({ error: e.message || "Failed to check Playit status" });
  }
});

router.post("/:id/playit/start", async (req, res) => { 
  const user = (req as any).user;
  if (user.role !== "admin" && user.role !== "owner") return res.status(403).json({ error: "Forbidden" });

  const { id } = req.params;
  const serversJSON = await (await import("fs/promises")).readFile(path.join(process.cwd(), ".data", "servers.json"), "utf8");
  const servers = JSON.parse(serversJSON);
  const server = servers.find((s: any) => s.id === id);
  const serverName = server ? server.name.replace(/[^a-zA-Z0-9_-]/g, "_") : id;

  try {
    await startPlayitTunnel(id, serverName);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: "Failed to start Playit Tunnel", details: e.message });
  }
});

router.post("/:id/playit/stop", async (req, res) => {
  const user = (req as any).user;
  if (user.role !== "admin" && user.role !== "owner") return res.status(403).json({ error: "Forbidden" });

  const { id } = req.params;
  if (!isValidServerId(id)) return res.status(400).json({ error: "Invalid server id" });
  const pm2Name = await playitProcessName(id);

  // execFile (no shell) so a server name can never be interpreted as shell syntax.
  await runPm2(["delete", pm2Name]);
  await runPm2(["save"]);
  res.json({ success: true });
});

router.post("/:id/playit/reset", async (req, res) => {
  const user = (req as any).user;
  if (user.role !== "admin" && user.role !== "owner") return res.status(403).json({ error: "Forbidden" });

  const { id } = req.params;
  if (!isValidServerId(id)) return res.status(400).json({ error: "Invalid server id" });
  const pm2Name = await playitProcessName(id);
  const secretPath = safeResolve(path.join(process.cwd(), ".data", "servers"), id, "playit.toml");
  if (!secretPath) return res.status(400).json({ error: "Invalid server id" });

  await runPm2(["delete", pm2Name]);
  await runPm2(["flush", pm2Name]);
  await (await import("fs/promises")).rm(secretPath, { force: true });
  await runPm2(["save"]);
  res.json({ success: true });
});

// Sub-users endpoints
router.get("/:id/subusers", async (req, res) => {
  try {
    const { id } = req.params;
    const { readJSON } = await import("../services/db.js");
    const servers = await readJSON("servers.json") || [];
    const server = servers.find((s: any) => s.id === id);
    if (!server) return res.status(404).json({ error: "Server not found" });

    const users = await readJSON("users.json") || [];
    res.json({
      subUsers: server.subUsers || [],
      availableUsers: users.map((u: any) => ({ id: u.id, username: u.username }))
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:id/subusers", async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, permissions } = req.body;
    const { readJSON, writeJSON } = await import("../services/db.js");
    const servers = await readJSON("servers.json") || [];
    const serverIndex = servers.findIndex((s: any) => s.id === id);
    if (serverIndex === -1) return res.status(404).json({ error: "Server not found" });

    if (!servers[serverIndex].subUsers) servers[serverIndex].subUsers = [];
    const subUserIndex = servers[serverIndex].subUsers.findIndex((su: any) => su.userId === userId);
    
    if (subUserIndex !== -1) {
      servers[serverIndex].subUsers[subUserIndex].permissions = permissions;
    } else {
      servers[serverIndex].subUsers.push({ userId, permissions });
    }

    await writeJSON("servers.json", servers);
    res.json({ success: true, subUsers: servers[serverIndex].subUsers });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/:id/subusers/:userId", async (req, res) => {
  try {
    const { id, userId } = req.params;
    const { readJSON, writeJSON } = await import("../services/db.js");
    const servers = await readJSON("servers.json") || [];
    const serverIndex = servers.findIndex((s: any) => s.id === id);
    if (serverIndex === -1) return res.status(404).json({ error: "Server not found" });

    if (!servers[serverIndex].subUsers) servers[serverIndex].subUsers = [];
    servers[serverIndex].subUsers = servers[serverIndex].subUsers.filter((su: any) => su.userId !== userId);

    await writeJSON("servers.json", servers);
    res.json({ success: true, subUsers: servers[serverIndex].subUsers });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

import { createSftpUser, resetSftpPassword, getSftpUser, deleteSftpUser } from "../services/sftp.js";

// SFTP endpoints
router.get("/:id/sftp", async (req, res) => {
  try {
    const { id } = req.params;
    const user = await getSftpUser(id);
    if (!user) return res.status(404).json({ error: "SFTP user not found" });
    
    // We don't send the password hash, but we might want to generate a new temporary 
    // or just say it's hidden. But the UI expects the password to be returned upon creation/reset.
    // So for GET, we don't have the plaintext password. We'll return a placeholder.
    res.json({
      host: req.headers.host?.split(":")[0] || "127.0.0.1",
      port: 6868,
      username: user.username,
      password: "(Hidden - Reset to reveal)"
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:id/sftp/create", async (req, res) => {
  try {
    const { id } = req.params;
    const creds = await createSftpUser(id);
    res.json({
      host: req.headers.host?.split(":")[0] || "127.0.0.1",
      port: 6868,
      username: creds.username,
      password: creds.password
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:id/sftp/reset-password", async (req, res) => {
  try {
    const { id } = req.params;
    const creds = await resetSftpPassword(id);
    res.json({
      host: req.headers.host?.split(":")[0] || "127.0.0.1",
      port: 6868,
      username: creds.username,
      password: creds.password
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/:id/sftp", async (req, res) => {
  try {
    const { id } = req.params;
    await deleteSftpUser(id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:id/plugins/install", heavyLimiter, installPlugin);
router.post("/:id/mods/install", heavyLimiter, installMod);
// Turn multer failures (size limit, malformed multipart) into clean 4xx JSON instead of a 500 page.
router.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err instanceof multer.MulterError) {
    const tooBig = err.code === "LIMIT_FILE_SIZE";
    return res.status(tooBig ? 413 : 400).json({ error: tooBig ? "File is too large for a single upload (use the chunked upload)." : err.message });
  }
  next(err);
});

export default router;
