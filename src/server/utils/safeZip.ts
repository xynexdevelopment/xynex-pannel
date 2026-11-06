/**
 * Safe replacement for `extract-zip` (which has known symlink / arbitrary-file-write
 * advisories and no fix). Drop-in: `await extract(zipPath, { dir })`.
 *
 * - rejects absolute paths, drive letters, NUL bytes and any `..` segment (zip-slip)
 * - never creates symlinks (symlink entries are skipped)
 * - refuses to write through a symlinked parent directory that leaves `dir`
 * - strips setuid/setgid bits, keeps the normal rwx bits (game binaries need +x)
 * - caps entry count and total uncompressed size (zip bombs)
 */
import yauzl from "yauzl";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { pipeline } from "stream/promises";

const MAX_ENTRIES = 200_000;
const MAX_TOTAL_BYTES = 20 * 1024 ** 3; // 20 GiB uncompressed
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

function within(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

export default async function safeExtractZip(zipPath: string, opts: { dir: string }): Promise<void> {
  const root = path.resolve(opts.dir);
  await fsp.mkdir(root, { recursive: true });
  const realRoot = await fsp.realpath(root);

  await new Promise<void>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (openErr, zip) => {
      if (openErr || !zip) return reject(openErr || new Error("Could not open archive"));
      let entries = 0;
      let total = 0;
      const fail = (e: unknown) => { zip.close(); reject(e); };

      zip.on("error", reject);
      zip.on("end", () => resolve());
      zip.on("entry", async (entry: yauzl.Entry) => {
        try {
          if (++entries > MAX_ENTRIES) throw new Error("Archive contains too many files");
          total += entry.uncompressedSize;
          if (total > MAX_TOTAL_BYTES) throw new Error("Archive is too large when extracted");

          const name = entry.fileName.replace(/\\/g, "/");
          if (name.includes("\0") || name.startsWith("/") || /^[a-zA-Z]:/.test(name) || name.split("/").includes("..")) {
            throw new Error(`Unsafe path in archive: ${name.slice(0, 120)}`);
          }
          const target = path.resolve(root, name);
          if (!within(root, target)) throw new Error(`Unsafe path in archive: ${name.slice(0, 120)}`);

          const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
          if ((mode & S_IFMT) === S_IFLNK) {
            zip.readEntry(); // symlinks are never created
            return;
          }

          if (name.endsWith("/")) {
            await fsp.mkdir(target, { recursive: true });
            zip.readEntry();
            return;
          }

          await fsp.mkdir(path.dirname(target), { recursive: true });
          const realParent = await fsp.realpath(path.dirname(target));
          if (!within(realRoot, realParent)) throw new Error(`Archive entry escapes the target folder: ${name.slice(0, 120)}`);

          // Never write *through* an existing symlink at the destination.
          try {
            const st = await fsp.lstat(target);
            if (st.isSymbolicLink()) await fsp.unlink(target);
          } catch { /* does not exist yet */ }

          zip.openReadStream(entry, async (streamErr, readStream) => {
            if (streamErr || !readStream) return fail(streamErr || new Error("Could not read archive entry"));
            try {
              const fileMode = (mode & 0o777) || 0o644;
              await pipeline(readStream, fs.createWriteStream(target, { mode: fileMode }));
              await fsp.chmod(target, fileMode);
              zip.readEntry();
            } catch (e) { fail(e); }
          });
        } catch (e) {
          fail(e);
        }
      });
      zip.readEntry();
    });
  });
}

/** After extracting with an external tool (unrar / 7z) remove any symlink that points outside `dir`. */
export async function stripEscapingSymlinks(dir: string): Promise<number> {
  const root = await fsp.realpath(dir);
  let removed = 0;
  const walk = async (current: string): Promise<void> => {
    for (const item of await fsp.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, item.name);
      if (item.isSymbolicLink()) {
        let ok = false;
        try { ok = within(root, await fsp.realpath(full)); } catch { ok = false; }
        if (!ok) { await fsp.unlink(full).catch(() => {}); removed++; }
      } else if (item.isDirectory()) {
        await walk(full);
      }
    }
  };
  await walk(root);
  return removed;
}
