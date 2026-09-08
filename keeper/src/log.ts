/** Structured logging. Human-readable in a terminal, greppable in a file. */

const C = {
  dim: "\x1b[2m",
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  bold: "\x1b[1m",
} as const;

const stamp = () => new Date().toISOString().slice(11, 23);

function emit(colour: string, level: string, msg: string, fields?: Record<string, unknown>) {
  const tail = fields
    ? " " +
      Object.entries(fields)
        .map(([k, v]) => `${C.dim}${k}=${C.reset}${typeof v === "bigint" ? v.toString() : v}`)
        .join(" ")
    : "";
  console.log(`${C.dim}${stamp()}${C.reset} ${colour}${level}${C.reset} ${msg}${tail}`);
}

export const log = {
  info: (m: string, f?: Record<string, unknown>) => emit(C.blue, "INFO ", m, f),
  ok: (m: string, f?: Record<string, unknown>) => emit(C.green, "OK   ", m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit(C.yellow, "WARN ", m, f),
  error: (m: string, f?: Record<string, unknown>) => emit(C.red, "ERROR", m, f),
  breach: (m: string, f?: Record<string, unknown>) => emit(C.red + C.bold, "BREACH", m, f),
  banner: (m: string) => console.log(`\n${C.bold}${m}${C.reset}\n${"─".repeat(72)}`),
};

export const usd = (v: bigint, decimals = 6): string =>
  (Number(v) / 10 ** decimals).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
