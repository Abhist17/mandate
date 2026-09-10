import {NextResponse} from "next/server";
import {createPublicClient, http, getAddress, type Address} from "viem";
import {parseSiweMessage} from "@/lib/siwe";
import {
  NONCE_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  consumeNonce,
  cookieOptions,
  encodeSession,
} from "@/lib/session";

const RPC = process.env.NEXT_PUBLIC_MONAD_RPC ?? "https://testnet-rpc.monad.xyz";
const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 10143);

/** Max age of the message itself, independent of the nonce cookie. */
const MAX_MESSAGE_AGE_MS = 10 * 60 * 1000;

/**
 * Verify a SIWE signature and open a session.
 *
 * Every field is taken from the *signed message*, never from the request body. Trusting a
 * body-supplied address alongside a valid signature over different text is the classic way to
 * get this wrong: an attacker replays somebody else's signature and names themselves.
 */
export async function POST(req: Request) {
  let body: {message?: string; signature?: string};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({error: "Malformed request"}, {status: 400});
  }

  const {message, signature} = body;
  if (typeof message !== "string" || typeof signature !== "string") {
    return NextResponse.json({error: "Missing message or signature"}, {status: 400});
  }

  const fields = parseSiweMessage(message);
  if (!fields) return NextResponse.json({error: "Malformed sign-in message"}, {status: 400});

  // ── the nonce must be the one we issued to this browser ──────────────────────
  const cookieNonce = req.headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${NONCE_COOKIE}=`))
    ?.slice(NONCE_COOKIE.length + 1);

  if (!cookieNonce || cookieNonce !== fields.nonce) {
    return NextResponse.json({error: "Sign-in expired. Try again."}, {status: 401});
  }

  // Burn it server-side. Clearing the cookie is not enough: the cookie is client-controlled,
  // so a replayed signature can simply arrive with the old cookie attached.
  if (!consumeNonce(fields.nonce)) {
    return NextResponse.json({error: "This sign-in was already used"}, {status: 401});
  }

  // ── the message must be fresh and for this chain ─────────────────────────────
  const issued = Date.parse(fields.issuedAt);
  if (!Number.isFinite(issued) || Math.abs(Date.now() - issued) > MAX_MESSAGE_AGE_MS) {
    return NextResponse.json({error: "Sign-in message is stale"}, {status: 401});
  }
  if (fields.chainId !== CHAIN_ID) {
    return NextResponse.json({error: `Wrong network. Expected chain ${CHAIN_ID}.`}, {status: 401});
  }

  // ── the signature must be over exactly this text ─────────────────────────────
  // verifyMessage also handles EIP-1271, so a smart-contract wallet can sign in too.
  const client = createPublicClient({transport: http(RPC)});
  let valid = false;
  try {
    valid = await client.verifyMessage({
      address: fields.address as Address,
      message,
      signature: signature as `0x${string}`,
    });
  } catch {
    valid = false;
  }
  if (!valid) return NextResponse.json({error: "Signature does not match"}, {status: 401});

  const now = Math.floor(Date.now() / 1000);
  const session = {
    address: getAddress(fields.address),
    chainId: fields.chainId,
    issuedAt: now,
    expiresAt: now + SESSION_TTL_SECONDS,
  };

  const res = NextResponse.json({ok: true, session});
  res.cookies.set(SESSION_COOKIE, encodeSession(session), cookieOptions(SESSION_TTL_SECONDS));
  // Burn the nonce so the same signature cannot open a second session.
  res.cookies.set(NONCE_COOKIE, "", cookieOptions(0));
  return res;
}
