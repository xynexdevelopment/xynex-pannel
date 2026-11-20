import jwt from "jsonwebtoken";
import axios from "axios";

/* Server-side verification of Firebase (Google sign-in) ID tokens.
   The browser signs in with Firebase and sends the resulting ID token; this checks the
   RS256 signature against Google's published signing certificates and validates the claims
   Firebase documents (aud = project id, iss = securetoken, exp, sub). Nothing the client
   claims outside a verified token is trusted. */

const CERTS_URL = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;

export interface CertSet { certs: Record<string, string>; maxAgeMs: number }
export type CertFetcher = () => Promise<CertSet>;

async function defaultFetcher(): Promise<CertSet> {
  const res = await axios.get(CERTS_URL, { timeout: 5000 });
  const m = /max-age=(\d+)/.exec(String(res.headers?.["cache-control"] ?? ""));
  return { certs: res.data, maxAgeMs: m ? Number(m[1]) * 1000 : DEFAULT_MAX_AGE_MS };
}

let fetcher: CertFetcher = defaultFetcher;
let cache: { certs: Record<string, string>; expires: number } | null = null;

/** Test seam: swap the certificate source (and clear the cache). */
export function __setCertFetcherForTests(f: CertFetcher | null) {
  fetcher = f ?? defaultFetcher;
  cache = null;
}

async function getCerts(forceRefresh = false): Promise<Record<string, string>> {
  if (!forceRefresh && cache && cache.expires > Date.now()) return cache.certs;
  const { certs, maxAgeMs } = await fetcher();
  cache = { certs, expires: Date.now() + Math.max(60_000, maxAgeMs) };
  return certs;
}

export interface GoogleIdentity {
  uid: string;
  email: string;
  emailVerified: boolean;
  name: string;
  picture: string;
}

export async function verifyFirebaseIdToken(idToken: string, projectId: string): Promise<GoogleIdentity> {
  if (!projectId) throw new Error("Firebase project id is not configured");
  const decodedHeader = jwt.decode(idToken, { complete: true }) as any;
  const header = decodedHeader?.header;
  if (!header || header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("Unsupported token header");

  let certs = await getCerts();
  // Google rotates keys: on an unknown kid, refresh once before giving up.
  if (!certs[header.kid]) certs = await getCerts(true);
  const cert = certs[header.kid];
  if (!cert) throw new Error("Unknown signing key");

  const claims = jwt.verify(idToken, cert, {
    algorithms: ["RS256"],
    audience: projectId,
    issuer: `https://securetoken.google.com/${projectId}`,
  }) as any;

  if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 128) throw new Error("Invalid subject");
  if (typeof claims.email !== "string" || !claims.email.includes("@")) throw new Error("Token has no email");
  if (claims.auth_time && Number(claims.auth_time) > Math.floor(Date.now() / 1000) + 60) throw new Error("auth_time is in the future");

  return {
    uid: claims.sub,
    email: claims.email.toLowerCase(),
    emailVerified: claims.email_verified === true,
    name: typeof claims.name === "string" ? claims.name : "",
    picture: typeof claims.picture === "string" ? claims.picture : "",
  };
}
