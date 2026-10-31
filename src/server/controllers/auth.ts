import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import speakeasy from "speakeasy";
import QRCode from "qrcode";
import { readJSON, writeJSON } from "../services/db.js";
import { createChallenge, verifyChallenge, consumeChallenge } from "../services/captcha.js";
import { getClientIp } from "../middleware/ipBan.js";
import { revokeToken } from "../services/tokenRevocation.js";
import { sealSecret, openSecret, isSealed, verifySessionToken } from "../utils/security.js";
import { verifyFirebaseIdToken } from "../services/googleIdToken.js";
import { loginAttempts, twoFactorAttempts, sendThrottled } from "../middleware/rateLimit.js";

import { getJwtSecret, BCRYPT_ROUNDS } from "../utils/security.js";
const JWT_SECRET = getJwtSecret();

/** Verifies a TOTP code and rejects replays: a code (time step) that was already accepted for
 *  this user cannot be used again within its validity window. On success the caller must persist
 *  `user.twoFactorLastStep` (it is set here). */
function verifyTotpOnce(user: any, stored: string, code: unknown): boolean {
  let secret: string;
  try { secret = openSecret(stored); } catch { return false; } // tampered / unreadable seed never validates
  const delta = speakeasy.totp.verifyDelta({ secret, encoding: "base32", token: String(code ?? "").trim(), window: 1 });
  if (!delta) return false;
  const step = Math.floor(Date.now() / 1000 / 30) + delta.delta;
  if (typeof user.twoFactorLastStep === "number" && step <= user.twoFactorLastStep) return false;
  user.twoFactorLastStep = step;
  if (!isSealed(user.twoFactorSecret)) user.twoFactorSecret = sealSecret(secret); // migrate legacy plaintext on use
  return true;
}

export const register = async (req: Request, res: Response) => {
  const settings = await readJSON("settings.json") || {};
  if (settings.enableRegistration === false) {
    res.status(403).json({ error: "User registration is currently disabled by administrator." });
    return;
  }

  const { username, password, confirmPassword } = req.body;

  if (!username || !password || !confirmPassword) {
    res.status(400).json({ error: "Username, password, and confirm password are required" });
    return;
  }

  if (typeof username !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const cleanUsername = username.trim();
  if (cleanUsername.length > 32 || !/^[a-zA-Z0-9_.-]+$/.test(cleanUsername)) {
    res.status(400).json({ error: "Username may only contain letters, numbers, _ . - (max 32)" });
    return;
  }
  if (cleanUsername.length < 3) {
    res.status(400).json({ error: "Username must be at least 3 characters" });
    return;
  }

  if (password.length < 8 || password.length > 128) {
    res.status(400).json({ error: "Password must be 8-128 characters" });
    return;
  }

  if (password !== confirmPassword) {
    res.status(400).json({ error: "Passwords do not match" });
    return;
  }

  const users = await readJSON("users.json") || [];
  const existingUser = users.find((u: any) => u.username.toLowerCase() === cleanUsername.toLowerCase());

  if (existingUser) {
    res.status(400).json({ error: "Username is already taken" });
    return;
  }

  const { writeJSON } = await import("../services/db.js");
  const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
  
  const newUser = {
    id: "user-" + Date.now() + "-" + crypto.randomBytes(5).toString("hex"),
    username: cleanUsername,
    password: hashedPassword,
    role: "user",
    passwordVersion: 0
  };

  users.push(newUser);
  await writeJSON("users.json", users);

  res.status(201).json({
    message: "User registered successfully",
    user: { id: newUser.id, username: newUser.username, role: newUser.role }
  });
};

export const getCaptchaChallenge = (req: Request, res: Response) => {
  const { challengeId, target, options } = createChallenge();
  res.json({ challengeId, target, options });
};

export const verifyCaptcha = (req: Request, res: Response) => {
  const { challengeId, optionId } = req.body;
  if (!challengeId || !optionId) {
    res.status(400).json({ error: "challengeId and optionId are required" });
    return;
  }
  const ok = verifyChallenge(challengeId, optionId);
  if (!ok) {
    res.status(400).json({ error: "That's not quite right. Try again." });
    return;
  }
  res.json({ success: true });
};

export const login = async (req: Request, res: Response) => {
  const { username, password, challengeId } = req.body;

  if (!challengeId || !consumeChallenge(challengeId)) {
    res.status(400).json({ error: "Please complete the captcha before logging in." });
    return;
  }

  if (!username || !password || typeof username !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "Username and password required" });
    return;
  }

  // NOTE: this used to evaluate to `true` in almost every real deployment
  // (any time PORT wasn't the literal string "6767"), which meant *any*
  // username/password typed at the login screen would silently create a
  // brand-new admin account and log the attacker straight in - a full
  // authentication bypass. It is now opt-in only, off by default, and
  // requires an explicit environment flag so it can never fire in a
  // production deployment by accident.
  const isDevMode =
    process.env.NODE_ENV !== "production" &&
    process.env.ALLOW_DEV_AUTO_LOGIN === "true";

  if (isDevMode) {
    const users = await readJSON("users.json") || [];
    let user = users.find((u: any) => u.username === username);

    if (!user) {
      const { writeJSON } = await import("../services/db.js");
      const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
      user = {
        id: "dev-user-" + crypto.randomBytes(5).toString("hex"),
        username,
        password: hashedPassword,
        role: "admin",
        passwordVersion: 0
      };
      users.push(user);
      await writeJSON("users.json", users);
    }

    const role = user.role || "user";
    user.lastIp = getClientIp(req);
    user.lastLoginAt = new Date().toISOString();
    const { writeJSON: writeUsersJSON } = await import("../services/db.js");
    await writeUsersJSON("users.json", users);
    const token = jwt.sign(
      { id: user.id, username: user.username, role, passwordVersion: user.passwordVersion || 0 },
      JWT_SECRET,
      { expiresIn: "7d", jwtid: crypto.randomUUID() }
    );

    res.json({ token, user: { id: user.id, username: user.username, role } });
    return;
  }

  // Per-account brute-force protection (all IPs combined). Unknown usernames count too.
  const throttleKey = `login:${username.toLowerCase().slice(0, 64)}`;
  const gate = loginAttempts.check(throttleKey);
  if (gate.blocked) return sendThrottled(res, gate.retryAfterSec, "Too many failed logins for this account. Please try again later.");

  const users = await readJSON("users.json") || [];
  
  const user = users.find((u: any) => u.username === username);

  if (!user) {
    loginAttempts.fail(throttleKey);
    // Constant-ish time: burn a bcrypt compare so response time doesn't reveal valid usernames
    await bcrypt.compare(String(password), "$2b$10$CwTycUXWue0Thq9StjUM0uJ8.8HqzGZ0r3oYk5b7QnQvZ0mQe3S2a").catch(() => {});
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const isMatch = await bcrypt.compare(String(password), user.password);

  if (!isMatch) {
    loginAttempts.fail(throttleKey);
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }
  loginAttempts.reset(throttleKey);

  if (user.suspended) {
    res.status(403).json({ error: "This account has been suspended. Please contact an administrator." });
    return;
  }

  user.lastIp = getClientIp(req);
  user.lastLoginAt = new Date().toISOString();
  await writeJSON("users.json", users);

  if (user.twoFactorEnabled && user.twoFactorSecret) {
    // Password is correct, but the account has TOTP 2FA enabled - issue a
    // short-lived pre-auth token instead of a real session token. The
    // client must exchange it (plus a valid TOTP code) at
    // POST /api/auth/2fa/verify-login within 5 minutes.
    const preAuthToken = jwt.sign({ id: user.id, stage: "2fa" }, JWT_SECRET, { expiresIn: "5m" });
    res.json({ requires2FA: true, tempToken: preAuthToken });
    return;
  }

  const role = user.role || "user";
  const token = jwt.sign({ id: user.id, username: user.username, role, passwordVersion: user.passwordVersion || 0 }, JWT_SECRET, { expiresIn: "7d", jwtid: crypto.randomUUID() });

  (async () => { const { logActivity } = await import("../services/activityLog.js"); logActivity({ userId: user.id, username: user.username, action: "auth.login", description: `${user.username} logged in`, ip: getClientIp(req) }); })();

  res.json({ token, user: { id: user.id, username: user.username, role } });
};

// Step 2 of login when the account has 2FA enabled: exchange the short-lived
// pre-auth token + a current TOTP code for a real session token.
export const verifyTwoFactorLogin = async (req: Request, res: Response) => {
  const { tempToken, code } = req.body;

  if (!tempToken || !code) {
    res.status(400).json({ error: "Temporary token and authentication code are required" });
    return;
  }

  let decoded: any;
  try {
    decoded = jwt.verify(tempToken, JWT_SECRET, { algorithms: ["HS256"] });
  } catch (err) {
    res.status(401).json({ error: "Your session expired, please log in again" });
    return;
  }

  if (decoded.stage !== "2fa" || !decoded.id) {
    res.status(401).json({ error: "Invalid session" });
    return;
  }

  const users = await readJSON("users.json") || [];
  const user = users.find((u: any) => u.id === decoded.id);

  if (!user || !user.twoFactorEnabled || !user.twoFactorSecret) {
    res.status(400).json({ error: "Two-factor authentication is not enabled for this account" });
    return;
  }
  if (user.suspended) {
    res.status(403).json({ error: "This account has been suspended. Please contact an administrator." });
    return;
  }

  const gate2fa = twoFactorAttempts.check(`2fa:${user.id}`);
  if (gate2fa.blocked) return sendThrottled(res, gate2fa.retryAfterSec, "Too many invalid codes. Please log in again later.");

  if (!verifyTotpOnce(user, user.twoFactorSecret, code)) {
    twoFactorAttempts.fail(`2fa:${user.id}`);
    res.status(401).json({ error: "Invalid authentication code" });
    return;
  }
  twoFactorAttempts.reset(`2fa:${user.id}`);

  user.lastIp = getClientIp(req);
  user.lastLoginAt = new Date().toISOString();
  await writeJSON("users.json", users);

  const role = user.role || "user";
  const token = jwt.sign({ id: user.id, username: user.username, role, passwordVersion: user.passwordVersion || 0 }, JWT_SECRET, { expiresIn: "7d", jwtid: crypto.randomUUID() });

  res.json({ token, user: { id: user.id, username: user.username, role } });
};

// Begin 2FA setup: generates a new TOTP secret (stored as "pending" until
// confirmed with a valid code) and returns a QR code the user can scan with
// Google Authenticator / Authy / 1Password etc.
export const setupTwoFactor = async (req: Request, res: Response) => {
  const reqUser = (req as any).user;

  if (reqUser.id === "temp-admin") {
    res.status(400).json({ error: "Cannot enable 2FA on the default admin account. Create a real admin user instead." });
    return;
  }

  const users = await readJSON("users.json") || [];
  const idx = users.findIndex((u: any) => u.id === reqUser.id);

  if (idx === -1) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  if (users[idx].twoFactorEnabled) {
    res.status(400).json({ error: "Two-factor authentication is already enabled" });
    return;
  }

  const secret = speakeasy.generateSecret({
    length: 20,
    name: `XyneX Panel (${users[idx].username})`,
  });

  users[idx].twoFactorTempSecret = sealSecret(secret.base32);
  await writeJSON("users.json", users);

  const qrCode = await QRCode.toDataURL(secret.otpauth_url as string);

  res.json({ secret: secret.base32, qrCode });
};

// Confirm 2FA setup by verifying one code generated from the pending secret.
export const confirmTwoFactor = async (req: Request, res: Response) => {
  const reqUser = (req as any).user;
  const { code } = req.body;

  if (!code) {
    res.status(400).json({ error: "Authentication code is required" });
    return;
  }

  const users = await readJSON("users.json") || [];
  const idx = users.findIndex((u: any) => u.id === reqUser.id);

  if (idx === -1) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const tempSecret = users[idx].twoFactorTempSecret;
  if (!tempSecret) {
    res.status(400).json({ error: "No pending 2FA setup found. Please start setup again." });
    return;
  }

  let tempPlain: string;
  try { tempPlain = openSecret(tempSecret); } catch { res.status(400).json({ error: "Pending 2FA setup is unreadable. Please start setup again." }); return; }
  const verified = speakeasy.totp.verify({
    secret: tempPlain,
    encoding: "base32",
    token: String(code).trim(),
    window: 1,
  });

  if (!verified) {
    res.status(400).json({ error: "Invalid code, please try again" });
    return;
  }

  users[idx].twoFactorSecret = isSealed(tempSecret) ? tempSecret : sealSecret(tempSecret);
  users[idx].twoFactorEnabled = true;
  delete users[idx].twoFactorTempSecret;
  await writeJSON("users.json", users);

  res.json({ success: true });
};

// Disable 2FA - requires both the account password (for locally-authed
// users) and a valid current TOTP code, so a stolen/leaked session token
// alone isn't enough to turn off the second factor.
export const disableTwoFactor = async (req: Request, res: Response) => {
  const reqUser = (req as any).user;
  const { password, code } = req.body;

  const users = await readJSON("users.json") || [];
  const idx = users.findIndex((u: any) => u.id === reqUser.id);

  if (idx === -1) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const user = users[idx];

  if (!user.twoFactorEnabled) {
    res.status(400).json({ error: "Two-factor authentication is not enabled" });
    return;
  }

  if (user.password) {
    const isMatch = await bcrypt.compare(password || "", user.password);
    if (!isMatch) {
      res.status(401).json({ error: "Incorrect password" });
      return;
    }
  }

  const gateOff = twoFactorAttempts.check(`2fa:${user.id}`);
  if (gateOff.blocked) return sendThrottled(res, gateOff.retryAfterSec, "Too many invalid codes. Please try again later.");

  if (!verifyTotpOnce(user, user.twoFactorSecret, code)) {
    twoFactorAttempts.fail(`2fa:${user.id}`);
    res.status(401).json({ error: "Invalid authentication code" });
    return;
  }
  twoFactorAttempts.reset(`2fa:${user.id}`);

  user.twoFactorEnabled = false;
  delete user.twoFactorLastStep;
  delete user.twoFactorSecret;
  delete user.twoFactorTempSecret;
  await writeJSON("users.json", users);

  res.json({ success: true });
};

// Explicitly links the Google account in a fresh ID token to the CURRENTLY logged-in local account.
export const linkGoogle = async (req: Request, res: Response) => {
  const { idToken } = req.body || {};
  const reqUser = (req as any).user;
  if (typeof idToken !== "string" || !idToken) { res.status(400).json({ error: "An ID token is required." }); return; }
  const settings = await readJSON("settings.json") || {};
  const projectId = typeof settings.firebaseProjectId === "string" ? settings.firebaseProjectId.trim() : "";
  if (settings.enableGoogleLogin !== true || !projectId) { res.status(403).json({ error: "Google Login is not enabled on this panel." }); return; }
  let identity;
  try { identity = await verifyFirebaseIdToken(idToken, projectId); }
  catch { res.status(401).json({ error: "Google sign-in could not be verified." }); return; }
  if (!identity.emailVerified) { res.status(401).json({ error: "Your Google email address is not verified." }); return; }

  const users = await readJSON("users.json") || [];
  const user = users.find((u: any) => u.id === reqUser?.id);
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  if (users.some((u: any) => u.googleId === identity.uid && u.id !== user.id)) { res.status(409).json({ error: "This Google account is already linked to another user." }); return; }
  user.googleId = identity.uid;
  if (!user.email) user.email = identity.email;
  await writeJSON("users.json", users);
  res.json({ success: true });
};

// Revokes the presented session token (its jti) until it would have expired. Always answers 200 so the
// client can clear its state even when the token was already invalid.
export const logout = (req: Request, res: Response) => {
  try {
    const header = String(req.headers?.authorization || "");
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (token) {
      const decoded: any = verifySessionToken(token);
      if (decoded.jti && decoded.exp) revokeToken(decoded.jti, decoded.exp);
    }
  } catch { /* invalid / expired token: nothing to revoke */ }
  res.json({ message: "Logged out" });
};

// Invalidates EVERY session of the caller (all devices, including this one) by bumping passwordVersion,
// which requireAuth compares against the token. The client must log in again afterwards.
export const logoutAll = async (req: Request, res: Response) => {
  const reqUser = (req as any).user;
  const users = await readJSON("users.json") || [];
  const user = users.find((u: any) => u.id === reqUser?.id);
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  user.passwordVersion = (user.passwordVersion || 0) + 1;
  await writeJSON("users.json", users);
  res.json({ success: true, message: "All sessions were signed out" });
};

export const getMe = async (req: Request, res: Response) => {
  const reqUser = (req as any).user;
  if (reqUser && reqUser.id !== "temp-admin") {
    const users = await readJSON("users.json") || [];
    const dbUser = users.find((u: any) => u.id === reqUser.id);
    if (dbUser) {
      return res.json({
        user: {
          ...reqUser,
          email: dbUser.email || null,
          googleId: dbUser.googleId || null,
          isGoogleUser: !!(dbUser.googleId || !dbUser.password),
          twoFactorEnabled: !!dbUser.twoFactorEnabled,
          avatar: dbUser.avatar || null,
          discordId: dbUser.discordId || null,
          discordUsername: dbUser.discordUsername || null,
          discordAvatar: dbUser.discordAvatar || null
        }
      });
    }
  }
  res.json({ user: reqUser });
};

export const getUsers = async (req: Request, res: Response) => {
  const users = await readJSON("users.json") || [];
  const caller = (req as any).user;
  const isStaff = caller && (caller.role === "admin" || caller.role === "owner");
  if (!isStaff) {
    // Regular users only get the minimum needed (id + username); no roles or IP addresses.
    res.json(users.map((u: any) => ({ id: u.id, username: u.username })));
    return;
  }
  res.json(users.map((u: any) => ({ id: u.id, username: u.username, role: u.role, isGoogleUser: !!u.googleId, lastIp: u.lastIp || null })));
};

export const changeUsername = async (req: Request, res: Response) => {
  const reqUser = (req as any).user;
  const { newUsername } = req.body;

  if (!newUsername || typeof newUsername !== "string" || newUsername.trim().length < 3) {
    return res.status(400).json({ error: "Username must be at least 3 characters long." });
  }

  const cleanUsername = newUsername.trim();

  if (reqUser.id === "temp-admin") {
    return res.status(400).json({ error: "Cannot change username of default admin account." });
  }

  const users = await readJSON("users.json") || [];
  const userIndex = users.findIndex((u: any) => u.id === reqUser.id);

  if (userIndex === -1) {
    return res.status(404).json({ error: "User not found" });
  }

  if (!users[userIndex].googleId) {
    return res.status(400).json({ error: "Username change is only available for Google authenticated accounts." });
  }

  const existingUser = users.find((u: any) => u.id !== reqUser.id && u.username && u.username.toLowerCase() === cleanUsername.toLowerCase());
  if (existingUser) {
    return res.status(400).json({ error: `Username '${cleanUsername}' is already taken.` });
  }

  users[userIndex].username = cleanUsername;
  await writeJSON("users.json", users);

  res.json({ success: true, username: cleanUsername });
};

export const changeAvatar = async (req: Request, res: Response) => {
  const reqUser = (req as any).user;
  const { avatar } = req.body;

  if (avatar !== null && (typeof avatar !== "string" || (avatar && !avatar.startsWith("data:image/")))) {
    return res.status(400).json({ error: "Invalid avatar image." });
  }

  if (reqUser.id === "temp-admin") {
    return res.status(400).json({ error: "Cannot set avatar for the default admin account." });
  }

  const users = await readJSON("users.json") || [];
  const userIndex = users.findIndex((u: any) => u.id === reqUser.id);

  if (userIndex === -1) {
    return res.status(404).json({ error: "User not found" });
  }

  users[userIndex].avatar = avatar || null;
  await writeJSON("users.json", users);

  res.json({ success: true, avatar: users[userIndex].avatar });
};

export const changePassword = async (req: Request, res: Response) => {
  const reqUser = (req as any).user;
  const { oldPassword, newPassword } = req.body;
  
  if (reqUser.id === "temp-admin") {
    return res.status(400).json({ error: "Cannot change password of default admin account. Create a new admin user instead." });
  }

  const users = await readJSON("users.json") || [];
  const userIndex = users.findIndex((u: any) => u.id === reqUser.id);
  
  if (userIndex === -1) {
    return res.status(404).json({ error: "User not found" });
  }

  if (users[userIndex].googleId || !users[userIndex].password) {
    return res.status(400).json({ error: "Password change is disabled for Google Auth accounts." });
  }

  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: "New password must be at least 8 characters" });
  }
  
  const isMatch = await bcrypt.compare(oldPassword || "", users[userIndex].password);
  if (!isMatch) {
    return res.status(401).json({ error: "Incorrect old password" });
  }

  // Use dynamic import for writeJSON since it's in another file
  const { writeJSON } = await import("../services/db.js");
  const hashedPassword = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  
  users[userIndex].password = hashedPassword;
  users[userIndex].passwordVersion = (users[userIndex].passwordVersion || 0) + 1;
  await writeJSON("users.json", users);
  
  res.json({ success: true });
};

export const changeEmail = async (req: Request, res: Response) => {
  const reqUser = (req as any).user;
  const { newEmail, password } = req.body;

  if (reqUser.id === "temp-admin") {
    return res.status(400).json({ error: "Cannot change email of default admin account. Create a new admin user instead." });
  }

  if (!newEmail || typeof newEmail !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail.trim())) {
    return res.status(400).json({ error: "Please enter a valid email address." });
  }

  const cleanEmail = newEmail.trim().toLowerCase();

  const users = await readJSON("users.json") || [];
  const userIndex = users.findIndex((u: any) => u.id === reqUser.id);

  if (userIndex === -1) {
    return res.status(404).json({ error: "User not found" });
  }

  const target = users[userIndex];

  // Local (password-based) accounts must confirm their current password
  // before changing the email on file, same as a password change.
  if (target.password) {
    const isMatch = await bcrypt.compare(password || "", target.password);
    if (!isMatch) {
      return res.status(401).json({ error: "Incorrect password" });
    }
  }

  const existingUser = users.find((u: any) => u.id !== reqUser.id && u.email && u.email.toLowerCase() === cleanEmail);
  if (existingUser) {
    return res.status(400).json({ error: "This email address is already in use." });
  }

  target.email = cleanEmail;
  await writeJSON("users.json", users);

  res.json({ success: true, email: cleanEmail });
};

export const googleLogin = async (req: Request, res: Response) => {
  // Identity comes ONLY from a Firebase ID token verified server-side. The email / googleId /
  // name fields a client may still send are ignored: they are attacker-controlled.
  const { idToken } = req.body || {};
  if (typeof idToken !== "string" || !idToken) {
    res.status(400).json({ error: "Google sign-in needs a verified token. Please reload the page and try again." });
    return;
  }

  const settings = await readJSON("settings.json") || {};
  if (settings.enableGoogleLogin !== true) {
    res.status(403).json({ error: "Google Login is disabled on this panel." });
    return;
  }
  const projectId = typeof settings.firebaseProjectId === "string" ? settings.firebaseProjectId.trim() : "";
  if (!projectId) {
    res.status(503).json({ error: "Google Login is not configured (missing Firebase project id)." });
    return;
  }

  let identity;
  try {
    identity = await verifyFirebaseIdToken(idToken, projectId);
  } catch (err: any) {
    console.warn("[auth] Google token rejected:", err?.message || err);
    res.status(401).json({ error: "Google sign-in could not be verified." });
    return;
  }
  if (!identity.emailVerified) {
    res.status(401).json({ error: "Your Google email address is not verified." });
    return;
  }

  const users = await readJSON("users.json") || [];
  // Match ONLY on the stable Google uid. Matching an existing local account by email would let anyone who
  // registered a local account with someone else's (never verified) address capture that person's later
  // Google sign-in. Existing local accounts are linked explicitly via POST /api/auth/google/link while logged in.
  let user = users.find((u: any) => u.googleId && u.googleId === identity.uid);

  if (!user) {
    const isFirstUser = users.length === 0;
    const taken = new Set(users.map((u: any) => String(u.username || "").toLowerCase()));
    const base = identity.email.split("@")[0].replace(/[^a-zA-Z0-9_.]/g, "").slice(0, 24) || "user";
    let username = base;
    while (taken.has(username.toLowerCase())) username = `${base}${crypto.randomBytes(2).toString("hex")}`;
    user = {
      id: "google-user-" + Date.now() + "-" + crypto.randomBytes(5).toString("hex"),
      username,
      email: identity.email,
      googleId: identity.uid,
      role: isFirstUser ? "admin" : "user",
      avatar: identity.picture || "",
      passwordVersion: 0,
      createdAt: new Date().toISOString(),
    };
    users.push(user);
  } else {
    if (user.suspended) {
      res.status(403).json({ error: "This account has been suspended. Please contact an administrator." });
      return;
    }
    if (identity.picture && !user.avatar) user.avatar = identity.picture;
  }

  user.lastIp = getClientIp(req);
  user.lastLoginAt = new Date().toISOString();
  await writeJSON("users.json", users);

  const role = user.role || "user";
  const token = jwt.sign(
    { id: user.id, username: user.username, role, passwordVersion: user.passwordVersion || 0 },
    JWT_SECRET,
    { expiresIn: "7d", jwtid: crypto.randomUUID() }
  );

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      role,
      email: user.email,
      avatar: user.avatar,
      googleId: user.googleId,
      isGoogleUser: true,
    },
  });
};

// ---------------------------------------------------------------------------
// Discord account connect (link a Discord account to an existing panel user)
// ---------------------------------------------------------------------------

function getDiscordRedirectUri(req: Request): string {
  const host = (req.headers["x-forwarded-host"] as string)?.split(",")[0] || req.headers.host;
  // Discord requires https redirect URIs except for localhost/127.0.0.1 dev setups.
  const isLocal = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host || "");
  const forwardedProto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0];
  const proto = isLocal ? (forwardedProto || req.protocol || "http") : "https";
  return `${proto}://${host}/api/auth/discord/callback`;
}

// GET /api/auth/discord/connect - logged-in user requests the Discord OAuth URL
export const getDiscordConnectUrl = async (req: Request, res: Response) => {
  const settings = await readJSON("settings.json") || {};
  if (!settings.enableDiscordConnect) {
    res.status(403).json({ error: "Discord Connect is disabled on this panel." });
    return;
  }
  if (!settings.discordClientId) {
    res.status(500).json({ error: "Discord Client ID has not been configured by the administrator yet." });
    return;
  }

  const currentUser = (req as any).user;
  // Short-lived state token identifies which panel user is connecting, since
  // Discord's redirect back to us won't carry our normal auth header.
  const state = jwt.sign({ uid: currentUser.id, purpose: "discord-connect" }, JWT_SECRET, { expiresIn: "10m" });

  const redirectUri = getDiscordRedirectUri(req);
  const params = new URLSearchParams({
    client_id: settings.discordClientId.trim(),
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "identify",
    state,
    prompt: "consent",
  });

  res.json({ url: `https://discord.com/api/oauth2/authorize?${params.toString()}` });
};

// GET /api/auth/discord/callback - Discord redirects here after user approves
export const discordCallback = async (req: Request, res: Response) => {
  const { code, state, error: discordError } = req.query as { code?: string; state?: string; error?: string };

  if (discordError || !code || !state) {
    res.redirect(`/settings?discord=error&reason=${encodeURIComponent(discordError || "missing_code")}`);
    return;
  }

  let decoded: any;
  try {
    decoded = jwt.verify(state, JWT_SECRET, { algorithms: ["HS256"] });
    if (decoded.purpose !== "discord-connect") throw new Error("bad state");
  } catch {
    res.redirect("/settings?discord=error&reason=expired_state");
    return;
  }

  const settings = await readJSON("settings.json") || {};
  if (!settings.discordClientId || !settings.discordClientSecret) {
    res.redirect("/settings?discord=error&reason=not_configured");
    return;
  }

  try {
    const axios = (await import("axios")).default;
    const redirectUri = getDiscordRedirectUri(req);

    const tokenRes = await axios.post(
      "https://discord.com/api/oauth2/token",
      new URLSearchParams({
        client_id: settings.discordClientId.trim(),
        client_secret: settings.discordClientSecret.trim(),
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const accessToken = tokenRes.data.access_token;
    const profileRes = await axios.get("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const discordUser = profileRes.data;
    const discordAvatar = discordUser.avatar
      ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
      : null;

    const users = await readJSON("users.json") || [];
    // Prevent linking the same Discord account to more than one panel user.
    const alreadyLinked = users.find((u: any) => u.discordId === discordUser.id && u.id !== decoded.uid);
    if (alreadyLinked) {
      res.redirect("/settings?discord=already-linked");
      return;
    }

    const target = users.find((u: any) => u.id === decoded.uid);
    if (!target) {
      res.redirect("/settings?discord=error&reason=user_not_found");
      return;
    }

    target.discordId = discordUser.id;
    target.discordUsername = discordUser.discriminator && discordUser.discriminator !== "0"
      ? `${discordUser.username}#${discordUser.discriminator}`
      : discordUser.username;
    target.discordAvatar = discordAvatar;

    await writeJSON("users.json", users);
    res.redirect("/settings?discord=connected");
  } catch (err: any) {
    const discordErrDetail = err?.response?.data?.error_description || err?.response?.data?.error || err?.message || "unknown_error";
    console.error("Discord OAuth callback error:", err?.response?.data || err);
    res.redirect(`/settings?discord=error&reason=${encodeURIComponent(discordErrDetail)}`);
  }
};

// POST /api/auth/discord/disconnect - unlink the Discord account from the current user
export const disconnectDiscord = async (req: Request, res: Response) => {
  const currentUser = (req as any).user;
  const users = await readJSON("users.json") || [];
  const target = users.find((u: any) => u.id === currentUser.id);
  if (!target) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  delete target.discordId;
  delete target.discordUsername;
  delete target.discordAvatar;
  await writeJSON("users.json", users);
  res.json({ success: true });
};
