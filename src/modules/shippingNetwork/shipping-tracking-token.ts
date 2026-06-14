import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

type Db = Prisma.TransactionClient | typeof prisma;

type ShipmentTrackingTokenSource = {
  id: string;
  trackingToken?: string | null;
  trackingPublicUrl?: string | null;
};

const TRACKING_TOKEN_PREFIX = "trk_";

export function buildTrackingPublicUrl(trackingToken: string | null | undefined) {
  return trackingToken ? `/tracking/${encodeURIComponent(trackingToken)}` : null;
}

export function generateTrackingToken() {
  return `${TRACKING_TOKEN_PREFIX}${randomBytes(18).toString("base64url")}`;
}

export function isSafeTrackingToken(value: string | null | undefined): value is string {
  return Boolean(value && /^trk_[A-Za-z0-9_-]{20,}$/.test(value));
}

function isUniqueConstraintError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

export async function ensureShipmentTrackingToken<T extends ShipmentTrackingTokenSource>(
  shipment: T,
  client: Db = prisma
): Promise<T & { trackingToken: string; trackingPublicUrl: string }> {
  const existingToken = shipment.trackingToken;
  if (isSafeTrackingToken(existingToken)) {
    const trackingToken = existingToken;
    const publicUrl = shipment.trackingPublicUrl || buildTrackingPublicUrl(trackingToken);

    if (publicUrl && publicUrl === shipment.trackingPublicUrl) {
      return {
        ...shipment,
        trackingToken,
        trackingPublicUrl: publicUrl
      };
    }

    const updated = await client.shipment.update({
      where: { id: shipment.id },
      data: { trackingPublicUrl: publicUrl }
    });

    return {
      ...shipment,
      ...updated,
      trackingToken,
      trackingPublicUrl: publicUrl!
    };
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const trackingToken = generateTrackingToken();
    const trackingPublicUrl = buildTrackingPublicUrl(trackingToken)!;

    try {
      const updated = await client.shipment.update({
        where: { id: shipment.id },
        data: {
          trackingToken,
          trackingPublicUrl
        }
      });

      return {
        ...shipment,
        ...updated,
        trackingToken,
        trackingPublicUrl
      };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
    }
  }

  throw new Error("Unable to allocate shipment tracking token.");
}
