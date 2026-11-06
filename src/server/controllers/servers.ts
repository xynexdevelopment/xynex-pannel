import { Request, Response } from "express";
import { readJSON, writeJSON } from "../services/db.js";
import { createServerContainer, deleteContainer, getContainerStatus, getContainerStats } from "../services/docker.js";
import { createSftpUser, deleteSftpUser } from "../services/sftp.js";
import { startPlayitTunnel } from "../services/playit.js";
import crypto from "crypto";
import fs from "fs-extra";
import path from "path";
import { logActivity, requestActor } from "../services/activityLog.js";
import { notifyDiscord } from "../services/discordWebhook.js";
import { serverRoot } from "../utils/security.js";


export const getServers = async (req: Request, res: Response) => {
  const user = (req as any).user;
  const servers = await readJSON("servers.json") || [];
  
  // Filter for normal users
  const userServers = user.role === "admin" || user.role === "owner" ? servers : servers.filter((s: any) => s.owner === user.id);

  // Update statuses
  const updatedServers = await Promise.all(userServers.map(async (server: any) => {
    if (server.containerId) {
      const status = await getContainerStatus(server.containerId);
      server.status = status?.State?.Running ? "online" : "offline";
    }
    return server;
  }));

  res.json(updatedServers);
};

// Domain handlers live in their own modules (re-exported so routes and imports are unchanged).
export * from "./serverWorlds.js";
export * from "./serverAddons.js";
export * from "./serverResources.js";
export * from "./serverBackups.js";
export * from "./serverMods.js";

export const getServer = async (req: Request, res: Response) => {
  const { id } = req.params;
  const user = (req as any).user;
  const servers = await readJSON("servers.json") || [];
  const server = servers.find((s: any) => s.id === id);
  if (!server) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  if (user.role !== "admin" && user.role !== "owner" && server.owner !== user.id) {
    return res.status(403).json({ error: "Forbidden" });
  }

  // While a server is still being installed it has no containerId yet.
  // Calling getContainerStatus(null) used to throw inside this async handler
  // (Express 4 doesn't catch that), so the request hung forever and the
  // console page sat on its loading spinner until the install finished.
  if (server.containerId) {
    const status = await getContainerStatus(server.containerId);
    server.status = status?.State?.Running ? "online" : "offline";
  }
  res.json(server);
};

export const getServerStats = async (req: Request, res: Response) => {
  const { id } = req.params;
  const user = (req as any).user;
  const servers = await readJSON("servers.json") || [];
  const server = servers.find((s: any) => s.id === id);
  if (!server) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  if (user.role !== "admin" && user.role !== "owner" && server.owner !== user.id) {
    return res.status(403).json({ error: "Forbidden" });
  }

  if (server.containerId) {
    const stats = await getContainerStats(server.containerId);
    res.json({
      ...stats,
      limitRam: server.ram ? server.ram * 1024 : 1024,
      limitCpu: server.cpu || 100,
      limitDisk: server.disk || 10
    });
  } else {
    res.json({ cpu: 0, ram: 0, disk: 0, netIn: 0, netOut: 0, limitRam: server.ram ? server.ram * 1024 : 1024, limitCpu: server.cpu || 100, limitDisk: server.disk || 10 });
  }
};

export const createServer = async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (user.role !== "admin" && user.role !== "owner") {
    return res.status(403).json({ error: "Only admins can create servers" });
  }
  const { name, ram, port, version, theme, cpu, disk, owner, ipAlias, type, eggId, expirationDate, nodeId, allocationId } = req.body;
  if (!name || !ram || !port) {
    res.status(400).json({ error: "Missing required fields (name, ram, port)" });
    return;
  }

  // Look up the selected egg (server template). Falls back to the legacy
  // hardcoded Minecraft "type" field if no eggId was sent, for backward
  // compatibility with older clients/scripts.
  let egg: any = null;
  if (eggId) {
    const eggs = await readJSON("eggs.json") || [];
    egg = eggs.find((e: any) => e.id === eggId);
    if (!egg) {
      res.status(400).json({ error: "Selected egg was not found. It may have been deleted." });
      return;
    }
  }

  const id = crypto.randomUUID();
  const serverData: any = {
    id,
    name,
    owner: owner || user.id, // Support assigning owner at creation
    ram,
    cpu: cpu || 100,
    disk: disk || 10,
    port,
    ipAlias: ipAlias || "",
    // Which node (real remote node, or omitted for the implicit Local Node)
    // this server was provisioned on — informational for now, surfaced in
    // the admin Nodes tab / server details.
    nodeId: nodeId || null,
    type: type || (egg ? egg.name : "PAPER"),
    version: version || (egg && egg.versions && egg.versions[egg.versions.length - 1]) || "1.21.11",
    theme: theme || "default",
    status: "installing",
    createdAt: new Date().toISOString(),
    containerId: null,
    // Auto-suspension: when set, a background check suspends this server
    // automatically once this date/time passes (see services/scheduler.ts).
    expirationDate: expirationDate || null,
  };

  if (egg) {
    serverData.eggId = egg.id;
    serverData.eggName = egg.name;
    serverData.category = egg.category;
    // Only keep a version if this egg actually has selectable versions.
    if (!egg.versions || egg.versions.length === 0) {
      delete serverData.version;
    }
    // Seed this server's own copy of the egg's startup variables (so the
    // Startup tab has something to show/edit even before any container
    // has started, and edits don't mutate the shared egg definition).
    if (Array.isArray(egg.variables) && egg.variables.length > 0) {
      serverData.variables = {};
      for (const v of egg.variables) {
        if (v && v.envVariable) serverData.variables[v.envVariable] = v.defaultValue ?? "";
      }
    }
  }

  const servers = await readJSON("servers.json") || [];
  
  if (servers.find((s: any) => s.port == port)) {
    res.status(400).json({ error: "Port is already in use by another server." });
    return;
  }

  servers.push(serverData);
  await writeJSON("servers.json", servers);

  // If this server was provisioned against a real node's allocation, mark
  // that allocation as used so it isn't handed out to another server.
  if (allocationId) {
    try {
      const allocations = await readJSON("allocations.json") || [];
      const alloc = allocations.find((a: any) => a.id === allocationId);
      if (alloc) {
        alloc.assigned = true;
        await writeJSON("allocations.json", allocations);
      }
    } catch (e) {
      console.error("Failed to mark allocation as assigned:", e);
    }
  }

  // Respond immediately with the "installing" record — the actual container
  // creation (image pull, volume setup, etc.) can take many seconds and used
  // to be awaited here, which is what made server creation feel slow. The
  // frontend already polls GET /api/servers, and rows already know how to
  // render the "installing" status, so we just let this run in the
  // background and let the next poll pick up the status change.
  logActivity({ ...requestActor(req), serverId: serverData.id, serverName: serverData.name, action: "server.create", description: `Created server "${serverData.name}"` });
  notifyDiscord({
    title: "🟢 Server Created",
    description: `**${serverData.name}** was created.`,
    color: 0x22c55e,
    fields: [
      { name: "Owner", value: String(owner || "—"), inline: true },
      { name: "Port", value: String(serverData.port), inline: true },
    ],
  });
  res.json(serverData);

  (async () => {
    try {
      const containerId = await createServerContainer(serverData, egg);
      serverData.containerId = containerId;
      serverData.status = "offline";
      req.app.get("io")?.to(`server_${id}`).emit("log", `\r\n[System] Installation complete. You can start the server now.\r\n`);

      // Re-read servers.json before writing back — other requests may have
      // mutated it (or other servers) while the container was being built.
      const latest = await readJSON("servers.json") || [];
      const idx = latest.findIndex((s: any) => s.id === id);
      if (idx !== -1) {
        latest[idx] = serverData;
      } else {
        latest.push(serverData);
      }
      await writeJSON("servers.json", latest);

      await createSftpUser(id).catch(e => console.error("SFTP user creation failed:", e));

      // No real VPS IP configured means players have no way to reach this
      // server directly — auto-start a Playit tunnel (if enabled) so it's
      // reachable without the admin needing to find the Playit tab first.
      try {
        const settings = await readJSON("settings.json") || {};
        if (!settings.nodeIp && settings.enablePlayit) {
          const serverName = serverData.name.replace(/[^a-zA-Z0-9_-]/g, "_");
          startPlayitTunnel(id, serverName).catch((e) => console.warn("Auto-start Playit tunnel failed:", e));
        }
      } catch (e) {
        console.warn("Could not check settings for Playit auto-start:", e);
      }
    } catch (err: any) {
      console.error("Background container creation failed:", err);
      try {
        const latest = await readJSON("servers.json") || [];
        const idx = latest.findIndex((s: any) => s.id === id);
        if (idx !== -1) {
          latest[idx].status = "install_failed";
          latest[idx].installError = err.message || String(err);
          await writeJSON("servers.json", latest);
        }
        req.app.get("io")?.to(`server_${id}`).emit("log", `\r\n[System Error] Installation failed: ${err.message || String(err)}\r\n`);
      } catch (e) {
        console.error("Failed to persist install_failed status:", e);
      }
    }
  })();
};

export const updateOwner = async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (user.role !== "admin" && user.role !== "owner") {
    return res.status(403).json({ error: "Only admins can update owner" });
  }

  const { id } = req.params;
  const { owner } = req.body;

  if (!owner) return res.status(400).json({ error: "Owner required" });

  const servers = await readJSON("servers.json") || [];
  const server = servers.find((s: any) => s.id === id);

  if (!server) return res.status(404).json({ error: "Server not found" });

  server.owner = owner;
  await writeJSON("servers.json", servers);
  
  res.json({ success: true });
};

export const updateIpAlias = async (req: Request, res: Response) => {
  const user = (req as any).user;
  const { id } = req.params;
  const { ipAlias } = req.body;

  const servers = await readJSON("servers.json") || [];
  const server = servers.find((s: any) => s.id === id);

  if (!server) return res.status(404).json({ error: "Server not found" });

  if (user.role !== "admin" && user.role !== "owner" && server.owner !== user.id) {
    return res.status(403).json({ error: "Forbidden" });
  }

  server.ipAlias = ipAlias;
  await writeJSON("servers.json", servers);
  
  res.json({ success: true });
};

export const deleteServer = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const user = (req as any).user;
    
    let servers = await readJSON("servers.json") || [];
    const server = servers.find((s: any) => s.id === id);
    
    if (!server) {
      return res.status(404).json({ error: "Server not found" });
    }

    if (user.role !== "admin" && user.role !== "owner") {
      return res.status(403).json({ error: "Only admins can delete servers" });
    }

    if (server.containerId) {
      await deleteContainer(server.containerId);
    }
    
    servers = servers.filter((s: any) => s.id !== id);
    await writeJSON("servers.json", servers);

    // Free up the node allocation (if any) this server was using.
    try {
      const allocations = await readJSON("allocations.json") || [];
      const alloc = allocations.find((a: any) => a.nodeId === server.nodeId && a.port === Number(server.port));
      if (alloc) {
        alloc.assigned = false;
        await writeJSON("allocations.json", allocations);
      }
    } catch (e) {
      console.error("Failed to release node allocation:", e);
    }

    // Remove files
    const serverDir = serverRoot(id);
    try {
      await fs.remove(serverDir);
    } catch (e) {
      console.error("Failed to remove server directory", e);
    }
    
    await deleteSftpUser(id).catch(e => console.error("SFTP user deletion failed:", e));

    logActivity({ ...requestActor(req), serverId: id, serverName: server.name, action: "server.delete", description: `Deleted server "${server.name}"` });
    notifyDiscord({
      title: "🔴 Server Deleted",
      description: `**${server.name}** was deleted.`,
      color: 0xef4444,
    });

    res.json({ success: true });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

// Lifecycle and configuration handlers live in their own modules (re-exported; routes unchanged).
export * from "./serverLifecycle.js";
export * from "./serverConfig.js";

// ---------------------------------------------------------------------------
// Network (Pterodactyl-style per-server "Network" tab): the primary
// IP:Port this server is reachable on, plus which node it's provisioned on
// (or "Local Node" if it was created before nodes existed / no real node
// was picked).
// ---------------------------------------------------------------------------
export const getServerNetwork = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const user = (req as any).user;
    const servers = await readJSON("servers.json") || [];
    const server = servers.find((s: any) => s.id === id);
    if (!server) return res.status(404).json({ error: "Server not found" });
    if (user.role !== "admin" && user.role !== "owner" && server.owner !== user.id) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const settings = await readJSON("settings.json") || {};
    let node: any = null;
    if (server.nodeId) {
      const nodes = await readJSON("nodes.json") || [];
      const n = nodes.find((nn: any) => nn.id === server.nodeId);
      if (n) node = { id: n.id, name: n.name, fqdn: n.fqdn, status: n.status };
    }

    res.json({
      ip: server.ipAlias || settings.nodeIp || null,
      port: server.port,
      ipAlias: server.ipAlias || null,
      node: node || { id: null, name: "Local Node", fqdn: null, status: "connected" },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to load network info" });
  }
};

// ---------------------------------------------------------------------------
// Minecraft EULA (Pterodactyl-style): most vanilla/Paper/Spigot/Forge images
// refuse to start until eula.txt has eula=true. Rather than making the user
// dig through the file manager, we surface a one-click accept prompt.
// ---------------------------------------------------------------------------
export const getEulaStatus = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const eulaPath = path.join(serverRoot(id), "eula.txt");
    const exists = await fs.pathExists(eulaPath);
    if (!exists) return res.json({ exists: false, accepted: false });
    const content = await fs.readFile(eulaPath, "utf8");
    const accepted = /eula\s*=\s*true/i.test(content);
    res.json({ exists: true, accepted });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to check EULA status" });
  }
};

export const acceptEula = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const user = (req as any).user;
    const servers = await readJSON("servers.json") || [];
    const server = servers.find((s: any) => s.id === id);
    if (!server) return res.status(404).json({ error: "Server not found" });
    if (user.role !== "admin" && user.role !== "owner" && server.owner !== user.id) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const serverDir = serverRoot(id);
    await fs.ensureDir(serverDir);
    const eulaPath = path.join(serverDir, "eula.txt");
    const body =
      `#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).\n` +
      `#${new Date().toUTCString()}\n` +
      `eula=true\n`;
    await fs.writeFile(eulaPath, body, "utf8");
    logActivity({ ...requestActor(req), serverId: server.id, serverName: server.name, action: "server.eula_accept", description: `Accepted the Minecraft EULA for "${server.name}"` });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to accept EULA" });
  }
};
