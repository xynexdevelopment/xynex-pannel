import express from "express";
import fs from "fs-extra";
import path from "path";

const router = express.Router();
const startedAt = Date.now();

// Liveness + readiness in one cheap, unauthenticated call for pm2 / load balancers / uptime monitors.
// 200 = process is up and its data directory is writable; 503 = up but cannot persist data.
// It deliberately exposes nothing beyond status and uptime.
router.get("/health", async (_req, res) => {
  let dataWritable = true;
  try {
    const probe = path.join(process.cwd(), ".data", `.health-${process.pid}`);
    await fs.writeFile(probe, "ok", { mode: 0o600 });
    await fs.remove(probe);
  } catch { dataWritable = false; }
  res.status(dataWritable ? 200 : 503).json({ status: dataWritable ? "ok" : "degraded", dataWritable, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) });
});

export default router;
