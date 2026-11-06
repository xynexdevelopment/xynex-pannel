import { Request, Response } from "express";
import { readJSON, writeJSON } from "../services/db.js";
import { createServerContainer, startContainer, stopContainer, restartContainer, killContainer, sendContainerCommand, attachContainerSocket, execRconCommand } from "../services/docker.js";
import { logActivity, requestActor } from "../services/activityLog.js";


/* Start / stop / restart / console command / RCON / players. */
export const startServer = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const servers = await readJSON("servers.json") || [];
    
    const server = servers.find((s) => s.id === id);
    if (!server || !server.containerId) {
      return res.status(404).json({ error: "Not found" });
    }
    if (server.suspended) {
      return res.status(403).json({ error: "Server is suspended" });
    }

    try {
      const io = req.app.get("io");
      if (io) io.to(`server_${id}`).emit("clear_logs");
      
      await startContainer(server.containerId);
    } catch (startErr: any) {
      if (startErr.statusCode === 404 || (startErr.message && startErr.message.toLowerCase().includes("no such container"))) {
        console.log(`Container missing for server ${server.id}. Recreating...`);
        let egg: any = null;
        if (server.eggId) {
          const eggs = await readJSON("eggs.json") || [];
          egg = eggs.find((e: any) => e.id === server.eggId);
        }
        server.containerId = await createServerContainer(server, egg);
        await writeJSON("servers.json", servers);
        await startContainer(server.containerId);
      } else {
        throw startErr;
      }
    }
    await attachContainerSocket(server.containerId, server.id);
    logActivity({ ...requestActor(req), serverId: server.id, serverName: server.name, action: "server.start", description: `Started server "${server.name}"` });
    res.json({ success: true });
  } catch (err: any) {
    console.error("Start server error:", err);
    res.status(500).json({ error: err.message || "Failed to start server" });
  }
};

export const stopServer = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const servers = await readJSON("servers.json") || [];
    const server = servers.find((s: any) => s.id === id);
    if (!server || !server.containerId) {
      return res.status(404).json({ error: "Not found" });
    }
    try {
      await stopContainer(server.containerId);
    } catch (stopErr: any) {
      if (stopErr.statusCode === 404 || (stopErr.message && stopErr.message.toLowerCase().includes("no such container"))) {
        console.log(`Container already missing for server ${server.id}. Assuming stopped.`);
      } else {
        throw stopErr;
      }
    }
    logActivity({ ...requestActor(req), serverId: server.id, serverName: server.name, action: "server.stop", description: `Stopped server "${server.name}"` });
    res.json({ success: true });
  } catch (err: any) {
    console.error("Stop server error:", err);
    res.status(500).json({ error: err.message || "Failed to stop server" });
  }
};

export const terminateServer = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const user = (req as any).user;

    if (user.role !== "admin" && user.role !== "owner") {
      return res.status(403).json({ error: "Only admins can terminate servers" });
    }

    const servers = await readJSON("servers.json") || [];
    const server = servers.find((s: any) => s.id === id);
    if (!server || !server.containerId) {
      return res.status(404).json({ error: "Not found" });
    }

    await killContainer(server.containerId);

    const io = req.app.get("io");
    if (io) io.to(`server_${id}`).emit("log", `[System] Server was forcefully terminated by an admin.\r\n`);

    logActivity({ ...requestActor(req), serverId: server.id, serverName: server.name, action: "server.terminate", description: `Forcefully terminated server "${server.name}"` });
    res.json({ success: true });
  } catch (err: any) {
    console.error("Terminate server error:", err);
    res.status(500).json({ error: err.message || "Failed to terminate server" });
  }
};

export const restartServer = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const servers = await readJSON("servers.json") || [];
    const server = servers.find((s: any) => s.id === id);
    if (!server || !server.containerId) {
      return res.status(404).json({ error: "Not found" });
    }
    try {
      const io = req.app.get("io");
      if (io) io.to(`server_${id}`).emit("clear_logs");

      await restartContainer(server.containerId);
    } catch (startErr: any) {
      if (startErr.statusCode === 404 || (startErr.message && startErr.message.toLowerCase().includes("no such container"))) {
        console.log(`Container missing for server ${server.id}. Recreating...`);
        let egg: any = null;
        if (server.eggId) {
          const eggs = await readJSON("eggs.json") || [];
          egg = eggs.find((e: any) => e.id === server.eggId);
        }
        server.containerId = await createServerContainer(server, egg);
        await writeJSON("servers.json", servers);
        await startContainer(server.containerId);
      } else {
        throw startErr;
      }
    }
    await attachContainerSocket(server.containerId, server.id);
    logActivity({ ...requestActor(req), serverId: server.id, serverName: server.name, action: "server.restart", description: `Restarted server "${server.name}"` });
    res.json({ success: true });
  } catch (err: any) {
    console.error("Restart server error:", err);
    res.status(500).json({ error: err.message || "Failed to restart server" });
  }
};

export const sendCommand = async (req: Request, res: Response) => {
  
  try {
    const { id } = req.params;
    const { command } = req.body;
    const servers = await readJSON("servers.json") || [];
    const server = servers.find((s: any) => s.id === id);
    if (!server || !server.containerId) {
      return res.status(404).json({ error: "Not found" });
    }
    await sendContainerCommand(server.containerId, command);
    res.json({ success: true });
  } catch (err: any) {
    console.error("Command error:", err);
    res.status(500).json({ error: err.message || "Failed to send command" });
  }
};

// Runs an RCON command and returns its output — used by extensions (and
// the players list below) that need to show a result, not just fire a
// one-way command like sendCommand does.
export const runRcon = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { id } = req.params;
    const { command } = req.body;
    if (!command) return res.status(400).json({ error: "Missing command" });

    const servers = await readJSON("servers.json") || [];
    const server = servers.find((s: any) => s.id === id);
    if (!server) return res.status(404).json({ error: "Server not found" });
    if (user.role !== "admin" && user.role !== "owner" && server.owner !== user.id) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (!server.containerId) return res.status(400).json({ error: "Server has no container" });

    const output = await execRconCommand(server.containerId, command);
    res.json({ output });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to run RCON command" });
  }
};

// Parses "There are 2 of a max of 20 players online: Alice, Bob" into a
// clean player list for the Players tab.
export const getPlayers = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { id } = req.params;
    const servers = await readJSON("servers.json") || [];
    const server = servers.find((s: any) => s.id === id);
    if (!server) return res.status(404).json({ error: "Server not found" });
    if (user.role !== "admin" && user.role !== "owner" && server.owner !== user.id) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (!server.containerId || server.status !== "online") {
      return res.json({ players: [] });
    }

    const output = await execRconCommand(server.containerId, "list");
    const colonIndex = output.indexOf(":");
    const namesPart = colonIndex !== -1 ? output.slice(colonIndex + 1) : "";
    const players = namesPart
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean)
      .map((name) => ({ name }));

    res.json({ players });
  } catch (err: any) {
    res.status(200).json({ players: [], error: err.message });
  }
};

// Downloads a file (plugin jar, mod, config, etc.) into a server's data
// directory — used by extensions' "download_install" sections. Admin-only
// since it's an arbitrary URL fetch onto the host filesystem.
