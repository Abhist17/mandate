import {NextResponse} from "next/server";
import {NONCE_COOKIE, NONCE_TTL_SECONDS, cookieOptions, newNonce} from "@/lib/session";

/**
 * Issue a single-use nonce for a sign-in attempt.
 *
 * Stored in an httpOnly cookie rather than a server-side set, so there is nothing to keep and
 * nothing to clean up. The nonce's whole job is to make a captured signature useless a second
 * time; binding it to the browser that requested it is enough for that.
 */
export async function GET() {
  const nonce = newNonce();
  const res = NextResponse.json({nonce});
  res.cookies.set(NONCE_COOKIE, nonce, cookieOptions(NONCE_TTL_SECONDS));
  return res;
}
