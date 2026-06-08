import crypto from "crypto";
import type { Prisma, StorePlatform } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";

type Db = Prisma.TransactionClient | typeof prisma;

function stableStringify(value: unknown): string {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    ordered[key] = (value as Record<string, unknown>)[key];
  }
  return JSON.stringify(ordered);
}

export function platformPayloadHash(payload: unknown) {
  return crypto
    .createHash("sha256")
    .update(stableStringify(payload) ?? "null")
    .digest("hex");
}

export async function hasImportedExternalOrder(
  merchantId: string,
  connectionId: string,
  platform: StorePlatform,
  externalOrderId: string,
  client: Db
) {
  const existing = await client.platformOrderImport.findFirst({
    where: {
      merchantId,
      connectionId,
      platform,
      externalOrderId
    }
  });
  return Boolean(existing);
}
