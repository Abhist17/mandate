import {createHmac, randomBytes, timingSafeEqual} from "node:crypto";

/**
 * Stateless signed sessions.
 *
 * No database and no session store: the cookie carries the claims and an HMAC over them, so
 * the server can verify it without remembering anything. That suits this app — the chain is
 * the source of truth, and a session only needs to answer "which address proved control of a
 * key, and when".
 *
 * The secret comes from AUTH_SECRET. In development a random one is generated at boot, which
 * means restarting the server invalidates sessions — noisy but safe. A fixed secret must be
 * set in production or every restart logs everyone out.
 */

const DEV_SECRET_WARNING =
  "[auth] AUTH_SECRET is not set — using an ephemeral secret. Sessions will not survive a restart.";

let cachedSecret: string | undefined;

function secret(): string {
  if (cachedSecret) return cachedSecret;
  const fromEnv = process.env.AUTH_SECRET;
  if (fromEnv && fromEnv.length >= 32) {
    cachedSecret = fromEnv;
  } else {
    if (process.env.NODE_ENV === "production") {
      // Refuse to run with a throwaway secret in production rather than silently issuing
      // sessions that die on the next deploy.
      throw new Error("AUTH_SECRET must be set (32+ chars) in production");
    }
    console.warn(DEV_SECRET_WARNING);
    cachedSecret = randomBytes(32).toString("hex");
  }
  return cachedSecret;
}

const b64url = (b: Buffer) => b.toString("base64url");

function sign(payload: string): string {
  return b64url(createHmac("sha256", secret()).update(payload).digest());
}

export type Session = {
  /** Checksummed address that signed in. */
  address: string;
  chainId: number;
  /** Unix seconds. */
  issuedAt: number;
  expiresAt: number;
};

export function encodeSession(s: Session): string {
  const payload = b64url(Buffer.from(JSON.stringify(s)));
  return `${payload}.${sign(payload)}`;
}

export function decodeSession(token: string | undefined): Session | undefined {
  if (!token) return undefined;
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return undefined;

  const expected = sign(payload);
  // Constant-time compare so a wrong signature cannot be discovered byte by byte.
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;

  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString()) as Session;
    if (typeof s.address !== "string" || typeof s.expiresAt !== "number") return undefined;
    if (s.expiresAt * 1000 < Date.now()) return undefined;
    return s;
  } catch {
    return undefined;
  }
}

export const SESSION_COOKIE = "mandate_session";
export const NONCE_COOKIE = "mandate_nonce";

/** Session lifetime. A week: long enough not to nag, short enough to expire a stale device. */
export const SESSION_TTL_SECONDS = 7 * 24 * 3600;

/** Nonce lifetime. Short — a sign-in that takes longer than this has probably been abandoned. */
export const NONCE_TTL_SECONDS = 10 * 60;

export function newNonce(): string {
  // 16 bytes of alphanumeric, per EIP-4361's requirement of at least 8 alphanumeric chars.
  return randomBytes(16).toString("hex");
}

export const cookieOptions = (maxAge: number) =>
  ({
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  });

/**
 * Nonces already spent.
 *
 * The nonce cookie alone does not prevent replay, and it is worth being precise about why:
 * the cookie is client-controlled, so clearing it in a response only affects a browser that
 * chooses to honour it. Anyone replaying a captured signature simply sends the old cookie
 * back. The server has to remember what it has consumed.
 *
 * In-memory, which is correct for a single instance and NOT correct behind a load balancer —
 * a second process would not know a nonce was spent. Running more than one instance means
 * moving this to shared storage. Stated here rather than discovered later.
 */
const consumed = new Map<string, number>();

/** Consume a nonce. Returns false if it was already spent. */
export function consumeNonce(nonce: string): boolean {
  pruneNonces();
  if (consumed.has(nonce)) return false;
  consumed.set(nonce, Date.now() + NONCE_TTL_SECONDS * 1000);
  return true;
}

function pruneNonces(): void {
  // Nonces expire anyway; dropping them keeps the map from growing without bound on a
  // long-lived server.
  if (consumed.size < 512) return;
  const now = Date.now();
  for (const [k, expiry] of consumed) {
    if (expiry < now) consumed.delete(k);
  }
}
