import fs from "fs-extra";
import { open as openFile } from "fs/promises";
import path from "path";

const DATA_DIR = path.join(process.cwd(), ".data");

// Only plain file names inside .data are allowed (no traversal, no subpaths).
const SAFE_NAME = /^[a-zA-Z0-9._-]+\.json$/;
function resolveFile(filename: string): string {
  if (!SAFE_NAME.test(filename) || filename.includes("..")) {
    throw new Error(`Invalid data file name: ${filename}`);
  }
  return path.join(DATA_DIR, filename);
}

// Writes to the same file are chained so two concurrent requests can never
// interleave their writes (the JSON "database" has no other locking).
const writeQueues = new Map<string, Promise<unknown>>();
function enqueue<T>(key: string, job: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(job);
  writeQueues.set(key, next);
  next.finally(() => { if (writeQueues.get(key) === next) writeQueues.delete(key); }).catch(() => undefined);
  return next;
}

/** Reads a JSON data file. Returns null when it doesn't exist. A file that exists
 *  but can't be parsed is moved aside (never silently overwritten) and null is returned. */
export const readJSON = async (filename: string) => {
  const filePath = resolveFile(filename);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err: any) {
    if (err?.code !== "ENOENT") console.error(`[db] could not read ${filename}:`, err?.message || err);
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    const backup = `${filePath}.corrupt-${Date.now()}`;
    console.error(`[db] ${filename} is not valid JSON - keeping a copy at ${path.basename(backup)}`);
    await fs.copy(filePath, backup).catch(() => undefined);
    return null;
  }
};

/** Atomically replaces a JSON data file: write to a temp file, fsync, rename.
 *  A crash mid-write can no longer leave a truncated users.json / servers.json.
 *  Files are created 0600 because they contain password hashes and tokens. */
export const writeJSON = async (filename: string, data: any): Promise<void> => {
  const filePath = resolveFile(filename);
  return enqueue(filePath, async () => {
    await fs.ensureDir(DATA_DIR);
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    const handle = await openFile(tmp, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(data, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(tmp, filePath);
    } catch (err) {
      await fs.remove(tmp).catch(() => undefined);
      throw err;
    }
  });
};

/** Read-modify-write under the file's write queue, so concurrent updates don't lose each other's changes.
 *  Return the new value from `mutate` (or mutate in place and return the same object). */
export const updateJSON = async <T = any>(filename: string, fallback: T, mutate: (current: T) => T | Promise<T>): Promise<T> => {
  const filePath = resolveFile(filename);
  return enqueue(`rmw:${filePath}`, async () => {
    const current = ((await readJSON(filename)) ?? fallback) as T;
    const next = await mutate(current);
    await writeJSON(filename, next);
    return next;
  });
};
