import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { Request } from "express";
import { env } from "../config/env.js";

function normalizedAddress(value: string | undefined) {
  const candidate = String(value ?? "").trim().replace(/^\[|\]$/g, "");
  if (candidate.startsWith("::ffff:")) return candidate.slice(7);
  return candidate;
}

function validAddress(value: string | undefined) {
  const normalized = normalizedAddress(value);
  return isIP(normalized) > 0 ? normalized : null;
}

/**
 * Returns a conservative network identifier. Forwarded headers are considered
 * only when an explicitly configured trusted proxy hop count is positive. The
 * default is zero because direct Cloud Run access is a supported topology.
 */
export function clientNetworkIdentifier(req: Request, trustedProxyHops = env.TRUSTED_PROXY_HOPS) {
  const socketAddress = validAddress(req.socket.remoteAddress) || "unknown";
  if (!Number.isInteger(trustedProxyHops) || trustedProxyHops <= 0) return socketAddress;

  const forwarded = req.header("x-forwarded-for");
  if (!forwarded) return socketAddress;
  const chain = forwarded.split(",").map((entry) => validAddress(entry));
  if (chain.some((entry) => !entry)) return socketAddress;

  const clientIndex = chain.length - trustedProxyHops - 1;
  return clientIndex >= 0 ? chain[clientIndex]! : socketAddress;
}

export function pseudonymizeNetworkIdentifier(identifier: string) {
  return createHash("sha256")
    .update(`${env.APP_SECRET_PEPPER}:network:${identifier}`)
    .digest("hex")
    .slice(0, 24);
}

export function clientNetworkKey(req: Request) {
  return pseudonymizeNetworkIdentifier(clientNetworkIdentifier(req));
}
