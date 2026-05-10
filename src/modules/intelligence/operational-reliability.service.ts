import { Prisma, type CourierEventType, type RiskLevel, type SlaBreachType } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

type Db = Prisma.TransactionClient | typeof prisma;

export type OperationalEventInput = {
  merchantId?: string | null;
  orderId?: string | null;
  courierId?: string | null;
  eventType?: CourierEventType | null;
  status: string;
  severity?: RiskLevel;
  metadata?: Prisma.InputJsonValue;
};

export type SlaBreachInput = {
  merchantId?: string | null;
  orderId?: string | null;
  courierId?: string | null;
  breachType: SlaBreachType;
  severity?: RiskLevel;
  metadata?: Prisma.InputJsonValue;
};

export async function logOperationalEvent(input: OperationalEventInput, client: Db = prisma) {
  return client.operationalEvent.create({
    data: {
      merchantId: input.merchantId || null,
      orderId: input.orderId || null,
      courierId: input.courierId || null,
      eventType: input.eventType || null,
      status: input.status,
      severity: input.severity || "LOW",
      metadata: input.metadata ?? Prisma.JsonNull
    }
  });
}

export async function createSlaBreach(input: SlaBreachInput, client: Db = prisma) {
  return client.slaBreach.create({
    data: {
      merchantId: input.merchantId || null,
      orderId: input.orderId || null,
      courierId: input.courierId || null,
      breachType: input.breachType,
      severity: input.severity || "MEDIUM",
      metadata: input.metadata ?? Prisma.JsonNull
    }
  });
}

export async function resolveSlaBreach(id: string, client: Db = prisma) {
  return client.slaBreach.update({
    where: { id },
    data: {
      status: "resolved",
      resolvedAt: new Date()
    }
  });
}
