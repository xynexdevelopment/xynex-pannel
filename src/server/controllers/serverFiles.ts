import { Request, Response } from "express";
import fs from "fs-extra";
import { open as openFileHandle } from "fs/promises";
import path from "path";
import { ZipArchive } from "archiver";
import extract from "../utils/safeZip.js";
import { promisify } from "util";
import { execFile as execFileCb } from "child_process";
const execFileAsync = promisify(execFileCb);
import { isInside, serverRoot, resolveUserPath } from "../utils/security.js";

/* File manager for a server's folder: list / read / save / create / rename / delete / zip / unzip /
   download and (chunked) uploads. Every user-supplied path goes through resolveUserPath / isInside. */
// File manager basics
export const getFiles = async (req: Request, res: Response) => {
  const { id } = req.params;
  const dirPath = req.query.path ? String(req.query.path) : "/";
  const targetPath = path.join(serverRoot(id), dirPath);
  
  if (!isInside(serverRoot(id), targetPath)) {
    return res.status(403).json({ error: "Invalid path" });
  }

  try {
    const stats = await fs.stat(targetPath).catch(() => null);
    if (!stats) {
      // Return empty if not found
      return res.json([]);
    }
    if (stats.isFile()) {
       const ext = path.extname(targetPath).toLowerCase();
       const imageExts: Record<string, string> = {
         ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
         ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
         ".ico": "image/x-icon", ".svg": "image/svg+xml",
       };
       if (imageExts[ext]) {
         const buf = await fs.readFile(targetPath);
         return res.json({ isFile: true, isImage: true, mimeType: imageExts[ext], content: buf.toString("base64") });
       }

       const HARD_LIMIT_BYTES = 15 * 1024 * 1024 * 1024; // 15GB — above this we truly refuse (browser/Node can't hold more as a string)
       const FULL_PREVIEW_BYTES = 25 * 1024 * 1024; // 25MB — above this, show a truncated tail instead of the whole file
       if (stats.size > HARD_LIMIT_BYTES) {
         return res.json({ isFile: true, isBinary: true, tooLarge: true, size: stats.size });
       }

       // Content-sniff rather than trust the extension: read a chunk and
       // look for a NUL byte, which essentially never appears in real
       // text files but is common in binaries (jars, executables,
       // archives, images without a recognized extension, etc). This is
       // the same heuristic git/most editors use for "is this binary".
       // NOTE: fs-extra's fs.open() resolves to a raw numeric fd (not a
       // FileHandle), so it has no .read()/.close() methods — use
       // fs/promises' open() here instead, which returns a real FileHandle.
       const sampleSize = Math.min(stats.size, 8000);
       const sampleBuf = Buffer.alloc(sampleSize);
       const fd = await openFileHandle(targetPath, "r");
       try {
         await fd.read(sampleBuf, 0, sampleSize, 0);
       } finally {
         await fd.close();
       }
       const isBinary = sampleBuf.includes(0);

       if (isBinary) {
         // Don't just refuse — give the panel enough bytes to render a
         // read-only hex view, like a real file manager would. Cap the
         // preview so we're never shipping a multi-GB blob to a browser
         // tab; Download (already available from the ⋮ menu) covers the
         // rest of the file.
         const HEX_PREVIEW_BYTES = 256 * 1024; // 256KB — enough to inspect headers/structure without choking the tab
         const previewSize = Math.min(stats.size, HEX_PREVIEW_BYTES);
         const previewBuf = Buffer.alloc(previewSize);
         const hexFd = await openFileHandle(targetPath, "r");
         try {
           await hexFd.read(previewBuf, 0, previewSize, 0);
         } finally {
           await hexFd.close();
         }
         return res.json({
           isFile: true,
           isBinary: true,
           size: stats.size,
           hexPreview: previewBuf.toString("base64"),
           hexTruncated: stats.size > HEX_PREVIEW_BYTES,
         });
       }

       if (stats.size > FULL_PREVIEW_BYTES) {
         // Read only the last chunk — for logs and similar append-only
         // files this is almost always the part someone actually wants
         // to see, and it avoids loading gigabytes into a browser tab.
         // The file still "opens" (just truncated) all the way up to
         // HARD_LIMIT_BYTES above.
         const tailSize = FULL_PREVIEW_BYTES;
         const tailBuf = Buffer.alloc(tailSize);
         const tailFd = await openFileHandle(targetPath, "r");
         try {
           await tailFd.read(tailBuf, 0, tailSize, stats.size - tailSize);
         } finally {
           await tailFd.close();
         }
         return res.json({
           isFile: true,
           content: tailBuf.toString("utf-8"),
           truncated: true,
           size: stats.size,
         });
       }

       const content = await fs.readFile(targetPath, "utf-8");
       return res.json({ isFile: true, content });
    }
    const files = await fs.readdir(targetPath, { withFileTypes: true });
    res.json(files.map(f => ({
      name: f.name,
      isDirectory: f.isDirectory(),
      size: f.isDirectory() ? 0 : fs.statSync(path.join(targetPath, f.name)).size
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

export const uploadFile = async (req: Request, res: Response) => {
  const { id } = req.params;
  const dirPath = req.body.path || "/";
  const rootDir = serverRoot(id);
  const targetPath = path.join(rootDir, String(dirPath));
  const safeName = path.basename(req.file?.originalname || "");

  if (!isInside(rootDir, targetPath) || !safeName || safeName === "." || safeName === "..") {
    if (req.file) await fs.remove(req.file.path).catch(() => {});
    return res.status(403).json({ error: "Invalid path" });
  }

  if (req.file) {
    await fs.ensureDir(targetPath);
    const finalPath = path.join(targetPath, safeName);
    if (!isInside(rootDir, finalPath)) {
      await fs.remove(req.file.path).catch(() => {});
      return res.status(403).json({ error: "Invalid path" });
    }
    await fs.move(req.file.path, finalPath, { overwrite: true });
  }
  res.json({ success: true });
};

// ---- Chunked file upload (merged from Jtg panel) ----
// Lets the frontend upload large files in resumable 10MB chunks instead of
// one single request, with live per-chunk progress reporting.
// uploadId ties the chunks of ONE upload together. It is used in the part file name so two
// concurrent uploads of the same file name can no longer append into each other's data.
const SAFE_UPLOAD_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const partFileFor = (dir: string, fileName: string, uploadId: string) => path.join(dir, `${path.basename(fileName)}.${uploadId}.part`);

export const uploadChunk = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { uploadId, chunkIndex, fileName, path: dirPath } = req.body;
  const discardTemp = async () => { if (req.file) await fs.remove(req.file.path).catch(() => {}); };

  if (!req.file || typeof uploadId !== "string" || chunkIndex === undefined || typeof fileName !== "string" || !fileName) {
    await discardTemp();
    return res.status(400).json({ error: "Missing parameters" });
  }
  if (!SAFE_UPLOAD_ID.test(uploadId) || !path.basename(fileName) || path.basename(fileName) === "..") {
    await discardTemp();
    return res.status(400).json({ error: "Invalid upload id or file name" });
  }

  const root = serverRoot(id);
  const targetPath = resolveUserPath(root, typeof dirPath === "string" && dirPath ? dirPath : "/");
  const partFilePath = targetPath ? partFileFor(targetPath, fileName, uploadId) : null;
  if (!targetPath || !partFilePath || !isInside(root, partFilePath)) {
    await discardTemp();
    return res.status(403).json({ error: "Invalid path" });
  }

  try {
    await fs.ensureDir(targetPath);

    // If it's the first chunk, ensure we start fresh
    if (String(chunkIndex) === "0") {
      await fs.remove(partFilePath);
    }

    // Stream the chunk onto the part file (no whole-chunk buffer in memory)
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(partFilePath, { flags: "a" });
      const input = fs.createReadStream(req.file!.path);
      input.on("error", reject);
      out.on("error", reject);
      out.on("finish", resolve);
      input.pipe(out);
    });

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await discardTemp();
  }
};

export const completeUpload = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { uploadId, fileName, path: dirPath, totalChunks } = req.body;
  if (typeof uploadId !== "string" || typeof fileName !== "string" || !fileName || !totalChunks) {
    return res.status(400).json({ error: "Missing parameters" });
  }
  if (!SAFE_UPLOAD_ID.test(uploadId) || !path.basename(fileName) || path.basename(fileName) === "..") {
    return res.status(400).json({ error: "Invalid upload id or file name" });
  }

  const root = serverRoot(id);
  const targetPath = resolveUserPath(root, typeof dirPath === "string" && dirPath ? dirPath : "/");
  const finalFilePath = targetPath ? path.join(targetPath, path.basename(fileName)) : null;
  const partFilePath = targetPath ? partFileFor(targetPath, fileName, uploadId) : null;
  if (!targetPath || !finalFilePath || !partFilePath || !isInside(root, finalFilePath) || !isInside(root, partFilePath)) {
    return res.status(403).json({ error: "Invalid path" });
  }

  try {
    if (await fs.pathExists(partFilePath)) {
      await fs.move(partFilePath, finalFilePath, { overwrite: true });
    } else {
      throw new Error("Part file missing");
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

export const deleteFile = async (req: Request, res: Response) => {
  const { id } = req.params;
  const raw = req.body?.paths ?? (req.body?.path !== undefined ? [req.body.path] : []);
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 1000 || raw.some((p) => typeof p !== "string")) {
    return res.status(400).json({ error: "paths must be a non-empty array of strings" });
  }

  // Validate every entry before touching the disk, so one bad path cannot leave a half-done delete.
  const root = serverRoot(id);
  const targets: string[] = [];
  for (const filePath of raw as string[]) {
    const targetPath = resolveUserPath(root, filePath);
    if (!targetPath) return res.status(403).json({ error: "Invalid path" });
    // "/" or "" resolve to the server root, which isInside() accepts; never delete the root itself.
    if (path.resolve(targetPath) === path.resolve(root)) {
      return res.status(400).json({ error: "The server root folder cannot be deleted" });
    }
    targets.push(targetPath);
  }

  try {
    for (const targetPath of targets) await fs.remove(targetPath);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
};

export const downloadFile = async (req: Request, res: Response) => {
  const { id } = req.params;
  const filePath = req.query.path ? String(req.query.path) : "";
  const targetPath = path.join(serverRoot(id), filePath);

  if (!isInside(serverRoot(id), targetPath)) {
    return res.status(403).json({ error: "Invalid path" });
  }

  try {
    const stats = await fs.stat(targetPath).catch(() => null);
    if (!stats || !stats.isFile()) {
      return res.status(404).json({ error: "File not found" });
    }
    res.download(targetPath);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

export const zipFiles = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { dirPath, fileNames, outputName } = req.body;
  
  const baseDir = path.join(serverRoot(id), dirPath);
  const outZipPath = path.join(baseDir, outputName || "archive.zip");

  if (!isInside(serverRoot(id), baseDir)) {
    return res.status(403).json({ error: "Invalid path" });
  }

  try {
    const output = fs.createWriteStream(outZipPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });

    output.on("close", () => {
      res.json({ success: true, filename: outputName || "archive.zip" });
    });

    archive.on("error", (err: any) => {
      console.error("Archive error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    });

    archive.pipe(output);

    for (const name of fileNames) {
      const filePath = path.join(baseDir, name);
      const stat = await fs.stat(filePath);
      if (stat.isDirectory()) {
        archive.directory(filePath, name);
      } else {
        archive.file(filePath, { name });
      }
    }

    await archive.finalize();
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
};

export const renameFile = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { oldPath, newPath } = req.body;

  const targetOldPath = path.join(serverRoot(id), oldPath);
  const targetNewPath = path.join(serverRoot(id), newPath);

  if (!isInside(serverRoot(id), targetOldPath) ||
      !isInside(serverRoot(id), targetNewPath)) {
    return res.status(403).json({ error: "Invalid path" });
  }

  try {
    await fs.rename(targetOldPath, targetNewPath);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}

export const unzipFile = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { path: filePath } = req.body;

  const targetPath = path.join(serverRoot(id), filePath);
  
  if (!isInside(serverRoot(id), targetPath)) {
    return res.status(403).json({ error: "Invalid path" });
  }

  const destDir = path.dirname(targetPath);
  const ext = path.extname(targetPath).toLowerCase();

  try {
    if (ext === ".rar") {
      // No pure-JS RAR reader is bundled, so shell out to whichever
      // extractor is available on the host (install.sh installs both
      // unrar and p7zip so one of these should always work).
      try {
        // execFile (no shell): a file named  a$(cmd).rar  can no longer run commands.
        await execFileAsync("unrar", ["x", "-o+", targetPath, destDir + path.sep], { timeout: 300000 });
      } catch (unrarErr) {
        try {
          await execFileAsync("7z", ["x", "-y", `-o${destDir}`, targetPath], { timeout: 300000 });
        } catch (sevenZipErr: any) {
          throw new Error("Could not extract .rar — neither 'unrar' nor '7z' is installed on the server. Re-run install.sh to install them, or install manually: apt-get install unrar p7zip-full");
        }
      }
      // unrar / 7z can create symlinks — drop any that point outside the server folder.
      const { stripEscapingSymlinks } = await import("../utils/safeZip.js");
      await stripEscapingSymlinks(destDir);
    } else {
      // .zip (extracted by our own symlink-safe extractor)
      await extract(targetPath, { dir: destDir });
    }
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
};


export const createFile = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { filePath } = req.body;
  const targetPath = path.join(serverRoot(id), filePath);
  if (!isInside(serverRoot(id), targetPath)) {
    return res.status(403).json({ error: "Invalid path" });
  }
  try {
    await fs.writeFile(targetPath, "", "utf-8");
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
};

export const createDirectory = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { filePath } = req.body;
  const targetPath = path.join(serverRoot(id), filePath);
  if (!isInside(serverRoot(id), targetPath)) {
    return res.status(403).json({ error: "Invalid path" });
  }
  try {
    await fs.mkdir(targetPath, { recursive: true });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
};

export const saveFileContent = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { filePath, content } = req.body;

  const targetPath = path.join(serverRoot(id), filePath);

  if (!isInside(serverRoot(id), targetPath)) {
    return res.status(403).json({ error: "Invalid path" });
  }

  try {
    await fs.writeFile(targetPath, content, "utf-8");
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}

