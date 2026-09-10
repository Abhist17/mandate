/**
 * Sign-In With Ethereum, EIP-4361.
 *
 * Implemented directly rather than pulled in as a dependency: the message is a fixed,
 * well-specified text format, and the whole of it is below. A signing standard is a bad place
 * for a black box — a user is about to approve this text in their wallet, and both sides of
 * the app should be readable in one file.
 */

export type SiweFields = {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  version: "1";
  chainId: number;
  nonce: string;
  issuedAt: string;
};

export const SIWE_STATEMENT =
  "Sign in to Mandate. This proves you control this address. It is a signature, not a transaction — it costs nothing and moves no funds.";

/** Build the exact string the wallet will display and sign. */
export function buildSiweMessage(f: SiweFields): string {
  return [
    `${f.domain} wants you to sign in with your Ethereum account:`,
    f.address,
    "",
    f.statement,
    "",
    `URI: ${f.uri}`,
    `Version: ${f.version}`,
    `Chain ID: ${f.chainId}`,
    `Nonce: ${f.nonce}`,
    `Issued At: ${f.issuedAt}`,
  ].join("\n");
}

/**
 * Parse a message back into fields.
 *
 * The server re-parses rather than trusting fields sent alongside the signature. If it took
 * the client's word for the address or the nonce, a valid signature over *some other* message
 * would authenticate — the signature has to be checked against the exact text that was signed.
 */
export function parseSiweMessage(message: string): SiweFields | undefined {
  const lines = message.split("\n");
  if (lines.length < 10) return undefined;

  const domainMatch = lines[0]?.match(/^(.+) wants you to sign in with your Ethereum account:$/);
  const address = lines[1];
  if (!domainMatch || !address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined;

  const get = (prefix: string) => lines.find((l) => l.startsWith(prefix))?.slice(prefix.length);

  const uri = get("URI: ");
  const version = get("Version: ");
  const chainId = get("Chain ID: ");
  const nonce = get("Nonce: ");
  const issuedAt = get("Issued At: ");
  if (!uri || version !== "1" || !chainId || !nonce || !issuedAt) return undefined;

  return {
    domain: domainMatch[1]!,
    address,
    statement: lines[3] ?? "",
    uri,
    version: "1",
    chainId: Number(chainId),
    nonce,
    issuedAt,
  };
}
