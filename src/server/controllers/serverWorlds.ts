import { Request, Response } from "express";
import { readJSON } from "../services/db.js";
import fs from "fs-extra";
import path from "path";
import { ZipArchive } from "archiver";
import extract from "../utils/safeZip.js";
import nbt from "prismarine-nbt";
import { promisify } from "util";
import { isInside, serverRoot } from "../utils/security.js";

// Merged from Jtg panel: reads a world's level.dat via real NBT parsing so
// the World Manager can show the actual Minecraft version / data version /
// in-game world name instead of just the folder name.
const parseLevelDatNbt = promisify(nbt.parse);

async function readWorldNbtInfo(worldDir: string): Promise<{ worldVersion: string; dataVersion: number; worldName: string } | null> {
  const levelDatPath = path.join(worldDir, "level.dat");
  if (!(await fs.pathExists(levelDatPath))) return null;
  try {
    const buffer = await fs.readFile(levelDatPath);
    const { parsed } = (await parseLevelDatNbt(buffer)) as any;
    const data = parsed?.value?.Data?.value;
    if (!data) return null;
    return {
      worldVersion: data.Version?.value?.Name?.value || "Unknown",
      dataVersion: data.DataVersion?.value || 0,
      worldName: data.LevelName?.value || "",
    };
  } catch (err) {
    console.warn("Could not read level.dat NBT for", worldDir, err);
    return null;
  }
}

/* World manager: worlds, CurseForge worlds, game rules. */
// ---- World Manager (Java-style top-level world folders + Bedrock's
// worlds/<name> convention) ----

async function findWorldRoots(id: string): Promise<{ dir: string; bedrockStyle: boolean }[]> {
  const base = serverRoot(id);
  const roots: { dir: string; bedrockStyle: boolean }[] = [{ dir: base, bedrockStyle: false }];
  const bedrockWorldsDir = path.join(base, "worlds");
  if (await fs.pathExists(bedrockWorldsDir)) {
    roots.push({ dir: bedrockWorldsDir, bedrockStyle: true });
  }
  return roots;
}

async function getActiveLevelName(id: string): Promise<string | null> {
  const propsPath = path.join(serverRoot(id), "server.properties");
  try {
    const content = await fs.readFile(propsPath, "utf8");
    const match = content.match(/^level-name=(.*)$/m);
    return match ? match[1].trim() : null;
  } catch (e) {
    return null;
  }
}

export const getWorlds = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const activeLevelName = await getActiveLevelName(id);
    const worlds: any[] = [];

    for (const { dir, bedrockStyle } of await findWorldRoots(id)) {
      if (!(await fs.pathExists(dir))) continue;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const worldDir = path.join(dir, entry.name);
        const hasLevelDat = await fs.pathExists(path.join(worldDir, "level.dat"));
        if (!hasLevelDat) continue;
        const stat = await fs.stat(worldDir);
        const nbtInfo = await readWorldNbtInfo(worldDir);
        worlds.push({
          name: entry.name,
          bedrockStyle,
          active: entry.name === activeLevelName,
          modifiedAt: stat.mtime,
          worldName: nbtInfo?.worldName || undefined,
          worldVersion: nbtInfo?.worldVersion || undefined,
          dataVersion: nbtInfo?.dataVersion || undefined,
        });
      }
    }

    res.json({ worlds, activeLevelName });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to list worlds" });
  }
};

export const uploadWorld = async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  try {
    const baseDir = serverRoot(id);
    const worldName = (req.body.worldName || path.basename(req.file.originalname, path.extname(req.file.originalname))).replace(/[^a-zA-Z0-9_\-.]/g, "_");
    const isBedrock = req.body.bedrockStyle === "true" || req.body.bedrockStyle === true;
    const destDir = isBedrock ? path.join(baseDir, "worlds", worldName) : path.join(baseDir, worldName);

    if (!isInside(baseDir, destDir)) return res.status(403).json({ error: "Invalid world name" });

    await fs.ensureDir(path.dirname(destDir));
    await fs.remove(destDir);
    await fs.ensureDir(destDir);
    await extract(req.file.path, { dir: destDir });
    await fs.remove(req.file.path).catch(() => {});

    // A .zip of a world folder is very commonly one extra level deep
    // (zip contains a single top-level folder that itself has level.dat) —
    // flatten that automatically so the world is usable without the user
    // needing to know or fix this themselves.
    const entries = await fs.readdir(destDir);
    if (entries.length === 1) {
      const inner = path.join(destDir, entries[0]);
      const innerStat = await fs.stat(inner);
      if (innerStat.isDirectory() && (await fs.pathExists(path.join(inner, "level.dat")))) {
        const tmp = destDir + "-tmp";
        await fs.move(inner, tmp);
        await fs.remove(destDir);
        await fs.move(tmp, destDir);
      }
    }

    res.json({ success: true, worldName });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to upload world" });
  }
};

export const switchWorld = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { worldName } = req.body;
    if (!worldName) return res.status(400).json({ error: "worldName is required" });

    const propsPath = path.join(serverRoot(id), "server.properties");
    let content = "";
    try {
      content = await fs.readFile(propsPath, "utf8");
    } catch (e) {
      content = "";
    }
    if (/^level-name=/m.test(content)) {
      content = content.replace(/^level-name=.*$/m, `level-name=${worldName}`);
    } else {
      content += `${content.endsWith("\n") || content === "" ? "" : "\n"}level-name=${worldName}\n`;
    }
    await fs.writeFile(propsPath, content, "utf8");
    res.json({ success: true, activeLevelName: worldName });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to switch world" });
  }
};

export const downloadWorld = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { worldName, bedrockStyle } = req.query;
    if (!worldName) return res.status(400).json({ error: "worldName is required" });

    const baseDir = serverRoot(id);
    const worldDir = bedrockStyle === "true"
      ? path.join(baseDir, "worlds", String(worldName))
      : path.join(baseDir, String(worldName));
    if (!isInside(baseDir, worldDir) || !(await fs.pathExists(worldDir))) {
      return res.status(404).json({ error: "World not found" });
    }

    res.attachment(`${worldName}.zip`);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    archive.on("error", (err: any) => { if (!res.headersSent) res.status(500).json({ error: err.message }); });
    archive.pipe(res);
    archive.directory(worldDir, String(worldName));
    await archive.finalize();
  } catch (err: any) {
    if (!res.headersSent) res.status(500).json({ error: err.message || "Failed to download world" });
  }
};

export const deleteWorld = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { worldName, bedrockStyle } = req.body;
    if (!worldName) return res.status(400).json({ error: "worldName is required" });

    const baseDir = serverRoot(id);
    const worldDir = bedrockStyle ? path.join(baseDir, "worlds", worldName) : path.join(baseDir, worldName);
    if (!isInside(baseDir, worldDir)) return res.status(403).json({ error: "Invalid path" });

    await fs.remove(worldDir);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to delete world" });
  }
};

// ---- World Manager: CurseForge world browsing/install ----

const CURSEFORGE_MINECRAFT_GAME_ID = 432;
const CURSEFORGE_WORLDS_CLASS_ID = 17;

async function getCurseForgeApiKey(): Promise<string | null> {
  const settings = (await readJSON("settings.json")) as any;
  return settings?.curseforgeApiKey || process.env.CURSEFORGE_API_KEY || null;
}

export const searchCurseForgeWorlds = async (req: Request, res: Response) => {
  const apiKey = await getCurseForgeApiKey();
  if (!apiKey) {
    return res.status(501).json({ error: "CurseForge browsing isn't set up yet. Ask an admin to add a CurseForge API key under Admin Panel → API Keys." });
  }
  try {
    const axios = (await import("axios")).default;
    const q = String(req.query.q || "");
    const page = Math.max(0, parseInt(String(req.query.page || "0"), 10) || 0);
    const pageSize = 12;
    const result = await axios.get("https://api.curseforge.com/v1/mods/search", {
      headers: { "x-api-key": apiKey, Accept: "application/json" },
      params: {
        gameId: CURSEFORGE_MINECRAFT_GAME_ID,
        classId: CURSEFORGE_WORLDS_CLASS_ID,
        searchFilter: q || undefined,
        sortField: q ? 2 : 6, // 2 = popularity, 6 = total downloads (default browse = most downloaded)
        sortOrder: "desc",
        pageSize,
        index: page * pageSize,
      },
    });
    const worlds = (result.data?.data || []).map((m: any) => ({
      id: m.id,
      name: m.name,
      summary: m.summary,
      author: m.authors?.[0]?.name || "Unknown",
      logo: m.logo?.thumbnailUrl || m.logo?.url || null,
      downloadCount: m.downloadCount || 0,
      websiteUrl: m.links?.websiteUrl,
    }));
    res.json({ worlds });
  } catch (err: any) {
    res.status(500).json({ error: err.response?.data?.errorMessage || err.message || "Failed to search CurseForge worlds." });
  }
};

export const installCurseForgeWorld = async (req: Request, res: Response) => {
  const apiKey = await getCurseForgeApiKey();
  if (!apiKey) {
    return res.status(501).json({ error: "CurseForge browsing isn't set up yet. Ask an admin to add a CurseForge API key under Admin Panel → API Keys." });
  }
  const { id } = req.params;
  const { modId, worldName } = req.body;
  if (!modId) return res.status(400).json({ error: "modId is required" });

  try {
    const axios = (await import("axios")).default;
    const headers = { "x-api-key": apiKey, Accept: "application/json" };

    const filesRes = await axios.get(`https://api.curseforge.com/v1/mods/${modId}/files`, { headers, params: { pageSize: 1 } });
    const file = filesRes.data?.data?.[0];
    if (!file) return res.status(404).json({ error: "No downloadable files found for this world." });

    let downloadUrl = file.downloadUrl;
    if (!downloadUrl) {
      const urlRes = await axios.get(`https://api.curseforge.com/v1/mods/${modId}/files/${file.id}/download-url`, { headers });
      downloadUrl = urlRes.data?.data;
    }
    if (!downloadUrl) return res.status(404).json({ error: "This world's author has disabled third-party downloads." });

    const server = (await readJSON("servers.json") || []).find((s: any) => s.id === id);
    const isBedrock = (server?.type || "").toUpperCase() === "BEDROCK";
    const baseDir = serverRoot(id);
    const finalName = (worldName || file.fileName.replace(/\.(zip)$/i, "")).replace(/[^a-zA-Z0-9_\-.]/g, "_");
    const destDir = isBedrock ? path.join(baseDir, "worlds", finalName) : path.join(baseDir, finalName);
    if (!isInside(baseDir, destDir)) return res.status(403).json({ error: "Invalid world name" });

    const tmpZip = path.join(process.cwd(), ".data", "tmp", `cf-world-${Date.now()}.zip`);
    await fs.ensureDir(path.dirname(tmpZip));
    const response = await axios({ url: downloadUrl, method: "GET", responseType: "stream", headers: { "User-Agent": "XyneX-Panel/1.0" } });
    const writer = fs.createWriteStream(tmpZip);
    await new Promise<void>((resolve, reject) => {
      response.data.pipe(writer);
      writer.on("finish", () => resolve());
      writer.on("error", reject);
    });

    await fs.ensureDir(path.dirname(destDir));
    await fs.remove(destDir);
    await fs.ensureDir(destDir);
    await extract(tmpZip, { dir: destDir });
    await fs.remove(tmpZip).catch(() => {});

    // Flatten a single nested top-level folder, same as manual world uploads.
    const entries = await fs.readdir(destDir);
    if (entries.length === 1) {
      const inner = path.join(destDir, entries[0]);
      const innerStat = await fs.stat(inner);
      if (innerStat.isDirectory() && (await fs.pathExists(path.join(inner, "level.dat")))) {
        const tmp = destDir + "-tmp";
        await fs.move(inner, tmp);
        await fs.remove(destDir);
        await fs.move(tmp, destDir);
      }
    }

    res.json({ success: true, worldName: finalName });
  } catch (err: any) {
    res.status(500).json({ error: err.response?.data?.errorMessage || err.message || "Failed to install world from CurseForge." });
  }
};

// ---- World Manager: World Settings + Game Rules (datapack-based) ----

const GAME_RULE_DEFS: { key: string; type: "boolean" | "number"; default: string }[] = [
  { key: "keepInventory", type: "boolean", default: "false" },
  { key: "doDaylightCycle", type: "boolean", default: "true" },
  { key: "doWeatherCycle", type: "boolean", default: "true" },
  { key: "doMobSpawning", type: "boolean", default: "true" },
  { key: "mobGriefing", type: "boolean", default: "true" },
  { key: "doFireTick", type: "boolean", default: "true" },
  { key: "naturalRegeneration", type: "boolean", default: "true" },
  { key: "doMobLoot", type: "boolean", default: "true" },
  { key: "doTileDrops", type: "boolean", default: "true" },
  { key: "announceAdvancements", type: "boolean", default: "true" },
  { key: "randomTickSpeed", type: "number", default: "3" },
  { key: "spawnRadius", type: "number", default: "10" },
  { key: "maxEntityCramming", type: "number", default: "24" },
];

const GAMERULES_PACK_NAME = "world-manager-gamerules";

async function getActiveWorldDir(id: string): Promise<{ dir: string; name: string } | null> {
  const activeLevelName = await getActiveLevelName(id);
  const levelName = activeLevelName || "world";
  for (const { dir, bedrockStyle } of await findWorldRoots(id)) {
    if (bedrockStyle) continue; // datapacks are a Java Edition feature only
    const worldDir = path.join(dir, levelName);
    if (await fs.pathExists(path.join(worldDir, "level.dat"))) {
      return { dir: worldDir, name: levelName };
    }
  }
  return null;
}

function gamerulesFunctionPath(worldDir: string, tagFolder: "function" | "functions") {
  const packDir = path.join(worldDir, "datapacks", GAMERULES_PACK_NAME);
  return {
    packDir,
    mcmeta: path.join(packDir, "pack.mcmeta"),
    fn: path.join(packDir, "data", GAMERULES_PACK_NAME, tagFolder === "function" ? "function" : "functions", "apply.mcfunction"),
    tag: path.join(packDir, "data", "minecraft", "tags", tagFolder, "load.json"),
  };
}

export const getGameRules = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const active = await getActiveWorldDir(id);
    const rules: Record<string, string> = {};
    for (const def of GAME_RULE_DEFS) rules[def.key] = def.default;

    if (active) {
      const { fn } = gamerulesFunctionPath(active.dir, "functions");
      const altFn = gamerulesFunctionPath(active.dir, "function").fn;
      const content = (await fs.pathExists(fn)) ? await fs.readFile(fn, "utf8") : (await fs.pathExists(altFn)) ? await fs.readFile(altFn, "utf8") : null;
      if (content) {
        for (const line of content.split("\n")) {
          const match = line.trim().match(/^gamerule\s+(\w+)\s+(\S+)$/);
          if (match && rules[match[1]] !== undefined) rules[match[1]] = match[2];
        }
      }
    }

    res.json({ rules, worldName: active?.name || null });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to load game rules" });
  }
};

export const saveGameRules = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { rules } = req.body;
    if (!rules || typeof rules !== "object") return res.status(400).json({ error: "rules object is required" });

    const active = await getActiveWorldDir(id);
    if (!active) return res.status(404).json({ error: "No active world found. Start the server once to generate a world." });

    const lines = GAME_RULE_DEFS.map((def) => {
      const value = rules[def.key] !== undefined ? String(rules[def.key]) : def.default;
      return `gamerule ${def.key} ${value}`;
    });
    const fnContent = lines.join("\n") + "\n";
    const mcmeta = JSON.stringify({ pack: { pack_format: 48, supported_formats: { min_inclusive: 4, max_inclusive: 100 }, description: "World Manager - auto-applied game rules" } }, null, 2);
    const tagJson = JSON.stringify({ values: [`${GAMERULES_PACK_NAME}:apply`] }, null, 2);

    // Write both the modern ("function") and legacy ("functions") datapack
    // folder layouts so this works whether the server is on 1.21+ or older.
    for (const tagFolder of ["function", "functions"] as const) {
      const { mcmeta: mcmetaPath, fn, tag } = gamerulesFunctionPath(active.dir, tagFolder);
      await fs.ensureDir(path.dirname(fn));
      await fs.ensureDir(path.dirname(tag));
      await fs.writeFile(mcmetaPath, mcmeta, "utf8");
      await fs.writeFile(fn, fnContent, "utf8");
      await fs.writeFile(tag, tagJson, "utf8");
    }

    res.json({ success: true, worldName: active.name });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to save game rules" });
  }
};

