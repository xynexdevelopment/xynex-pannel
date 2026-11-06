import { Request, Response } from "express";
import fs from "fs-extra";
import path from "path";
import extract from "../utils/safeZip.js";
import { promisify } from "util";
import { execFile as execFileCb } from "child_process";
const execFileAsync = promisify(execFileCb);
import { isInside, serverRoot } from "../utils/security.js";


/* FiveM / RedM resource manager. */
// ---- FiveM / RedM Resource Manager ----

async function readServerCfg(serverDir: string): Promise<string> {
  try {
    return await fs.readFile(path.join(serverDir, "server.cfg"), "utf8");
  } catch (e) {
    return "";
  }
}

function isResourceEnsured(cfg: string, name: string): boolean {
  const re = new RegExp(`^\\s*ensure\\s+${name}\\s*$`, "m");
  return re.test(cfg);
}

export const getResources = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const serverDir = serverRoot(id);
    const resourcesDir = path.join(serverDir, "resources");
    const cfg = await readServerCfg(serverDir);

    const resources: any[] = [];
    if (await fs.pathExists(resourcesDir)) {
      const entries = await fs.readdir(resourcesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        resources.push({ name: entry.name, enabled: isResourceEnsured(cfg, entry.name) });
      }
    }
    res.json({ resources });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to list resources" });
  }
};

async function ensureResourceInCfg(serverDir: string, name: string, enable: boolean) {
  const cfgPath = path.join(serverDir, "server.cfg");
  let cfg = await readServerCfg(serverDir);
  const already = isResourceEnsured(cfg, name);
  if (enable && !already) {
    cfg += `${cfg.endsWith("\n") || cfg === "" ? "" : "\n"}ensure ${name}\n`;
  } else if (!enable && already) {
    const re = new RegExp(`^\\s*ensure\\s+${name}\\s*$\\n?`, "m");
    cfg = cfg.replace(re, "");
  }
  await fs.writeFile(cfgPath, cfg, "utf8");
}

export const uploadResource = async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  try {
    const serverDir = serverRoot(id);
    const resourceName = (req.body.resourceName || path.basename(req.file.originalname, path.extname(req.file.originalname))).replace(/[^a-zA-Z0-9_-]/g, "_");
    const destDir = path.join(serverDir, "resources", resourceName);
    if (!isInside(serverDir, destDir)) return res.status(403).json({ error: "Invalid resource name" });

    await fs.remove(destDir);
    await fs.ensureDir(destDir);
    await extract(req.file.path, { dir: destDir });
    await fs.remove(req.file.path).catch(() => {});

    // Zips of a single resource are very often one folder deeper than
    // expected (contains one top-level folder with fxmanifest.lua inside).
    const entries = await fs.readdir(destDir);
    if (entries.length === 1) {
      const inner = path.join(destDir, entries[0]);
      const innerStat = await fs.stat(inner);
      if (innerStat.isDirectory()) {
        const hasManifest = (await fs.pathExists(path.join(inner, "fxmanifest.lua"))) || (await fs.pathExists(path.join(inner, "__resource.lua")));
        if (hasManifest) {
          const tmp = destDir + "-tmp";
          await fs.move(inner, tmp);
          await fs.remove(destDir);
          await fs.move(tmp, destDir);
        }
      }
    }

    await ensureResourceInCfg(serverDir, resourceName, true);
    res.json({ success: true, resourceName });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to install resource" });
  }
};

export const installResourceFromGit = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { gitUrl, resourceName: rawName } = req.body;
    if (!gitUrl) return res.status(400).json({ error: "gitUrl is required" });

    const serverDir = serverRoot(id);
    const resourceName = (rawName || path.basename(String(gitUrl), ".git")).replace(/[^a-zA-Z0-9_-]/g, "_");
    const destDir = path.join(serverDir, "resources", resourceName);
    if (!isInside(serverDir, destDir)) return res.status(403).json({ error: "Invalid resource name" });

    await fs.remove(destDir);
    await fs.ensureDir(path.dirname(destDir));

    // Only allow http(s) git URLs — blocks local file:// paths or shell
    // metacharacters from being smuggled in through this field.
    if (!/^https?:\/\/[a-zA-Z0-9._\-/]+(\.git)?$/.test(String(gitUrl))) {
      return res.status(400).json({ error: "gitUrl must be a plain https:// GitHub/GitLab URL" });
    }
    await execFileAsync("git", ["clone", "--depth", "1", "--", String(gitUrl), destDir], { timeout: 120000 });
    await fs.remove(path.join(destDir, ".git")).catch(() => {});

    await ensureResourceInCfg(serverDir, resourceName, true);
    res.json({ success: true, resourceName });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to install resource from git" });
  }
};

export const toggleResource = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, enabled } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const serverDir = serverRoot(id);
    await ensureResourceInCfg(serverDir, name, !!enabled);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to toggle resource" });
  }
};

export const deleteResource = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const serverDir = serverRoot(id);
    const resourceDir = path.join(serverDir, "resources", name);
    if (!isInside(serverDir, resourceDir)) return res.status(403).json({ error: "Invalid path" });

    await fs.remove(resourceDir);
    await ensureResourceInCfg(serverDir, name, false);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to delete resource" });
  }
};

const FRAMEWORK_REPOS: Record<string, string> = {
  esx: "https://github.com/esx-framework/esx_core.git",
  qbcore: "https://github.com/qbcore-framework/qb-core.git",
};

export const installFramework = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { framework } = req.body;
    const repoUrl = FRAMEWORK_REPOS[String(framework)];
    if (!repoUrl) return res.status(400).json({ error: "Unknown framework. Supported: esx, qbcore" });

    const serverDir = serverRoot(id);
    const resourceName = framework === "esx" ? "es_extended" : "qb-core";
    const destDir = path.join(serverDir, "resources", resourceName);

    await fs.remove(destDir);
    await fs.ensureDir(path.dirname(destDir));
    await execFileAsync("git", ["clone", "--depth", "1", "--", String(repoUrl), destDir], { timeout: 120000 });
    await fs.remove(path.join(destDir, ".git")).catch(() => {});
    await ensureResourceInCfg(serverDir, resourceName, true);

    res.json({ success: true, resourceName });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to install framework" });
  }
};

// Installs a resource/starter project for an extension: either `git clone` of a
// public https repo or a downloaded .zip (e.g. a GitHub release), extracted into
// the server folder. Admin-only. No shell is involved (execFile), hosts are
// allow-listed, and every destination is checked to stay inside the server dir.
const RESOURCE_HOSTS = new Set(["github.com", "gitlab.com", "codeload.github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);

export const installExtensionResource = async (req: Request, res: Response) => {
  let tmp = "";
  try {
    const user = (req as any).user;
    if (user.role !== "admin" && user.role !== "owner") {
      return res.status(403).json({ error: "Admin access only" });
    }
    const { id } = req.params;
    const { gitUrl, zipUrl, folder, targetDir, branch, ensure, intoRoot } = req.body || {};

    const serverDir = path.join(process.cwd(), ".data", "servers", String(id));
    if (!(await fs.pathExists(serverDir))) return res.status(404).json({ error: "Server files not found. Start the server once first." });

    const folderName = String(folder || "").trim();
    if (!intoRoot && !/^[a-zA-Z0-9_.-]{1,64}$/.test(folderName)) return res.status(400).json({ error: "Invalid folder name" });
    const rel = String(targetDir || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (rel && !/^[a-zA-Z0-9_\-[\]/]+$/.test(rel)) return res.status(400).json({ error: "Invalid target directory" });
    const parent = rel ? path.join(serverDir, rel) : serverDir;
    const dest = intoRoot ? parent : path.join(parent, folderName);
    if (!isInside(serverDir, dest)) return res.status(403).json({ error: "Invalid destination" });

    const source = String(gitUrl || zipUrl || "");
    if (!source) return res.status(400).json({ error: "Missing gitUrl or zipUrl" });
    let parsed: URL;
    try { parsed = new URL(source); } catch { return res.status(400).json({ error: "Invalid URL" }); }
    if (parsed.protocol !== "https:" || !RESOURCE_HOSTS.has(parsed.hostname)) {
      return res.status(400).json({ error: "Only https URLs on github.com / gitlab.com are allowed" });
    }

    const os = await import("os");
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ext-res-"));
    let root = path.join(tmp, "src");

    if (gitUrl) {
      if (!/^https:\/\/(github\.com|gitlab\.com)\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\.git)?$/.test(source)) {
        return res.status(400).json({ error: "gitUrl must look like https://github.com/owner/repo" });
      }
      const args = ["clone", "--depth", "1"];
      if (branch && /^[A-Za-z0-9._/-]{1,64}$/.test(String(branch))) args.push("--branch", String(branch));
      args.push("--", source, root);
      const { execFile } = await import("child_process");
      await promisify(execFile)("git", args, { timeout: 120000 });
      await fs.remove(path.join(root, ".git")).catch(() => {});
    } else {
      const axios = (await import("axios")).default;
      const zipPath = path.join(tmp, "download.zip");
      const response = await axios({ url: source, method: "GET", responseType: "stream", timeout: 60000, maxContentLength: 300 * 1024 * 1024, headers: { "User-Agent": "xynex-panel/1.0" } });
      const writer = fs.createWriteStream(zipPath);
      response.data.pipe(writer);
      await new Promise<void>((resolve, reject) => { writer.on("finish", resolve); writer.on("error", reject); response.data.on("error", reject); });
      await extract(zipPath, { dir: root });
    }

    // GitHub / release zips wrap everything in one top-level folder — unwrap it.
    const entries = await fs.readdir(root);
    if (entries.length === 1 && (await fs.stat(path.join(root, entries[0]))).isDirectory()) root = path.join(root, entries[0]);

    await fs.ensureDir(parent);
    if (intoRoot) {
      await fs.copy(root, dest, { overwrite: false, errorOnExist: false });
    } else {
      await fs.remove(dest);
      await fs.copy(root, dest);
      if (ensure) await ensureResourceInCfg(serverDir, folderName, true);
    }
    res.json({ success: true, path: path.relative(serverDir, dest).replace(/\\/g, "/") || "." });
  } catch (err: any) {
    const msg = String(err?.stderr || err?.message || "Failed to install");
    res.status(500).json({ error: /not found|404|Repository/i.test(msg) ? "Repository or file not found — check the URL." : msg.slice(0, 300) });
  } finally {
    if (tmp) await fs.remove(tmp).catch(() => {});
  }
};

export const getInstallLogs = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const logFile = path.join(process.cwd(), ".data", "install-logs", `${id}.log`);
    const content = await fs.readFile(logFile, "utf8").catch(() => "");
    res.json({ log: content });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

