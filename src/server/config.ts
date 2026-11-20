/* Startup configuration validation. A typo in .env (PORT=abc, CSP_MODE=enfroce, TRUST_PROXY=maybe)
   used to be silently accepted and could leave the panel on the wrong port or with weaker
   protection. validateConfig() returns every problem at once; server.ts refuses to start on errors
   and logs warnings. */
export interface ConfigReport { errors: string[]; warnings: string[] }

const isPort = (v: string) => /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 65535;

export function validateConfig(env: NodeJS.ProcessEnv = process.env): ConfigReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const get = (k: string) => (env[k] ?? "").trim();

  if (get("PORT") && !isPort(get("PORT"))) errors.push(`PORT must be an integer between 1 and 65535 (got "${get("PORT")}")`);
  if (get("SFTP_PORT") && !isPort(get("SFTP_PORT"))) errors.push(`SFTP_PORT must be an integer between 1 and 65535 (got "${get("SFTP_PORT")}")`);
  if (get("PORT") && get("PORT") === (get("SFTP_PORT") || "6868")) errors.push("PORT and SFTP_PORT must differ");

  const csp = get("CSP_MODE").toLowerCase();
  if (csp && !["enforce", "report-only", "off"].includes(csp)) errors.push(`CSP_MODE must be enforce, report-only or off (got "${get("CSP_MODE")}")`);

  const tp = get("TRUST_PROXY");
  if (tp && tp !== "false" && tp !== "loopback" && !/^\d+$/.test(tp) && !/^[0-9a-fA-F:.,/ \-a-z]+$/.test(tp)) errors.push(`TRUST_PROXY looks invalid ("${tp}"): use false, loopback, a hop count or a subnet list`);
  if (tp === "true") errors.push('TRUST_PROXY=true trusts every client-supplied X-Forwarded-For and defeats IP bans and rate limits; use a hop count or subnet list');

  if (get("JSON_BODY_LIMIT") && !/^\d+(\.\d+)?\s?(b|kb|mb|gb)?$/i.test(get("JSON_BODY_LIMIT"))) errors.push(`JSON_BODY_LIMIT must look like 5mb (got "${get("JSON_BODY_LIMIT")}")`);
  if (get("MAX_UPLOAD_BYTES") && !(Number(get("MAX_UPLOAD_BYTES")) > 0)) errors.push("MAX_UPLOAD_BYTES must be a positive number of bytes");

  for (const origin of get("ALLOWED_ORIGINS").split(",").map((o) => o.trim()).filter(Boolean)) {
    try { const u = new URL(origin); if (u.pathname !== "/" || u.search || u.hash) throw new Error(); } catch { errors.push(`ALLOWED_ORIGINS entry "${origin}" must be an origin like https://panel.example.com (no path)`); }
  }

  if (get("JWT_SECRET") && get("JWT_SECRET").length < 32) warnings.push("JWT_SECRET is shorter than 32 characters; use `openssl rand -base64 48` (or leave it unset to auto-generate one)");
  if (get("NODE_ENV") === "production" && get("ALLOW_DEV_AUTO_LOGIN") === "true") errors.push("ALLOW_DEV_AUTO_LOGIN=true must never be set in production");
  if (get("NODE_ENV") !== "production" && get("ALLOW_DEV_AUTO_LOGIN") === "true") warnings.push("ALLOW_DEV_AUTO_LOGIN is on: any username/password creates an admin account (development only)");
  // Rate-limit counters, account lockouts and the token revocation list are per process. A second instance
  // would silently get its own empty copies and weaken all three, so refuse unless explicitly accepted.
  const inst = get("NODE_APP_INSTANCE");
  if (/^\d+$/.test(inst) && Number(inst) > 0 && get("ALLOW_MULTI_INSTANCE") !== "true") {
    errors.push("Running several panel instances is not supported: rate limits, lockouts and token revocation are kept in process memory and are not shared. Use a single instance (pm2 `instances: 1`), or set ALLOW_MULTI_INSTANCE=true if you accept weaker limits.");
  }
  return { errors, warnings };
}
