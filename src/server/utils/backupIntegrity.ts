import fs from "fs";
import fsp from "fs/promises";
import crypto from "crypto";
import path from "path";
import zlib from "zlib";
import yauzl from "yauzl";
import { Writable } from "stream";

/* Backup integrity: a backup file existing does not mean it is usable.
   - every backup gets a SHA-256 sidecar (<file>.sha256) when it is written
   - verifyBackupArchive() checks the sidecar, walks the zip's central directory
     (path-traversal / bomb limits) and, in deep mode, streams every entry through
     the decompressor and checks sizes and CRC32 - without writing anything to disk. */

export const CHECKSUM_EXT = ".sha256";

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file).on("error", reject).on("data", (c) => h.update(c)).on("end", () => resolve(h.digest("hex")));
  });
}

export async function writeChecksum(zipPath: string, hex: string): Promise<void> {
  await fsp.writeFile(zipPath + CHECKSUM_EXT, `${hex}  ${path.basename(zipPath)}\n`, { mode: 0o600 });
}

export async function readChecksum(zipPath: string): Promise<string | null> {
  try {
    const txt = await fsp.readFile(zipPath + CHECKSUM_EXT, "utf8");
    const m = /^([a-f0-9]{64})\b/i.exec(txt.trim());
    return m ? m[1].toLowerCase() : null;
  } catch { return null; }
}

export type ChecksumState = "verified" | "missing" | "mismatch";

export interface ArchiveReport {
  ok: boolean;
  error?: string;
  entries: number;
  uncompressedBytes: number;
  checksum: ChecksumState;
}

export interface VerifyLimits { maxEntries?: number; maxTotalBytes?: number; deep?: boolean }

const DEFAULT_MAX_ENTRIES = 200_000;
const DEFAULT_MAX_BYTES = 20 * 1024 ** 3; // same ceiling as utils/safeZip.ts
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

export function unsafeArchiveName(raw: string): boolean {
  const name = raw.replace(/\\/g, "/");
  return name.includes("\0") || name.startsWith("/") || /^[a-zA-Z]:/.test(name) || name.split("/").includes("..");
}

export async function verifyBackupArchive(zipPath: string, limits: VerifyLimits = {}): Promise<ArchiveReport> {
  const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxTotal = limits.maxTotalBytes ?? DEFAULT_MAX_BYTES;
  const report: ArchiveReport = { ok: false, entries: 0, uncompressedBytes: 0, checksum: "missing" };

  try { await fsp.access(zipPath, fs.constants.R_OK); } catch { return { ...report, error: "Backup file is missing or unreadable" }; }

  const expected = await readChecksum(zipPath);
  if (expected) {
    const actual = await sha256File(zipPath);
    report.checksum = actual === expected ? "verified" : "mismatch";
    if (report.checksum === "mismatch") return { ...report, error: "Checksum mismatch - the backup file was modified or is corrupted" };
  }

  return new Promise<ArchiveReport>((resolve) => {
    const done = (r: Partial<ArchiveReport> & { error?: string }) => resolve({ ...report, ...r, ok: !r.error });
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true, validateEntrySizes: true }, (err, zip) => {
      if (err || !zip) return done({ error: `Not a valid zip archive: ${err?.message || "unknown error"}` });
      let finished = false;
      const fail = (message: string) => { if (finished) return; finished = true; try { zip.close(); } catch { /* already closed */ } done({ error: message }); };

      zip.on("error", (e) => fail(`Archive is corrupted: ${e.message}`));
      zip.on("end", () => { if (!finished) { finished = true; done({}); } });
      zip.on("entry", (entry: yauzl.Entry) => {
        if (finished) return;
        if (++report.entries > maxEntries) return fail("Archive contains too many files");
        report.uncompressedBytes += entry.uncompressedSize;
        if (report.uncompressedBytes > maxTotal) return fail("Archive is too large when extracted");
        if (unsafeArchiveName(entry.fileName)) return fail(`Unsafe path in archive: ${entry.fileName.slice(0, 120)}`);

        const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
        const isDir = entry.fileName.endsWith("/");
        if (!limits.deep || isDir || (mode & S_IFMT) === S_IFLNK) return zip.readEntry();

        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return fail(`Cannot read ${entry.fileName.slice(0, 120)}: ${e?.message || "unknown error"}`);
          let crc = 0;
          const canCrc = typeof (zlib as any).crc32 === "function";
          stream.on("error", (se) => fail(`Corrupted data in ${entry.fileName.slice(0, 120)}: ${se.message}`));
          stream.pipe(new Writable({
            write(chunk, _enc, cb) { if (canCrc) crc = (zlib as any).crc32(chunk, crc); cb(); },
            final(cb) {
              if (canCrc && crc >>> 0 !== entry.crc32 >>> 0) { fail(`CRC mismatch in ${entry.fileName.slice(0, 120)}`); return cb(); }
              cb();
              if (!finished) zip.readEntry();
            },
          }));
        });
      });
      zip.readEntry();
    });
  });
}

/** Free bytes on the filesystem holding `dir` (null if the platform can't tell). */
export async function freeDiskBytes(dir: string): Promise<number | null> {
  try {
    const s = await (fsp as any).statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch { return null; }
}

/** Total size of regular files below `dir` (symlinks are not followed). */
export async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0;
  const walk = async (d: string) => {
    let ents: fs.Dirent[];
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) { try { total += (await fsp.stat(p)).size; } catch { /* vanished */ } }
    }
  };
  await walk(dir);
  return total;
}
