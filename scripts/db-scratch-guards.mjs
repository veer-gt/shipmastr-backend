export const SCRATCH_PATTERN = /^shipmastr_scratch_[a-zA-Z0-9_]+$/;
export const PROTECTED_DATABASES = new Set([
  "postgres", "template0", "template1", "shipmastr_dev", "shipmastr", "shipmastr_prod", "production", "staging"
]);

export function assertScratchName(name) {
  if (typeof name !== "string" || !SCRATCH_PATTERN.test(name) || name === "shipmastr_scratch_") {
    throw new Error("Database name must match shipmastr_scratch_<identifier>");
  }
  if (PROTECTED_DATABASES.has(name)) throw new Error(`Protected database name refused: ${name}`);
  return name;
}

export function assertDropTarget(name) {
  if (PROTECTED_DATABASES.has(name)) throw new Error(`Protected database name refused: ${name}`);
  return assertScratchName(name);
}

export function assertLocalDatabaseUrl(value) {
  if (!value) throw new Error("DATABASE_URL is required for a scratch operation");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("DATABASE_URL must be a PostgreSQL URL");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error("Only PostgreSQL URLs are accepted");
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname.toLowerCase())) throw new Error("Only local database hosts are accepted");
  if (parsed.port !== "5433") throw new Error("Only local PostgreSQL port 5433 is accepted");
  if (parsed.pathname === "/" || parsed.pathname.length < 2) throw new Error("A scratch database name is required");
  if (parsed.searchParams.has("host") || parsed.searchParams.has("socket")) throw new Error("Cloud SQL socket parameters are refused");
  assertScratchName(decodeURIComponent(parsed.pathname.slice(1)));
  return parsed;
}

export function makeScratchName(shortSha, now = new Date()) {
  const safeSha = String(shortSha).replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "local";
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return assertScratchName(`shipmastr_scratch_${safeSha}_${stamp}`);
}

export async function withGuaranteedScratchCleanup({ create, drop, run }) {
  const name = await create();
  try {
    return await run(name);
  } finally {
    await drop(name);
  }
}
