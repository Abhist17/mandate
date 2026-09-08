/**
 * Writes the deployed contract addresses from ../.env into config.yaml.
 *
 * Envio's config is static YAML, and a judge who deploys their own instance would otherwise
 * have to hand-edit three addresses in the right places. This keeps `.env` the single source
 * of truth, matching how every other component in the repo is configured.
 */
import {readFileSync, writeFileSync, existsSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, resolve} from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, "../.env");

if (!existsSync(envPath)) {
  console.error("No ../.env found. Copy .env.example and fill in the deployed addresses.");
  process.exit(1);
}

const env = Object.fromEntries(
  readFileSync(envPath, "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const wanted = {
  MandateRegistry: env.MANDATE_REGISTRY_ADDRESS,
  MiniPerp: env.MINI_PERP_ADDRESS,
  CapitalPool: env.CAPITAL_POOL_ADDRESS,
};

const missing = Object.entries(wanted).filter(([, v]) => !v || !/^0x[0-9a-fA-F]{40}$/.test(v));
if (missing.length > 0) {
  console.error(`Missing or malformed addresses in .env: ${missing.map(([k]) => k).join(", ")}`);
  process.exit(1);
}

const configPath = resolve(here, "config.yaml");
let yaml = readFileSync(configPath, "utf8");

// Replace the placeholder address in the block following each `- name: <Contract>`.
for (const [name, address] of Object.entries(wanted)) {
  const re = new RegExp(`(- name: ${name}\\s*\\n\\s*address:\\s*\\n\\s*- ")0x[0-9a-fA-F]{40}(")`);
  if (!re.test(yaml)) {
    console.error(`Could not find the address slot for ${name} in config.yaml`);
    process.exit(1);
  }
  yaml = yaml.replace(re, `$1${address}$2`);
}

const startBlock = env.INDEXER_START_BLOCK;
if (startBlock && /^\d+$/.test(startBlock)) {
  yaml = yaml.replace(/start_block: \d+/, `start_block: ${startBlock}`);
}

writeFileSync(configPath, yaml);
console.log("config.yaml synced from .env:");
for (const [name, address] of Object.entries(wanted)) console.log(`  ${name.padEnd(16)} ${address}`);
if (startBlock) console.log(`  start_block      ${startBlock}`);
