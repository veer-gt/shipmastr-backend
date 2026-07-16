import { createHash } from "node:crypto";

const WINDOW_MS = 60_000;
const MAX_KEYS = 10_000;
const MAX_ATTEMPTS_PER_KEY = 60;

type Bucket = { startedAt: number; attempts: number };
const buckets = new Map<string, Bucket>();

function pseudonym(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function prune(now: number) {
  for (const [key, bucket] of buckets) {
    if (now - bucket.startedAt >= WINDOW_MS) buckets.delete(key);
  }
  if (buckets.size <= MAX_KEYS) return;
  const oldest = [...buckets.entries()]
    .sort((left, right) => left[1].startedAt - right[1].startedAt)
    .slice(0, buckets.size - MAX_KEYS);
  for (const [key] of oldest) buckets.delete(key);
}

export function h2bRateLimitKey(endpointFingerprint: string | null, sourceAddress: string) {
  return `${endpointFingerprint ?? "unknown"}:${pseudonym(sourceAddress || "unknown")}`;
}

export function allowH2BRequest(endpointFingerprint: string | null, sourceAddress: string, now = Date.now()) {
  prune(now);
  const key = h2bRateLimitKey(endpointFingerprint, sourceAddress);
  const current = buckets.get(key);
  if (!current || now - current.startedAt >= WINDOW_MS) {
    buckets.set(key, { startedAt: now, attempts: 1 });
    return true;
  }
  if (current.attempts >= MAX_ATTEMPTS_PER_KEY) return false;
  current.attempts += 1;
  return true;
}

export function resetH2BRateLimitForTests() {
  buckets.clear();
}
