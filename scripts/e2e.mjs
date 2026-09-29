/**
 * End to end, through the real UI, as the people who use it.
 *
 * A trader signs in, claims a mandate, trades, and checks a number against the contract. The
 * market moves. A second, unrelated wallet — a searcher — finds the breach on the bounty
 * board, enforces it, and is paid by the contract. The trader sees what happened; the public
 * page and the passport record it. An LP takes test funds from the faucet and deposits.
 *
 * A real EIP-1193 provider is injected into the page and bridged to Node over CDP: the page
 * asks, Node signs with a fresh key and sends to the chain. Every step is checked against
 * chain state directly, not only against what the page shows — the page claiming success is
 * exactly the thing under test.
 *
 * Needs the local stack (./scripts/up.sh) and Chrome.   make e2e  ·  node scripts/e2e.mjs
 */
import {spawn, execSync} from "node:child_process";
import {writeFileSync, mkdirSync, openSync} from "node:fs";

const V = await import("viem");
const A = await import("viem/accounts");

const BASE = "http://localhost:3000";
const RPC = "http://127.0.0.1:8546";
const OUT = process.env.OUT ?? ".local-logs/e2e";
mkdirSync(OUT, {recursive: true});
const env = process.env;
const chain = {id: 10143, name: "Monad fork", nativeCurrency: {name: "MON", symbol: "MON", decimals: 18}, rpcUrls: {default: {http: [RPC]}}};
const pub = V.createPublicClient({chain, transport: V.http(RPC)});

const reg = {address: env.MANDATE_REGISTRY_ADDRESS, abi: V.parseAbi([
  "function mandatesOf(address) view returns (uint256[])",
  "function isActive(uint256) view returns (bool)",
  "function liveEquity(uint256) view returns (uint256)",
  "function floorOf(uint256) view returns (uint256,uint256)",
])};
const oracle = {address: env.ORACLE_ADDRESS, abi: V.parseAbi([
  "function price(uint16) view returns (uint256,uint64)",
  "function forcePrice(uint16,uint256,uint64)",
])};
const erc20 = V.parseAbi(["function balanceOf(address) view returns (uint256)"]);

// ── the user ────────────────────────────────────────────────────────────────
const user = A.privateKeyToAccount(A.generatePrivateKey());
const userWallet = V.createWalletClient({account: user, chain, transport: V.http(RPC)});
await pub.request({method: "anvil_setBalance", params: [user.address, "0x8AC7230489E80000"]}); // 10 MON, as the faucet would
// The wallet the page is talking to right now. Switched to a second, unrelated wallet for
// the enforcement step: the searcher.
let me = {account: user, wallet: userWallet};
const owner = V.createWalletClient({account: A.privateKeyToAccount(env.PRIVATE_KEY), chain, transport: V.http(RPC)});

const report = [];
const txs = [];
const errors = [];
const t0 = Date.now();
const ok = (step, detail) => { report.push({step, ok: true, detail}); console.log(`✓ ${step}${detail ? " — " + detail : ""}`); };
const bad = (step, detail) => { report.push({step, ok: false, detail}); console.log(`✗ ${step}${detail ? " — " + detail : ""}`); };
const usd = (v) => `$${(Number(v) / 1e6).toLocaleString("en-US", {maximumFractionDigits: 2})}`;

// ── browser ─────────────────────────────────────────────────────────────────
const CDP = 9520;
const chrome = spawn("google-chrome", ["--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  `--remote-debugging-port=${CDP}`, "--window-size=1440,1000", "about:blank"], {stdio: "ignore"});
await new Promise((r) => setTimeout(r, 2500));
const target = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find((x) => x.type === "page");
const ws = new WebSocket(target.webSocketDebuggerUrl);
let seq = 0;
const pend = new Map();
const send = (method, params = {}) => new Promise((res) => { const i = ++seq; pend.set(i, res); ws.send(JSON.stringify({id: i, method, params})); });
const js = async (expr) => {
  const r = await send("Runtime.evaluate", {expression: expr, awaitPromise: true, returnByValue: true});
  return r.result?.result?.value;
};

const NOISE = /favicon|DevTools|Autofill|net::ERR_ABORTED|Download the React DevTools/i;
ws.onmessage = async (e) => {
  const d = JSON.parse(e.data);
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); return; }
  if (d.method === "Runtime.bindingCalled" && d.params.name === "__walletBridge") return void wallet(JSON.parse(d.params.payload));
  if (d.method === "Runtime.exceptionThrown") errors.push("exception: " + (d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text).slice(0, 240));
  if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") {
    const m = d.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    if (!NOISE.test(m)) errors.push("console: " + m.slice(0, 240));
  }
  if (d.method === "Log.entryAdded" && d.params.entry.level === "error" && !NOISE.test(d.params.entry.text)) errors.push("log: " + d.params.entry.text.slice(0, 240));
};
await new Promise((r) => { ws.onopen = r; });

// The provider the page sees. Requests cross to Node through a CDP binding; replies come
// back through window.__walletReply.
const SHIM = `(() => {
  let n = 0; const pending = new Map(); const listeners = {};
  window.__walletReply = (id, ok, payload) => {
    const p = pending.get(id); if (!p) return; pending.delete(id);
    if (ok) p.resolve(payload); else { const e = new Error(payload.message); e.code = payload.code; p.reject(e); }
  };
  const request = ({method, params}) => new Promise((resolve, reject) => {
    const id = ++n; pending.set(id, {resolve, reject});
    window.__walletBridge(JSON.stringify({id, method, params: params ?? []}));
  });
  window.ethereum = {
    isMetaMask: true, request,
    on: (ev, cb) => { (listeners[ev] ||= []).push(cb); },
    removeListener: (ev, cb) => { listeners[ev] = (listeners[ev] || []).filter((f) => f !== cb); },
  };
})();`;

const walletCalls = {};
async function wallet({id, method, params}) {
  walletCalls[method] = (walletCalls[method] ?? 0) + 1;
  let good = true, out;
  try {
    switch (method) {
      case "eth_requestAccounts": case "eth_accounts": out = [me.account.address]; break;
      case "eth_chainId": out = "0x279f"; break;
      case "net_version": out = "10143"; break;
      case "wallet_switchEthereumChain": case "wallet_addEthereumChain": out = null; break;
      case "personal_sign": out = await me.account.signMessage({message: {raw: params[0]}}); break;
      case "eth_sendTransaction": {
        const tx = params[0];
        const hash = await me.wallet.sendTransaction({
          to: tx.to, data: tx.data,
          value: tx.value ? BigInt(tx.value) : undefined,
          gas: tx.gas ? BigInt(tx.gas) : undefined,
        });
        const rcpt = await pub.waitForTransactionReceipt({hash});
        txs.push({selector: tx.data?.slice(0, 10), to: tx.to, hash, status: rcpt.status, gas: Number(rcpt.gasUsed)});
        out = hash;
        break;
      }
      default: {
        const r = await fetch(RPC, {method: "POST", headers: {"content-type": "application/json"},
          body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params})});
        const j = await r.json();
        if (j.error) throw Object.assign(new Error(j.error.message), {code: j.error.code});
        out = j.result;
      }
    }
  } catch (err) {
    good = false;
    out = {code: err.code ?? -32603, message: String(err.shortMessage ?? err.message ?? err).slice(0, 300)};
  }
  await send("Runtime.evaluate", {expression: `window.__walletReply(${id}, ${good}, ${JSON.stringify(out ?? null)})`});
}

await send("Page.enable");
await send("Runtime.enable");
await send("Log.enable");
await send("Runtime.addBinding", {name: "__walletBridge"});
await send("Page.addScriptToEvaluateOnNewDocument", {source: SHIM});

// ── helpers ─────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function nav(path) { await send("Page.navigate", {url: BASE + path}); await sleep(1500); }
// Text and expressions are both strings, so they are separate helpers. The first version
// treated every string as text — every expression check searched the page for its own source
// and could never pass, which is where most of the first run's "failures" came from.
async function waitJs(expr, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await js(expr)) return true; await sleep(300); }
  return false;
}
const waitFor = (text, timeout = 30000) =>
  waitJs(`document.body && document.body.innerText.toLowerCase().includes(${JSON.stringify(text.toLowerCase())})`, timeout);
async function click(label, {starts = false} = {}) {
  return js(`(() => {
    const want = ${JSON.stringify(label.toLowerCase())};
    const els = [...document.querySelectorAll('button, a')].filter((b) => {
      const t = b.textContent.trim().toLowerCase();
      return (${starts} ? t.startsWith(want) : t === want) && !b.disabled && b.offsetParent !== null;
    });
    if (!els.length) return false;
    els[0].scrollIntoView({block: "center"}); els[0].click(); return true;
  })()`);
}
async function type(selector, value) {
  await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({block:"center"}); el.focus(); el.select?.(); })()`);
  await send("Input.dispatchKeyEvent", {type: "keyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65});
  await send("Input.dispatchKeyEvent", {type: "keyUp", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65});
  await send("Input.insertText", {text: value});
}
let shotN = 0;
async function shot(name) {
  const s = await send("Page.captureScreenshot", {format: "png"});
  const f = `${OUT}/${String(++shotN).padStart(2, "0")}-${name}.png`;
  writeFileSync(f, Buffer.from(s.result.data, "base64"));
  return f;
}
const errsSince = (n) => errors.slice(n);

// ── 1. the front door ───────────────────────────────────────────────────────
let e0 = errors.length;
await nav("/");
(await waitFor("The rules are the contract")) ? ok("Landing renders", "headline, engine and live tape") : bad("Landing renders");
await js(`(() => { const d = [...document.querySelectorAll('div')].find(d => /^monad block/i.test(d.textContent.trim())); d && d.scrollIntoView({block: 'center'}); })()`);
await waitJs(`[...document.querySelectorAll('span')].some(s => /^[0-9]{2},[0-9]{3},[0-9]{3}$/.test(s.textContent.trim()))`, 15000)
  ? ok("Live tape reads the chain", "block height present") : bad("Live tape reads the chain", "no block height");
await shot("landing");
errsSince(e0).length ? bad("Landing console clean", errsSince(e0).join(" | ")) : ok("Landing console clean");

// ── 2. sign in with the wallet ──────────────────────────────────────────────
e0 = errors.length;
await nav("/trade");
await waitFor("Distance to floor", 40000);
await waitJs(`[...document.querySelectorAll('button')].some(b => /^(sign in|connect wallet)$/i.test(b.textContent.trim()))`, 15000);
for (let i = 0; i < 3; i++) {
  if (await js(`fetch('/api/auth/me').then(r => r.ok ? r.json() : null).then(j => !!(j && j.address)).catch(() => false)`)) break;
  (await click("sign in")) || (await click("connect wallet"));
  await sleep(3500);
}
const session = await js(`fetch('/api/auth/me').then(r => r.ok ? r.json() : null).catch(() => null)`);
(session?.session?.address ?? session?.address)?.toLowerCase() === user.address.toLowerCase()
  ? ok("Sign-in (SIWE)", `session for ${user.address.slice(0, 10)}… via personal_sign`)
  : bad("Sign-in (SIWE)", JSON.stringify(session));
await shot("signed-in");

// ── 3. get funded ───────────────────────────────────────────────────────────
const haveClaim = await waitJs(`[...document.querySelectorAll('button')].some(b => /^claim a .* mandate$/i.test(b.textContent.trim()) && !b.disabled)`, 20000);
if (!haveClaim) bad("Claim button offered", await js(`[...document.querySelectorAll('button')].map(b=>b.textContent.trim()).filter(Boolean).slice(0,30).join(' / ')`));
await click("claim a zero mandate");
let ids = [];
for (let i = 0; i < 40 && ids.length === 0; i++) { await sleep(750); ids = await pub.readContract({...reg, functionName: "mandatesOf", args: [user.address]}); }
const id = ids.at(-1);
id !== undefined ? ok("Claim a Zero mandate", `mandate #${id} issued to the new user on chain`) : bad("Claim a Zero mandate", "no mandate on chain");
(await waitJs(`[...document.querySelectorAll('nav[aria-label="Breadcrumb"] span')].some(s => s.textContent.trim() === 'Mandate #${id}')`, 20000))
  ? ok("Dashboard opens on the new mandate", `breadcrumb shows Mandate #${id}`) : bad("Dashboard opens on the new mandate");
await sleep(1500);
await shot("funded");

// ── 4. trade ────────────────────────────────────────────────────────────────
const eqBefore = await pub.readContract({...reg, functionName: "liveEquity", args: [id]});
await type('input[placeholder="0.00"]', "1.4");
await sleep(300);
const tradable = await waitJs(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Short' && !b.disabled)`, 45000);
tradable ? ok("Trade panel enabled", "feed fresh against the contract's own bound") : bad("Trade panel enabled", await js(`document.body.innerText.match(/Trading is paused[^\\n]*/)?.[0] ?? 'disabled, no reason shown'`));
(await click("short")) || bad("Short button clickable");
const filled = await waitJs(`document.body.innerText.toLowerCase().includes('short btc')`, 30000);
const shortTx = txs.find((t) => t.to?.toLowerCase() !== env.DEMO_ISSUER_ADDRESS?.toLowerCase() && t.status === "success" && txs.indexOf(t) > 0);
if (!filled) console.log("   page said:", await js(`(document.body.innerText.match(/[^\\n]*(fail|revert|refus|stale|error)[^\\n]*/ig) || []).slice(0,4).join(' | ')`));
filled ? ok("Open a position", `SHORT 1.4 BTC shows in the book${shortTx ? `, gas ${shortTx.gas.toLocaleString()}` : ""}`) : bad("Open a position", "no SHORT BTC row");
await sleep(4500);
const [floor] = await pub.readContract({...reg, functionName: "floorOf", args: [id]});
const eq = await pub.readContract({...reg, functionName: "liveEquity", args: [id]});
ok("Watch the floor", `equity ${usd(eq)} (was ${usd(eqBefore)}), floor ${usd(floor)}, headroom ${usd(eq - floor)}`);
await shot("trading");

// ── 5. verify a number against the contract ─────────────────────────────────
(await click("headroom()", {starts: true})) || bad("Proof chip clickable");
await waitFor("Verify this number", 8000);
await click("run this call now");
const verdict = (await waitFor("Matches what the screen is showing", 12000)) ? "match" : (await waitFor("does not match", 1000)) ? "MISMATCH" : "none";
verdict === "match" ? ok("Proof drawer re-runs the call", "live eth_call matches the screen") : bad("Proof drawer re-runs the call", verdict);
await shot("proof");
await send("Input.dispatchKeyEvent", {type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27});
await sleep(400);
errsSince(e0).length ? bad("Dashboard console clean", errsSince(e0).join(" | ")) : ok("Dashboard console clean");

// ── 5b. the proof drawer must not cry wolf ──────────────────────────────────
// Regression: the drawer compared the screen with a fresh read at "latest", so any price
// push between the two made it announce that the dashboard was wrong. It now re-runs the
// call at the block the screen read from. Move the market while the drawer is open and it
// must still match — and show the newer value as context.
await nav("/trade?m=1");
await waitFor("Distance to floor", 30000);
await sleep(2000);
(await click("headroom()", {starts: true})) || bad("Proof chip on a live mandate");
await waitFor("Verify this number", 8000);
{
  const [p1] = await pub.readContract({...oracle, functionName: "price", args: [16]});
  const t1 = (await pub.getBlock()).timestamp;
  await pub.waitForTransactionReceipt({hash: await owner.writeContract({...oracle, functionName: "forcePrice", args: [16, (p1 * 1005n) / 1000n, t1]})});
  await click("run this call now");
  const same = await waitFor("at the same block", 12000);
  const moved = await waitFor("the chain has moved since", 4000);
  same && moved
    ? ok("Proof drawer verifies at the screen's block", "matches despite a price move mid-check, and shows the newer value")
    : bad("Proof drawer verifies at the screen's block", `same-block match: ${same}, moved note: ${moved}`);
  const t2 = (await pub.getBlock()).timestamp;
  await pub.waitForTransactionReceipt({hash: await owner.writeContract({...oracle, functionName: "forcePrice", args: [16, p1, t2]})});
}
await send("Input.dispatchKeyEvent", {type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27});

// ── 6. the public page ──────────────────────────────────────────────────────
const pubPage = await fetch(`${BASE}/m/${id}`).then(async (r) => ({code: r.status, html: await r.text()}));
/Active/i.test(pubPage.html) && pubPage.code === 200 ? ok("Public mandate page", `/m/${id} server-renders, status Active`) : bad("Public mandate page", `http ${pubPage.code}`);
const og = await fetch(`${BASE}/m/${id}/opengraph-image`);
og.status === 200 && og.headers.get("content-type")?.includes("image/png")
  ? ok("Share card renders", `${(await og.arrayBuffer()).byteLength} byte PNG`) : bad("Share card renders", `http ${og.status}`);

// ── 7. the market moves; a stranger enforces, and is paid ───────────────────
// The keeper is stopped so the breach waits for someone else: the claim under test is that a
// second, unrelated wallet finds it on the bounty board, enforces it, and the contract pays it.
execSync(`pkill -f 'keeper/src/index\\.ts' || true`); // the whole npm → sh → node tree
ok("Keeper stopped for the breach test");

const [p0] = await pub.readContract({...oracle, functionName: "price", args: [16]});
const now = (await pub.getBlock()).timestamp;
await pub.waitForTransactionReceipt({hash: await owner.writeContract({...oracle, functionName: "forcePrice", args: [16, (p0 * 104n) / 100n, now]})});
const eqHit = await pub.readContract({...reg, functionName: "liveEquity", args: [id]});
ok("BTC forced up 4%", `$${(Number(p0) / 1e8).toFixed(0)} → $${(Number(p0) * 1.04 / 1e8).toFixed(0)}; equity ${usd(eqHit)} vs floor ${usd(floor)}`);

// the trader's own dashboard offers it to them — with no bounty, since it is theirs
await nav(`/trade?m=${id}`);
(await waitFor("Enforce this breach", 30000)) ? ok("Trader's dashboard offers enforcement") : bad("Trader's dashboard offers enforcement");
(await waitFor("nobody earns from their own breach", 5000)) ? ok("…and says the trader earns nothing for it") : bad("…and says the trader earns nothing for it");

// a searcher arrives
const searcher = A.privateKeyToAccount(A.generatePrivateKey());
await pub.request({method: "anvil_setBalance", params: [searcher.address, "0x8AC7230489E80000"]});
me = {account: searcher, wallet: V.createWalletClient({account: searcher, chain, transport: V.http(RPC)})};
const sBefore = await pub.readContract({address: env.POOL_ASSET_ADDRESS, abi: erc20, functionName: "balanceOf", args: [searcher.address]});
await nav("/enforce");
const bps = await pub.readContract({address: env.MANDATE_REGISTRY_ADDRESS, abi: V.parseAbi(["function enforcementBountyBps() view returns (uint16)"]), functionName: "enforcementBountyBps"});
const bounty = (100_000n * 1_000_000n * BigInt(bps)) / 10_000n; // Zero preset allocation
const dollars = (Number(bounty) / 1e6).toLocaleString("en-US", {minimumFractionDigits: 2, maximumFractionDigits: 2});
// Plain text, compared lowercased — a regex inside a template literal loses its escapes
// (\$ collapses to an end-of-string anchor), which is how the first version never matched.
const label = `enforce · earn $${dollars}`;
const offered = await waitJs(`[...document.querySelectorAll('button')].some(b => b.textContent.trim().toLowerCase() === ${JSON.stringify(label)} && !b.disabled)`, 30000);
offered ? ok("Bounty board offers the searcher its bounty", `'${label}'`) : bad("Bounty board offers the searcher its bounty", await js(`[...document.querySelectorAll('button')].map(b=>b.textContent.trim()).filter(t=>/enforce/i.test(t)).join(' / ') || 'no enforce button'`));
await shot("bounty-board");
e0 = errors.length;
await click(label);
let active = true;
for (let i = 0; i < 40 && active; i++) { await sleep(750); active = await pub.readContract({...reg, functionName: "isActive", args: [id]}); }
const sAfter = await pub.readContract({address: env.POOL_ASSET_ADDRESS, abi: erc20, functionName: "balanceOf", args: [searcher.address]});
!active ? ok("Searcher enforced from the board", "a wallet with no role, no keeper") : bad("Searcher enforced from the board", "still active");
sAfter - sBefore === bounty ? ok("Searcher was paid by the contract", `+${usd(sAfter - sBefore)} in the same transaction`) : bad("Searcher was paid by the contract", `delta ${usd(sAfter - sBefore)}, expected ${usd(bounty)}`);
(await waitFor("enforced", 25000)) ? ok("Tape shows the enforcement") : bad("Tape shows the enforcement");
await sleep(1500);
await shot("enforced");
errsSince(e0).length ? bad("Board console clean", errsSince(e0).join(" | ")) : ok("Board console clean");

// back to the trader: the ended-mandate card, the journal, the public page, the passport
me = {account: user, wallet: userWallet};
await nav(`/trade?m=${id}`);
(await waitFor("was closed by the contract", 30000)) ? ok("Trader sees what happened and where to go", "'was closed by the contract' → passport + offers") : bad("Trader sees what happened and where to go");
(await waitJs(`/enforced/i.test(document.body.innerText)`, 30000)) ? ok("Journal marks the exit ENFORCED") : bad("Journal marks the exit ENFORCED");
await shot("trader-after");
const after = await fetch(`${BASE}/m/${id}`).then((r) => r.text());
/Breached/i.test(after) ? ok("Public page updates", `/m/${id} now reads Breached`) : bad("Public page updates");
const passport = await fetch(`${BASE}/trader/${user.address}`).then((r) => r.text());
/Breach on record/i.test(passport) ? ok("Passport records the breach", `/trader/${user.address.slice(0, 10)}…`) : bad("Passport records the breach");

const now2 = (await pub.getBlock()).timestamp;
await pub.waitForTransactionReceipt({hash: await owner.writeContract({...oracle, functionName: "forcePrice", args: [16, p0, now2]})});
ok("BTC restored", `$${(Number(p0) / 1e8).toFixed(0)}`);
spawn("npx", ["tsx", "keeper/src/index.ts"], {
  detached: true,
  stdio: ["ignore", openSync(".local-logs/keeper.log", "w"), openSync(".local-logs/keeper.log", "a")],
  env: process.env,
}).unref();
ok("Keeper restarted");

// ── 8. the LP side ──────────────────────────────────────────────────────────
e0 = errors.length;
await nav("/lp");
await waitFor("Capital pool", 30000);
await waitJs(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'faucet 100k')`, 20000);
const bal0 = await pub.readContract({address: env.POOL_ASSET_ADDRESS, abi: erc20, functionName: "balanceOf", args: [user.address]});
await click("faucet 100k");
let bal1 = bal0;
for (let i = 0; i < 30 && bal1 === bal0; i++) { await sleep(700); bal1 = await pub.readContract({address: env.POOL_ASSET_ADDRESS, abi: erc20, functionName: "balanceOf", args: [user.address]}); }
bal1 > bal0 ? ok("LP faucet", `${usd(bal1 - bal0)} test asset minted`) : bad("LP faucet");
await sleep(1200);
await type('input[placeholder="0.00"]', "25000");
await sleep(300);
const shares0 = await pub.readContract({address: env.CAPITAL_POOL_ADDRESS, abi: erc20, functionName: "balanceOf", args: [user.address]}).catch(() => 0n);
(await click("deposit")) || bad("Deposit button clickable");
let shares1 = shares0;
for (let i = 0; i < 40 && shares1 === shares0; i++) { await sleep(750); shares1 = await pub.readContract({address: env.CAPITAL_POOL_ADDRESS, abi: erc20, functionName: "balanceOf", args: [user.address]}).catch(() => 0n); }
shares1 > shares0 ? ok("LP deposit", `approve + deposit → ${(Number(shares1) / 1e6).toLocaleString()} pool shares`) : bad("LP deposit", "no shares");
await sleep(4500);
await shot("lp");
errsSince(e0).length ? bad("LP console clean", errsSince(e0).join(" | ")) : ok("LP console clean");

// ── 9. market ───────────────────────────────────────────────────────────────
e0 = errors.length;
await nav("/market");
(await waitFor("Capital competes for traders", 30000)) ? ok("Market renders") : bad("Market renders");
await sleep(2500);
await shot("market");
errsSince(e0).length ? bad("Market console clean", errsSince(e0).join(" | ")) : ok("Market console clean");

ws.close();
chrome.kill();
writeFileSync(`${OUT}/report.json`, JSON.stringify({user: user.address, mandate: String(id), report, txs, walletCalls, errors, seconds: Math.round((Date.now() - t0) / 1000)}, null, 2));
console.log(`\n${report.filter((r) => r.ok).length}/${report.length} passed · ${txs.length} transactions · ${Math.round((Date.now() - t0) / 1000)}s`);
console.log("wallet calls:", JSON.stringify(walletCalls));
process.exit(report.every((r) => r.ok) ? 0 : 1);
