/**
 * End-to-end check of the Sign-In With Ethereum flow, including the attacks it must refuse.
 *
 * Exists because the happy path passing proves very little about an auth system. Every case
 * below is a way this could be wrong while still "working" for an honest user — and one of
 * them (nonce replay) was in fact wrong when this was first written.
 *
 * Run: npx tsx scripts/auth-check.mts [baseUrl]
 */
import {privateKeyToAccount, generatePrivateKey} from "viem/accounts";

const BASE = process.argv[2] ?? "http://127.0.0.1:3000";
const HOST = new URL(BASE).host;
const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 10143);

const acct = privateKeyToAccount(generatePrivateKey());
const attacker = privateKeyToAccount(generatePrivateKey());

let failed = false;
const ok = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m: string) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); failed = true; };
const head = (m: string) => console.log(`\n${m}`);

function build(address: string, nonce: string, chainId = CHAIN_ID, issuedAt = new Date().toISOString()) {
  return [
    `${HOST} wants you to sign in with your Ethereum account:`,
    address, "",
    "Sign in to Mandate. This proves you control this address. It is a signature, not a transaction — it costs nothing and moves no funds.",
    "", `URI: ${BASE}`, "Version: 1", `Chain ID: ${chainId}`, `Nonce: ${nonce}`, `Issued At: ${issuedAt}`,
  ].join("\n");
}

async function getNonce() {
  const r = await fetch(`${BASE}/api/auth/nonce`);
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0]!;
  const {nonce} = (await r.json()) as {nonce: string};
  return {nonce, cookie};
}

const verify = (message: string, signature: string, cookie?: string) =>
  fetch(`${BASE}/api/auth/verify`, {
    method: "POST",
    headers: {"Content-Type": "application/json", ...(cookie ? {cookie} : {})},
    body: JSON.stringify({message, signature}),
  });

head("valid sign-in");
const {nonce, cookie} = await getNonce();
const msg = build(acct.address, nonce);
const sig = await acct.signMessage({message: msg});
const res = await verify(msg, sig, cookie);
res.ok ? ok("a real signature opens a session") : bad(`rejected a valid signature (${res.status})`);

const sessionCookie =
  (res.headers.get("set-cookie") ?? "").split(",").map((c) => c.trim())
    .find((c) => c.startsWith("mandate_session="))?.split(";")[0] ?? "";
const me = await (await fetch(`${BASE}/api/auth/me`, {headers: {cookie: sessionCookie}})).json() as
  {session: {address: string} | null};
me.session?.address.toLowerCase() === acct.address.toLowerCase()
  ? ok("/me reports the address that signed")
  : bad(`/me reported ${me.session?.address}`);

head("replay");
const replay = await verify(msg, sig, cookie);
replay.status === 401
  ? ok("the same signature cannot open a second session")
  : bad(`replay accepted (${replay.status}) — the nonce was not burnt server-side`);

head("identity swap");
{
  const n = await getNonce();
  const victimMsg = build(acct.address, n.nonce);
  const victimSig = await acct.signMessage({message: victimMsg});
  const swapped = build(attacker.address, n.nonce);
  const r = await verify(swapped, victimSig, n.cookie);
  r.status === 401
    ? ok("a signature over different text cannot authenticate someone else")
    : bad(`identity swap accepted (${r.status})`);
}

head("missing nonce");
{
  const n = await getNonce();
  const m = build(acct.address, n.nonce);
  const s = await acct.signMessage({message: m});
  const r = await verify(m, s);
  r.status === 401 ? ok("a signature without our nonce is refused") : bad(`accepted (${r.status})`);
}

head("wrong network");
{
  const n = await getNonce();
  const m = build(acct.address, n.nonce, 1);
  const s = await acct.signMessage({message: m});
  const r = await verify(m, s, n.cookie);
  r.status === 401 ? ok("a message for another chain is refused") : bad(`accepted (${r.status})`);
}

head("stale message");
{
  const n = await getNonce();
  const m = build(acct.address, n.nonce, CHAIN_ID, new Date(Date.now() - 3600_000).toISOString());
  const s = await acct.signMessage({message: m});
  const r = await verify(m, s, n.cookie);
  r.status === 401 ? ok("an hour-old message is refused") : bad(`accepted (${r.status})`);
}

head("forged session cookie");
{
  const payload = Buffer.from(
    JSON.stringify({address: attacker.address, chainId: CHAIN_ID, issuedAt: 0, expiresAt: 9e9}),
  ).toString("base64url");
  const r = await (await fetch(`${BASE}/api/auth/me`, {
    headers: {cookie: `mandate_session=${payload}.forged`},
  })).json() as {session: unknown};
  r.session === null ? ok("a cookie without a valid HMAC is ignored") : bad("forged cookie accepted");
}

head("logout");
{
  const r = await fetch(`${BASE}/api/auth/logout`, {method: "POST", headers: {cookie: sessionCookie}});
  r.ok ? ok("logout clears the session") : bad("logout failed");
}

console.log(
  failed
    ? "\n\x1b[31mAUTH CHECK FAILED\x1b[0m\n"
    : "\n\x1b[32mAUTH CHECK PASSED\x1b[0m — every replay and forgery path refused\n",
);
process.exit(failed ? 1 : 0);
