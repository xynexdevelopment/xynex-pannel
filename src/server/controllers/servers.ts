import { Request, Response } from "express";
import { readJSON, writeJSON } from "../services/db.js";
import { createServerContainer, deleteContainer, getContainerStatus, getContainerStats, startContainer } from "../services/docker.js";
import { createSftpUser, deleteSftpUser } from "../services/sftp.js";
import { startPlayitTunnel } from "../services/playit.js";
import crypto from "crypto";
import fs from "fs-extra";
import path from "path";
import { logActivity, requestActor } from "../services/activityLog.js";
import { acquireServerLock, busyMessage } from "../services/serverLocks.js";
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
  const {
    name, ram, port, version, theme, cpu, disk, owner, ipAlias, type, eggId, expirationDate, nodeId, allocationId,
    description, startOnInstall, additionalAllocationIds,
    databaseLimit, allocationLimit, backupLimit,
    cpuPinning, swap, blockIoWeight, oomKiller,
    startup, dockerImage, variables,
  } = req.body;
  // ram/disk are in GB and 0 means "unlimited" (Pterodactyl convention), so
  // only reject when they are missing entirely, not when they are 0.
  if (!name || ram === undefined || ram === null || ram === "" || !port) {
    res.status(400).json({ error: "Missing required fields (name, ram, port)" });
    return;
  }
  if (String(name).length > 100 || !/^[\w .-]+$/.test(String(name))) {
    res.status(400).json({ error: "Server name may only contain letters, numbers, spaces, _ - . (max 100 chars)." });
    return;
  }
  if (Number(ram) < 0 || Number(cpu) < 0 || Number(disk) < 0 || Number.isNaN(Number(ram))) {
    res.status(400).json({ error: "Memory, CPU and Disk must be 0 (unlimited) or a positive number." });
    return;
  }
  if (cpuPinning && !/^\d+([,-]\d+)*$/.test(String(cpuPinning).trim())) {
    res.status(400).json({ error: "CPU Pinning must look like 0, 0-1,3 or 0,1,3,4." });
    return;
  }
  const swapNum = swap === undefined || swap === null || swap === "" ? 0 : Number(swap);
  if (Number.isNaN(swapNum) || swapNum < -1) {
    res.status(400).json({ error: "Swap must be 0 (disabled), -1 (unlimited) or a positive MiB value." });
    return;
  }
  const blkioNum = blockIoWeight === undefined || blockIoWeight === null || blockIoWeight === "" ? 500 : Number(blockIoWeight);
  if (Number.isNaN(blkioNum) || blkioNum < 10 || blkioNum > 1000) {
    res.status(400).json({ error: "Block IO Weight must be between 10 and 1000." });
    return;
  }
  const parseLimit = (v: any): number | null => (v === undefined || v === null || v === "" ? null : Math.max(0, Math.floor(Number(v)) || 0));

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
    description: description ? String(description).slice(0, 500) : "",
    ram: Number(ram),
    cpu: cpu === undefined || cpu === null || cpu === "" ? 100 : Number(cpu),
    disk: disk === undefined || disk === null || disk === "" ? 10 : Number(disk),
    // Pterodactyl-style advanced resource options
    swap: swapNum,
    cpuPinning: cpuPinning ? String(cpuPinning).trim() : "",
    blockIoWeight: blkioNum,
    oomKiller: oomKiller === false ? false : true,
    // Application feature limits (null = unlimited)
    databaseLimit: parseLimit(databaseLimit),
    allocationLimit: parseLimit(allocationLimit),
    backupLimit: parseLimit(backupLimit),
    startOnInstall: startOnInstall !== false,
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

  if (egg) {
    if (typeof startup === "string" && startup.trim() && startup.trim() !== (egg.startup || "").trim()) {
      serverData.startup = startup.trim();
    }
    if (typeof dockerImage === "string" && dockerImage.trim() && dockerImage.trim() !== egg.dockerImage) {
      if (!/^[\w./:@-]+$/.test(dockerImage.trim())) {
        res.status(400).json({ error: "Docker image contains invalid characters." });
        return;
      }
      serverData.dockerImage = dockerImage.trim();
    }
    if (variables && typeof variables === "object" && !Array.isArray(variables)) {
      const allowed = new Set((Array.isArray(egg.variables) ? egg.variables : []).map((v: any) => v?.envVariable).filter(Boolean));
      serverData.variables = serverData.variables || {};
      for (const [k, v] of Object.entries(variables)) {
        if (allowed.has(k)) serverData.variables[k] = String(v ?? "");
      }
    }
  }

  const servers = await readJSON("servers.json") || [];

  // Resolve the default + additional allocations on the chosen node. The
  // port/ip always come from the stored allocation, never from the client.
  const extraIds: string[] = Array.isArray(additionalAllocationIds) ? Array.from(new Set(additionalAllocationIds.map(String))) : [];
  const allocationsAll: any[] = (await readJSON("allocations.json")) || [];
  if (nodeId && allocationId) {
    const main = allocationsAll.find((a: any) => a.id === allocationId);
    if (!main || main.nodeId !== nodeId || main.assigned) {
      res.status(400).json({ error: "The selected default allocation is not available on this node." });
      return;
    }
    serverData.port = main.port;
    serverData.allocationIp = main.ip;
    serverData.allocationId = main.id;
  }
  serverData.additionalAllocations = [];
  if (extraIds.length > 0) {
    if (!nodeId) {
      res.status(400).json({ error: "Additional allocations need a node to be selected." });
      return;
    }
    for (const aid of extraIds) {
      if (aid === allocationId) continue;
      const a = allocationsAll.find((x: any) => x.id === aid);
      if (!a || a.nodeId !== nodeId || a.assigned) {
        res.status(400).json({ error: "One of the additional allocations is not available anymore." });
        return;
      }
      serverData.additionalAllocations.push({ id: a.id, ip: a.ip, port: a.port });
    }
  }
  const takenPorts = (srv: any) => [Number(srv.port), ...(Array.isArray(srv.additionalAllocations) ? srv.additionalAllocations.map((a: any) => Number(a.port)) : [])];
  const wantedPorts = takenPorts(serverData);
  if (servers.some((srv: any) => takenPorts(srv).some((pt: number) => wantedPorts.includes(pt)))) {
    res.status(400).json({ error: "Port is already in use by another server." });
    return;
  }

  servers.push(serverData);
  await writeJSON("servers.json", servers);

  // If this server was provisioned against a real node's allocation, mark
  // that allocation as used so it isn't handed out to another server.
  if (allocationId || serverData.additionalAllocations.length > 0) {
    try {
      const allocations = await readJSON("allocations.json") || [];
      const toMark = new Set<string>([allocationId, ...serverData.additionalAllocations.map((a: any) => a.id)].filter(Boolean));
      for (const alloc of allocations) {
        if (toMark.has(alloc.id)) alloc.assigned = true;
      }
      await writeJSON("allocations.json", allocations);
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

      // Pterodactyl "Start Server when Installed"
      if (serverData.startOnInstall) {
        try {
          await startContainer(containerId);
          const afterStart = await readJSON("servers.json") || [];
          const si = afterStart.findIndex((s: any) => s.id === id);
          if (si !== -1) {
            afterStart[si].status = "online";
            await writeJSON("servers.json", afterStart);
          }
        } catch (e) {
          console.warn("Auto-start after install failed:", e);
        }
      }

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

    // Never delete a server while a restore/backup/reinstall is running on it.
    const deleteLock = acquireServerLock(id, "delete", 30 * 60 * 1000);
    if (!deleteLock.ok) return res.status(409).json({ error: busyMessage(deleteLock.busyWith) });
    try {
    if (server.containerId) {
      await deleteContainer(server.containerId);
    }
    
    servers = servers.filter((s: any) => s.id !== id);
    await writeJSON("servers.json", servers);

    // Free up the node allocation (if any) this server was using.
    try {
      const allocations = await readJSON("allocations.json") || [];
      const extraIds = new Set<string>((Array.isArray(server.additionalAllocations) ? server.additionalAllocations : []).map((a: any) => a.id));
      let changed = false;
      for (const alloc of allocations) {
        if ((alloc.nodeId === server.nodeId && alloc.port === Number(server.port)) || extraIds.has(alloc.id)) {
          alloc.assigned = false;
          changed = true;
        }
      }
      if (changed) await writeJSON("allocations.json", allocations);
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
    } finally {
      deleteLock.release();
    }
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
