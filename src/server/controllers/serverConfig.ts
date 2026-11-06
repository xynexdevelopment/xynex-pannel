import { Request, Response } from "express";
import { readJSON, writeJSON } from "../services/db.js";
import { createServerContainer, stopContainer, deleteContainer, getContainerStatus } from "../services/docker.js";
import fs from "fs-extra";
import path from "path";
import { notifyDiscord } from "../services/discordWebhook.js";
import { serverRoot } from "../utils/security.js";


/* Startup variables, version change, extension install, resources, suspension, expiry. */
export const installExtensionItem = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (user.role !== "admin" && user.role !== "owner") {
      return res.status(403).json({ error: "Admin access only" });
    }

    const { id } = req.params;
    let { url, filename } = req.body;
    const { targetDir, modrinthProject, loaders } = req.body;
    const axios = (await import("axios")).default;

    // Resolve a Modrinth project slug to the newest file that matches this
    // server's loader (paper/fabric/forge...) and Minecraft version, instead of
    // blindly taking the newest upload (which could be for another loader).
    if (!url && modrinthProject) {
      const slug = String(modrinthProject);
      if (!/^[a-zA-Z0-9_-]{2,64}$/.test(slug)) return res.status(400).json({ error: "Invalid Modrinth project id" });

      const loaderList = Array.isArray(loaders) ? loaders.map((l: any) => String(l).toLowerCase()).filter((l: string) => /^[a-z]+$/.test(l)) : [];
      const serverRec = (await readJSON("servers.json") || []).find((x: any) => x.id === id);
      const mcVersion = serverRec?.version && !/^latest$/i.test(String(serverRec.version)) ? String(serverRec.version) : "";

      const fetchVersions = async (withGameVersion: boolean) => {
        const params: Record<string, string> = {};
        if (loaderList.length) params.loaders = JSON.stringify(loaderList);
        if (withGameVersion && mcVersion) params.game_versions = JSON.stringify([mcVersion]);
        const r = await axios.get(`https://api.modrinth.com/v2/project/${slug}/version`, {
          params, timeout: 15000, headers: { "User-Agent": "xynex-panel/1.0 (extension installer)" },
        });
        return Array.isArray(r.data) ? r.data : [];
      };

      let versions: any[] = [];
      try {
        versions = await fetchVersions(true);
        if (!versions.length && mcVersion) versions = await fetchVersions(false);
      } catch (e: any) {
        if (e.response?.status === 404) return res.status(404).json({ error: `"${slug}" was not found on Modrinth` });
        return res.status(502).json({ error: "Could not reach Modrinth. Try again in a moment." });
      }

      const latest = versions[0];
      const file = latest?.files?.find((f: any) => f.primary) || latest?.files?.[0];
      if (!file) {
        const what = loaderList.length ? ` for ${loaderList.join("/")}${mcVersion ? ` ${mcVersion}` : ""}` : "";
        return res.status(404).json({ error: `No downloadable file found for "${slug}"${what}` });
      }
      url = file.url;
      filename = filename || file.filename;
    }

    if (!url || !filename) return res.status(400).json({ error: "Missing url/modrinthProject or filename" });
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: "Only http/https URLs are allowed" });

    const safeDir = String(targetDir || "plugins").replace(/[^a-zA-Z0-9_-]/g, "");
    const safeFilename = String(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
    if (!/\.(jar|zip|mrpack)$/i.test(safeFilename)) {
      return res.status(400).json({ error: "Only .jar, .zip, or .mrpack files are allowed" });
    }

    const serverDir = serverRoot(id);
    const destDir = path.join(serverDir, safeDir);
    await fs.ensureDir(destDir);
    const destPath = path.join(destDir, safeFilename);

    {
      // Block internal addresses (localhost, LAN, cloud metadata) even for admin-supplied URLs.
      const { assertPublicHttpUrl } = await import("../utils/security.js");
      try { await assertPublicHttpUrl(String(url)); } catch (e: any) { return res.status(400).json({ error: e.message }); }
    }
    const response = await axios({ url, method: "GET", responseType: "stream", maxContentLength: 500 * 1024 * 1024, timeout: 60000 });
    const writer = fs.createWriteStream(destPath);
    response.data.pipe(writer);
    await new Promise<void>((resolve, reject) => { writer.on("finish", resolve); writer.on("error", reject); });

    res.json({ success: true, path: `${safeDir}/${safeFilename}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to install file" });
  }
};

// Sends a test vote via the NuVotifier V2 protocol to verify a vote
// listener is reachable/configured correctly. host/port/token are
// whatever the admin/owner types in (usually this server's own votifier
// port, but could be any target) — not read from the server's container.
export const testVotifier = async (req: Request, res: Response) => {
  try {
    const { host, port, token, serviceName, username } = req.body;
    if (!host || !port || !token) {
      return res.status(400).json({ error: "host, port, and token are required" });
    }
    const { sendTestVote } = await import("../services/votifier.js");
    const result = await sendTestVote({ host, port: Number(port), token, serviceName, username });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to send test vote" });
  }
};

export const changeServerVersion = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { version, type, wipeData, eggId } = req.body;
    const user = (req as any).user;
    
    if (!version) return res.status(400).json({ error: "Version is required" });
    
    const servers = await readJSON("servers.json") || [];
    const server = servers.find((s: any) => s.id === id);
    
    if (!server) {
      return res.status(404).json({ error: "Server not found" });
    }

    if (user.role !== "admin" && user.role !== "owner" && server.owner !== user.id) {
      return res.status(403).json({ error: "Only admins or owners can change version" });
    }

    if (server.containerId) {
      const status = await getContainerStatus(server.containerId);
      if (status?.State?.Running) {
        return res.status(400).json({ error: "Server must be stopped before changing version. Please stop the server first." });
      }
      // Delete old container
      await deleteContainer(server.containerId);
    }
    
    const serverDir = serverRoot(id);

    if (wipeData) {
      // Full wipe requested: clear out the entire server data directory
      // (world, plugins, mods, config — everything) before reinstalling.
      try {
        await fs.emptyDir(serverDir);
      } catch (e) {
        console.error("Failed to wipe server data", e);
      }
    } else {
      // Keep existing data, but automatically delete config files that are
      // known to cause issues when switching versions/software types.
      const filesToDelete = [
        "paper-global.yml", "paper-world-defaults.yml", "paper.yml",
        "config/paper-global.yml", "config/paper-world-defaults.yml",
        "world/data/random_sequences.dat"
      ];

      for (const file of filesToDelete) {
        const filePath = path.join(serverDir, file);
        try {
          if (await fs.pathExists(filePath)) {
            await fs.remove(filePath);
          }
        } catch (e) {
          console.error(`Failed to delete ${file}`, e);
        }
      }
    }
    
    // Look up the selected egg (server software), if the request came from
    // the Versions tab / egg system rather than the legacy type dropdown.
    let egg: any = null;
    if (eggId) {
      const eggs = await readJSON("eggs.json") || [];
      egg = eggs.find((e: any) => e.id === eggId);
    }

    server.version = version;
    if (egg) {
      server.eggId = egg.id;
      server.eggName = egg.name;
      server.category = egg.category;
      server.type = type || egg.name;
    } else if (type) {
      server.type = type;
    }
    // Recreate container with new version env. A version change means the
    // egg's installation script (if any) needs to run again to fetch the
    // newly-selected version's server software.
    server.installed = false;
    const newContainerId = await createServerContainer(server, egg);
    server.containerId = newContainerId;
    
    await writeJSON("servers.json", servers);
    
    res.json({ success: true, version, type: server.type, wiped: !!wipeData });
  } catch (err: any) {
    console.error("Change version error", err);
    res.status(500).json({ error: err.message });
  }
};

// Renders an egg's startup template by substituting {{VARIABLE}} tokens
// with the current value (server override, falling back to the egg's
// defaultValue, falling back to an empty string).
function renderStartup(template: string, values: Record<string, string>): string {
  if (!template) return "";
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_match, key) => {
    return values[key] !== undefined ? String(values[key]) : "";
  });
}

// Returns the server's rendered startup command plus every variable the
// egg exposes (with the server's current override applied), so the
// Startup tab can show exactly what the egg makes available.
export const getStartup = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const servers = await readJSON("servers.json") || [];
    const server = servers.find((s: any) => s.id === id);
    if (!server) return res.status(404).json({ error: "Server not found" });

    let egg: any = null;
    if (server.eggId) {
      const eggs = await readJSON("eggs.json") || [];
      egg = eggs.find((e: any) => e.id === server.eggId);
    }

    const eggVariables = Array.isArray(egg?.variables) ? egg.variables : [];
    const overrides = server.variables && typeof server.variables === "object" ? server.variables : {};

    const values: Record<string, string> = {};
    for (const v of eggVariables) {
      values[v.envVariable] = overrides[v.envVariable] !== undefined ? String(overrides[v.envVariable]) : String(v.defaultValue ?? "");
    }

    const variables = eggVariables.map((v: any) => ({
      name: v.name,
      envVariable: v.envVariable,
      description: v.description || "",
      defaultValue: v.defaultValue ?? "",
      editable: !!v.editable,
      value: values[v.envVariable] ?? "",
    }));

    res.json({
      eggName: egg?.name || server.eggName || server.type || "",
      startup: egg?.startup ? renderStartup(egg.startup, values) : "",
      raw: egg?.startup || "",
      variables,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

// Saves user-editable variable overrides for a server. Non-editable
// variables are silently ignored so users can't change locked settings
// (e.g. TYPE, EULA) through this endpoint. Changes take effect the next
// time the server's container is (re)created — start/restart alone
// doesn't recreate the container, so this only updates the stored value.
export const updateStartup = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { variables } = req.body;
    const user = (req as any).user;

    if (!variables || typeof variables !== "object") {
      return res.status(400).json({ error: "variables object is required" });
    }

    const servers = await readJSON("servers.json") || [];
    const server = servers.find((s: any) => s.id === id);
    if (!server) return res.status(404).json({ error: "Server not found" });

    if (user.role !== "admin" && user.role !== "owner" && server.owner !== user.id) {
      return res.status(403).json({ error: "Only admins or owners can edit startup variables" });
    }

    let egg: any = null;
    if (server.eggId) {
      const eggs = await readJSON("eggs.json") || [];
      egg = eggs.find((e: any) => e.id === server.eggId);
    }
    const eggVariables = Array.isArray(egg?.variables) ? egg.variables : [];
    const editableKeys = new Set(eggVariables.filter((v: any) => v.editable).map((v: any) => v.envVariable));

    if (!server.variables) server.variables = {};
    for (const [key, value] of Object.entries(variables)) {
      if (editableKeys.has(key)) {
        server.variables[key] = String(value);
      }
    }

    await writeJSON("servers.json", servers);
    res.json({ success: true, variables: server.variables });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

// File manager handlers live in ./serverFiles.ts (re-exported so routes and imports are unchanged).
export * from "./serverFiles.js";

export const updateResources = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { ram, cpu, disk } = req.body;
    const servers = await readJSON("servers.json") || [];
    const server = servers.find((s: any) => s.id === id);
    if (!server) return res.status(404).json({ error: "Server not found" });
    if ((req as any).user.role !== "admin") return res.status(403).json({ error: "Unauthorized" });

    server.ram = Number(ram);
    server.cpu = Number(cpu);
    server.disk = Number(disk);

    // Recreate the container so the new limits actually take effect —
    // just stopping the old one (previous behavior) left it running with
    // its original limits baked in the next time it was started.
    let egg: any = null;
    if (server.eggId) {
      const eggs = await readJSON("eggs.json") || [];
      egg = eggs.find((e: any) => e.id === server.eggId);
    }
    if (server.containerId) {
      try { await deleteContainer(server.containerId); } catch (e) { console.error("Failed to remove old container", e); }
    }
    try {
      server.containerId = await createServerContainer(server, egg);
    } catch (e) {
      console.error("Failed to recreate container with new resource limits", e);
    }

    await writeJSON("servers.json", servers);
    res.json(server);
  } catch (error) {
    res.status(500).json({ error: "Failed to update resources" });
  }
};

export const updateSuspend = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { suspendDuration } = req.body; // permanent, 1_month, 2_months, 24_hours, 1_week, or null
    const servers = await readJSON("servers.json") || [];
    const server = servers.find((s: any) => s.id === id);
    if (!server) return res.status(404).json({ error: "Server not found" });
    if ((req as any).user.role !== "admin") return res.status(403).json({ error: "Unauthorized" });

    server.suspended = suspendDuration !== null;
    server.suspendDuration = suspendDuration;
    await writeJSON("servers.json", servers);

    notifyDiscord({
      title: server.suspended ? "⏸️ Server Suspended" : "▶️ Server Unsuspended",
      description: `**${server.name}** was ${server.suspended ? "suspended" : "unsuspended"}.`,
      color: server.suspended ? 0xf59e0b : 0x22c55e,
    });

    if (server.suspended && server.containerId) {
       try {
         await stopContainer(server.containerId);
       } catch(e) {}
    }

    res.json(server);
  } catch (error) {
    res.status(500).json({ error: "Failed to suspend server" });
  }
};

// Sets or clears a server's auto-suspension date (see services/scheduler.ts,
// which checks this on an interval and suspends the server once it passes).
export const updateExpiration = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { expirationDate } = req.body; // ISO date string, or null to clear
    if ((req as any).user.role !== "admin") return res.status(403).json({ error: "Unauthorized" });

    const servers = await readJSON("servers.json") || [];
    const server = servers.find((s: any) => s.id === id);
    if (!server) return res.status(404).json({ error: "Server not found" });

    server.expirationDate = expirationDate || null;
    await writeJSON("servers.json", servers);
    res.json(server);
  } catch (error) {
    res.status(500).json({ error: "Failed to update expiration date" });
  }
};

