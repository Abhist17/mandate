/**
 * Renders the app in a real browser and fails on any console error.
 *
 * This exists because of a specific miss: the frontend once threw on load and rendered
 * nothing but an error page, while `tsc --noEmit` passed, `next build` passed, and curl
 * returned 200 with the shell HTML. All three were green and the app was dead, because the
 * data path only runs client-side. A 200 is not evidence a page works.
 *
 * Run:  node scripts/smoke-web.mjs [baseUrl]
 * Exits non-zero on a console error, a page exception, or a missing expected element.
 */

import {spawn} from "node:child_process";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const BASE = process.argv[2] ?? "http://127.0.0.1:3111";

/** Pages to check, and a string each must contain once it has actually rendered. */
const PAGES = [
  {path: "/", mustContain: ["Distance to floor", "Equity vs drawdown"]},
  {path: "/lp", mustContain: ["Capital pool", "What you are underwriting"]},
];

const CHROME =
  process.env.CHROME_BIN ??
  ["google-chrome", "chromium", "chromium-browser"].find((b) => {
    try {
      return spawn(b, ["--version"]) && true;
    } catch {
      return false;
    }
  }) ??
  "google-chrome";

/** Console noise a headless Chrome emits that has nothing to do with the app. */
const IGNORE =
  /favicon|DevTools|Autofill|GPU|gl_|vulkan|dbus|sandbox|Fontconfig|net::ERR_FAILED.*chrome-extension/i;

function render(url) {
  return new Promise((resolve) => {
    const profile = mkdtempSync(join(tmpdir(), "mandate-smoke-"));
    const args = [
      "--headless=new", "--disable-gpu", "--no-sandbox",
      `--user-data-dir=${profile}`,
      "--enable-logging=stderr", "--v=1",
      "--virtual-time-budget=15000",
      "--dump-dom", url,
    ];
    const p = spawn(CHROME, args);
    let dom = "";
    let err = "";
    p.stdout.on("data", (d) => (dom += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", () => {
      rmSync(profile, {recursive: true, force: true});
      const consoleErrors = err
        .split("\n")
        .filter((l) => /INFO:CONSOLE|SEVERE|ERROR:CONSOLE/.test(l))
        .filter((l) => !IGNORE.test(l))
        .map((l) => l.replace(/^.*CONSOLE:\d+\]\s*/, "").trim());
      resolve({dom, consoleErrors});
    });
  });
}

let failed = false;

for (const page of PAGES) {
  const url = `${BASE}${page.path}`;
  process.stdout.write(`\n${page.path}\n`);

  const {dom, consoleErrors} = await render(url);

  if (dom.includes("Application error")) {
    console.log("  \x1b[31m✗\x1b[0m page crashed with a client-side exception");
    failed = true;
  }

  for (const e of consoleErrors) {
    console.log(`  \x1b[31m✗\x1b[0m console: ${e.slice(0, 160)}`);
    failed = true;
  }

  for (const needle of page.mustContain) {
    if (dom.includes(needle)) {
      console.log(`  \x1b[32m✓\x1b[0m rendered "${needle}"`);
    } else {
      console.log(`  \x1b[31m✗\x1b[0m missing "${needle}" — the page loaded but did not render`);
      failed = true;
    }
  }

  // A blank dark page still returns 200 and still contains the shell. Check for real content.
  const bodyText = dom.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (bodyText.length < 400) {
    console.log(`  \x1b[31m✗\x1b[0m almost no text rendered (${bodyText.length} chars)`);
    failed = true;
  }
}

console.log(
  failed
    ? "\n\x1b[31mSMOKE FAILED\x1b[0m — the app builds but does not work in a browser\n"
    : "\n\x1b[32mSMOKE PASSED\x1b[0m — both pages render real data with no console errors\n",
);
process.exit(failed ? 1 : 0);
