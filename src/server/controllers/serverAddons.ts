import { Request, Response } from "express";
import crypto from "crypto";
import fs from "fs-extra";
import path from "path";
import extract from "../utils/safeZip.js";
import { isInside, serverRoot } from "../utils/security.js";


/* Bedrock addons (.mcpack / .mcaddon). */
// ---- Bedrock Addons (.mcpack / .mcaddon behavior & resource packs) ----

async function readPackManifest(packDir: string): Promise<any | null> {
  try {
    return await fs.readJson(path.join(packDir, "manifest.json"));
  } catch (e) {
    return null;
  }
}

function packKind(manifest: any): "behavior" | "resource" | null {
  const modules = manifest?.modules || [];
  if (modules.some((m: any) => m.type === "data" || m.type === "script")) return "behavior";
  if (modules.some((m: any) => m.type === "resources")) return "resource";
  return null;
}

async function registerPack(worldDir: string, kind: "behavior" | "resource", manifest: any) {
  const file = path.join(worldDir, kind === "behavior" ? "world_behavior_packs.json" : "world_resource_packs.json");
  let list: any[] = [];
  try { list = await fs.readJson(file); } catch (e) { list = []; }
  const packId = manifest?.header?.uuid;
  const version = manifest?.header?.version || [1, 0, 0];
  if (!packId) return;
  list = list.filter((p: any) => p.pack_id !== packId);
  list.push({ pack_id: packId, version });
  await fs.writeJson(file, list, { spaces: 2 });
}

async function unregisterPack(worldDir: string, kind: "behavior" | "resource", packId: string) {
  const file = path.join(worldDir, kind === "behavior" ? "world_behavior_packs.json" : "world_resource_packs.json");
  let list: any[] = [];
  try { list = await fs.readJson(file); } catch (e) { return; }
  list = list.filter((p: any) => p.pack_id !== packId);
  await fs.writeJson(file, list, { spaces: 2 });
}

export const getAddons = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { worldName } = req.query;
    if (!worldName) return res.status(400).json({ error: "worldName is required" });
    const worldDir = path.join(serverRoot(id), "worlds", String(worldName));

    const addons: any[] = [];
    for (const kind of ["behavior_packs", "resource_packs"] as const) {
      const dir = path.join(worldDir, kind);
      if (!(await fs.pathExists(dir))) continue;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const manifest = await readPackManifest(path.join(dir, entry.name));
        if (!manifest) continue;
        addons.push({
          folder: entry.name,
          kind: kind === "behavior_packs" ? "behavior" : "resource",
          name: manifest?.header?.name || entry.name,
          description: manifest?.header?.description || "",
          version: (manifest?.header?.version || []).join("."),
          packId: manifest?.header?.uuid,
        });
      }
    }
    res.json({ addons });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to list addons" });
  }
};

export const uploadAddon = async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const { worldName } = req.body;
  if (!worldName) return res.status(400).json({ error: "worldName is required" });

  try {
    const worldDir = path.join(serverRoot(id), "worlds", String(worldName));
    if (!(await fs.pathExists(worldDir))) return res.status(404).json({ error: "World not found" });

    // .mcaddon can bundle several packs; .mcpack is always exactly one.
    // Both are plain zip files under the hood, so extract to a scratch
    // folder first and then sort out what's inside.
    const scratchDir = path.join(process.cwd(), ".data", "temp", `addon-${crypto.randomUUID()}`);
    await fs.ensureDir(scratchDir);
    await extract(req.file.path, { dir: scratchDir });
    await fs.remove(req.file.path).catch(() => {});

    // Find every folder (including the scratch root itself) that has its
    // own manifest.json — that's one pack.
    const candidateDirs: string[] = [];
    const topEntries = await fs.readdir(scratchDir, { withFileTypes: true });
    if (await fs.pathExists(path.join(scratchDir, "manifest.json"))) {
      candidateDirs.push(scratchDir);
    } else {
      for (const entry of topEntries) {
        if (entry.isDirectory() && (await fs.pathExists(path.join(scratchDir, entry.name, "manifest.json")))) {
          candidateDirs.push(path.join(scratchDir, entry.name));
        }
      }
    }

    if (candidateDirs.length === 0) {
      await fs.remove(scratchDir);
      return res.status(400).json({ error: "No valid pack (manifest.json) found in the uploaded file." });
    }

    const installed: any[] = [];
    for (const packDir of candidateDirs) {
      const manifest = await readPackManifest(packDir);
      const kind = packKind(manifest);
      if (!kind) continue;
      const folderName = (manifest?.header?.name || path.basename(packDir)).replace(/[^a-zA-Z0-9_\-.]/g, "_");
      const destDir = path.join(worldDir, kind === "behavior" ? "behavior_packs" : "resource_packs", folderName);
      await fs.remove(destDir);
      await fs.ensureDir(path.dirname(destDir));
      await fs.copy(packDir, destDir);
      await registerPack(worldDir, kind, manifest);
      installed.push({ name: manifest?.header?.name || folderName, kind });
    }

    await fs.remove(scratchDir);

    if (installed.length === 0) {
      return res.status(400).json({ error: "Pack manifest didn't declare a recognizable behavior/resource module type." });
    }
    res.json({ success: true, installed });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to install addon" });
  }
};

export const deleteAddon = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { worldName, folder, kind, packId } = req.body;
    if (!worldName || !folder || !kind) return res.status(400).json({ error: "worldName, folder, and kind are required" });

    const worldDir = path.join(serverRoot(id), "worlds", String(worldName));
    const packDir = path.join(worldDir, kind === "behavior" ? "behavior_packs" : "resource_packs", folder);
    if (!isInside(worldDir, packDir)) return res.status(403).json({ error: "Invalid path" });

    await fs.remove(packDir);
    if (packId) await unregisterPack(worldDir, kind, packId);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to delete addon" });
  }
};

