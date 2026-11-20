import { Request, Response } from "express";
import { readJSON, writeJSON } from "../services/db.js";
import crypto from "crypto";
import fs from "fs-extra";
import { validateMountPaths, mountPolicy } from "../utils/containerSecurity.js";
import { logActivity, requestActor } from "../services/activityLog.js";

export const getMounts = async (req: Request, res: Response) => {
  const mounts = (await readJSON("mounts.json")) || [];
  res.json(mounts);
};

export const createMount = async (req: Request, res: Response) => {
  try {
    const { name, sourcePath, targetPath, readOnly, description, eggIds } = req.body;
    if (!name || !sourcePath || !targetPath) {
      return res.status(400).json({ error: "name, sourcePath, and targetPath are required" });
    }
    // Validate BEFORE touching the filesystem: a mount that exposes the Docker socket, system directories or
    // the panel's own data would let any customer server compromise the host.
    const check = validateMountPaths(sourcePath, targetPath, mountPolicy());
    if (!check.ok) return res.status(400).json({ error: check.error });

    // sourcePath is a directory on the HOST, outside of any single
    // server's own data folder — used for things every server of a kind
    // shares, like a common mod/datapack cache. Create it if missing so
    // the first container start doesn't fail on a nonexistent bind source.
    const resolvedSource = check.source;
    await fs.ensureDir(resolvedSource);

    const mounts = (await readJSON("mounts.json")) || [];
    const mount = {
      id: "mount-" + crypto.randomUUID(),
      name: String(name),
      description: description ? String(description) : "",
      sourcePath: resolvedSource,
      targetPath: check.target,
      readOnly: !!readOnly,
      // Empty/omitted eggIds = applies to every server (all eggs).
      // Otherwise, only servers created from one of these egg IDs get it.
      eggIds: Array.isArray(eggIds) ? eggIds : [],
    };
    mounts.push(mount);
    await writeJSON("mounts.json", mounts);
    logActivity({ ...requestActor(req), action: "mount.create", description: `Created mount "${mount.name}" (${mount.sourcePath} -> ${mount.targetPath}${mount.readOnly ? ", read-only" : ""})` });
    res.json(mount);
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to create mount" });
  }
};

export const deleteMount = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const mounts = (await readJSON("mounts.json")) || [];
    const remaining = mounts.filter((m: any) => m.id !== id);
    await writeJSON("mounts.json", remaining);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to delete mount" });
  }
};
