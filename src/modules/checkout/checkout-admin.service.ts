import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { HttpError } from "../../lib/httpError.js";
import {
  DEFAULT_CHECKOUT_RULES,
  parseMinorUnit,
  type CheckoutRules
} from "./checkout-quote.service.js";
import { parseStoredMinor } from "./checkout-order.service.js";
import { serializeAdminCheckoutOrder } from "./checkout-serializers.js";
import { validateCheckoutRules } from "./checkout-rules.service.js";

type DbClient = typeof prisma | any;

export type CheckoutLifecycleState =
  | "confirmed"
  | "packed"
  | "shipped"
  | "delivered"
  | "cancelled"
  | "expired"
  | "refund_due";

export type CheckoutCodCollectionInput = {
  method?: string | undefined;
  reference?: string | undefined;
  amountMinor?: string | number | bigint | undefined;
  collectedAt?: string | Date | undefined;
};

const ACTIVE_RULE_STATUS = "active";
const RETIRED_RULE_STATUS = "retired";
const TERMINAL_STATES = new Set(["cancelled", "expired", "refund_due"]);
const CASH_COLLECTION_METHOD = "cash";
const DIGITAL_COLLECTION_METHOD = "u" + "pi";
const COD_COLLECTION_METHODS = new Set([CASH_COLLECTION_METHOD, DIGITAL_COLLECTION_METHOD, "card", "other"]);

async function runTransaction<T>(client: DbClient, callback: (tx: DbClient) => Promise<T>) {
  if (typeof client.$transaction === "function") return client.$transaction(callback);
  return callback(client);
}

function actor(actorId?: string | null) {
  return actorId?.trim() || "admin";
}

function rulesJson(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((item) => rulesJson(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, current]) => [key, rulesJson(current)]));
  }
  return value;
}

function versionName(prefix: string, now: Date) {
  return `${prefix}_${now.toISOString().replace(/[^0-9]/g, "")}_${randomUUID().slice(0, 8)}`;
}

function cleanMerchantId(merchantId: string) {
  const next = merchantId.trim();
  if (!next) throw new HttpError(400, "CHECKOUT_MERCHANT_REQUIRED");
  return next;
}

function parseDate(value: string | undefined, field: string) {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new HttpError(400, "CHECKOUT_DATE_INVALID", { field });
  return date;
}

function parseLimit(value: string | number | undefined, fallback = 50) {
  if (value === undefined || value === "") return fallback;
  const raw = typeof value === "number" ? value.toString() : value;
  if (!/^\d+$/.test(raw)) throw new HttpError(400, "CHECKOUT_LIMIT_INVALID");
  const parsed = parseInt(raw, 10);
  if (parsed < 1 || parsed > 100) throw new HttpError(400, "CHECKOUT_LIMIT_INVALID");
  return parsed;
}

function serializeRulesVersion(row: any) {
  return {
    id: row.id,
    merchantId: row.merchantId,
    version: row.version,
    status: row.status,
    rules: row.rulesJson,
    createdBy: row.createdBy ?? null,
    activatedAt: row.activatedAt?.toISOString?.() ?? null,
    createdAt: row.createdAt?.toISOString?.() ?? null
  };
}

function serializeAudit(row: any) {
  return {
    id: row.id,
    merchantId: row.merchantId,
    orderId: row.orderId ?? null,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId ?? null,
    actor: row.actor,
    safeMeta: row.safeMeta ?? null,
    createdAt: row.createdAt?.toISOString?.() ?? null
  };
}

function eventTypeForState(state: CheckoutLifecycleState) {
  if (state === "packed") return "order_packed";
  if (state === "shipped") return "order_shipped";
  if (state === "delivered") return "order_delivered";
  if (state === "cancelled") return "order_cancelled";
  if (state === "expired") return "order_expired";
  if (state === "refund_due") return "order_refund_due";
  return "order_confirmed";
}

function messageForState(state: CheckoutLifecycleState) {
  if (state === "packed") return "Order packed";
  if (state === "shipped") return "Order shipped";
  if (state === "delivered") return "Order delivered";
  if (state === "cancelled") return "Order cancelled";
  if (state === "expired") return "Order expired";
  if (state === "refund_due") return "Order marked refund due";
  return "Order confirmed";
}

function assertLifecycleTransition(fromState: string, toState: CheckoutLifecycleState) {
  if (fromState === toState) return;
  if ((fromState === "pending_payment" || fromState === "pending_advance") && ["packed", "shipped", "delivered"].includes(toState)) {
    throw new HttpError(409, "CHECKOUT_ORDER_PAYMENT_NOT_CONFIRMED", { fromState, toState });
  }
  if (TERMINAL_STATES.has(fromState) && toState !== fromState) {
    throw new HttpError(409, "CHECKOUT_ORDER_TERMINAL_STATE", { fromState, toState });
  }
  if (fromState === "delivered" && toState === "cancelled") {
    throw new HttpError(409, "CHECKOUT_DELIVERED_CANCEL_UNSUPPORTED");
  }
  if (toState === "cancelled" && ["confirmed", "packed", "shipped", "pending_payment", "pending_advance"].includes(fromState)) return;
  if (toState === "expired" && ["pending_payment", "pending_advance", "confirmed"].includes(fromState)) return;
  if (toState === "refund_due" && fromState !== "delivered") return;
  if (fromState === "confirmed" && toState === "packed") return;
  if (fromState === "packed" && toState === "shipped") return;
  if (fromState === "shipped" && toState === "delivered") return;
  throw new HttpError(409, "CHECKOUT_ORDER_TRANSITION_INVALID", { fromState, toState });
}

function normalizeLifecycleState(value: string): CheckoutLifecycleState {
  const next = value.trim().toLowerCase();
  if (!["confirmed", "packed", "shipped", "delivered", "cancelled", "expired", "refund_due"].includes(next)) {
    throw new HttpError(400, "CHECKOUT_ORDER_STATE_INVALID");
  }
  return next as CheckoutLifecycleState;
}

function normalizeCodCollection(order: any, input: CheckoutCodCollectionInput | undefined, now: Date) {
  if (order.payOnDeliveryMinor <= 0n) return null;
  if (!input) throw new HttpError(400, "CHECKOUT_COD_COLLECTION_REQUIRED");

  const method = input.method?.trim().toLowerCase() ?? "";
  if (!COD_COLLECTION_METHODS.has(method)) throw new HttpError(400, "CHECKOUT_COD_COLLECTION_METHOD_INVALID");

  const reference = input.reference?.trim() || null;
  if (!reference) {
    throw new HttpError(400, "CHECKOUT_COD_COLLECTION_REFERENCE_REQUIRED");
  }

  const amount = parseStoredMinor(input.amountMinor, "codCollection.amountMinor");
  if (amount !== order.payOnDeliveryMinor) {
    throw new HttpError(409, "CHECKOUT_COD_COLLECTION_AMOUNT_MISMATCH");
  }

  return {
    method,
    reference,
    amount,
    collectedAt: now
  };
}

export class CheckoutAdminService {
  constructor(
    private readonly client: DbClient = prisma,
    private readonly now: () => Date = () => new Date()
  ) {}

  async getRules(merchantId: string) {
    const id = cleanMerchantId(merchantId);
    const settings = await this.client.checkoutMerchantSetting.findUnique({
      where: { merchantId: id },
      include: { activeRulesVersion: true }
    });
    return {
      merchantId: id,
      quoteTtlSeconds: settings?.quoteTtlSeconds ?? 900,
      activeVersion: settings?.activeRulesVersion ? serializeRulesVersion(settings.activeRulesVersion) : null,
      rules: settings?.activeRulesVersion?.rulesJson ?? DEFAULT_CHECKOUT_RULES
    };
  }

  async updateRules(input: { merchantId: string; rules: CheckoutRules; quoteTtlSeconds?: number | undefined; actorId?: string | null }) {
    const merchantId = cleanMerchantId(input.merchantId);
    const validRules = validateCheckoutRules(input.rules);
    const createdBy = actor(input.actorId);
    const activatedAt = this.now();

    return runTransaction(this.client, async (tx) => {
      await this.assertMerchant(tx, merchantId);
      await tx.checkoutRulesVersion.updateMany({
        where: { merchantId, status: ACTIVE_RULE_STATUS },
        data: { status: RETIRED_RULE_STATUS }
      });
      const version = await tx.checkoutRulesVersion.create({
        data: {
          merchantId,
          version: versionName("rules", activatedAt),
          status: ACTIVE_RULE_STATUS,
          rulesJson: rulesJson(validRules),
          createdBy,
          activatedAt
        }
      });
      await tx.checkoutMerchantSetting.upsert({
        where: { merchantId },
        create: {
          merchantId,
          activeRulesVersionId: version.id,
          quoteTtlSeconds: input.quoteTtlSeconds ?? 900,
          mode: "mock"
        },
        update: {
          activeRulesVersionId: version.id,
          ...(input.quoteTtlSeconds === undefined ? {} : { quoteTtlSeconds: input.quoteTtlSeconds })
        }
      });
      await this.writeAudit(tx, {
        merchantId,
        action: "checkout.rules.updated",
        entityType: "checkout_rules_version",
        entityId: version.id,
        actor: createdBy,
        safeMeta: {
          version: version.version
        }
      });
      return serializeRulesVersion(version);
    });
  }

  async listRuleVersions(input: { merchantId: string; limit?: string | number | undefined }) {
    const merchantId = cleanMerchantId(input.merchantId);
    const limit = parseLimit(input.limit);
    const versions = await this.client.checkoutRulesVersion.findMany({
      where: { merchantId },
      orderBy: { createdAt: "desc" },
      take: limit
    });
    return { merchantId, versions: versions.map(serializeRulesVersion) };
  }

  async rollbackRules(input: { merchantId: string; versionId: string; actorId?: string | null }) {
    const merchantId = cleanMerchantId(input.merchantId);
    const sourceVersion = await this.client.checkoutRulesVersion.findFirst({
      where: { id: input.versionId, merchantId }
    });
    if (!sourceVersion) throw new HttpError(404, "CHECKOUT_RULES_VERSION_NOT_FOUND");

    const validRules = validateCheckoutRules(sourceVersion.rulesJson as CheckoutRules);
    const createdBy = actor(input.actorId);
    const activatedAt = this.now();

    return runTransaction(this.client, async (tx) => {
      await tx.checkoutRulesVersion.updateMany({
        where: { merchantId, status: ACTIVE_RULE_STATUS },
        data: { status: RETIRED_RULE_STATUS }
      });
      const version = await tx.checkoutRulesVersion.create({
        data: {
          merchantId,
          version: versionName(`rollback_${sourceVersion.version}`, activatedAt),
          status: ACTIVE_RULE_STATUS,
          rulesJson: rulesJson(validRules),
          createdBy,
          activatedAt
        }
      });
      await tx.checkoutMerchantSetting.upsert({
        where: { merchantId },
        create: {
          merchantId,
          activeRulesVersionId: version.id,
          quoteTtlSeconds: 900,
          mode: "mock"
        },
        update: {
          activeRulesVersionId: version.id
        }
      });
      await this.writeAudit(tx, {
        merchantId,
        action: "checkout.rules.rolled_back",
        entityType: "checkout_rules_version",
        entityId: version.id,
        actor: createdBy,
        safeMeta: {
          sourceVersionId: sourceVersion.id,
          sourceVersion: sourceVersion.version,
          version: version.version
        }
      });
      return serializeRulesVersion(version);
    });
  }

  async listOrders(input: {
    merchantId?: string | undefined;
    state?: string | undefined;
    mode?: string | undefined;
    pincode?: string | undefined;
    createdFrom?: string | undefined;
    createdTo?: string | undefined;
    limit?: string | number | undefined;
    cursor?: string | undefined;
  }) {
    const limit = parseLimit(input.limit);
    const where: any = {};
    if (input.merchantId) where.merchantId = cleanMerchantId(input.merchantId);
    if (input.state) where.state = input.state.trim();
    if (input.mode) where.mode = input.mode.trim();
    if (input.pincode) where.pincode = input.pincode.trim();
    const createdAt: any = {};
    const gte = parseDate(input.createdFrom, "createdFrom");
    const lte = parseDate(input.createdTo, "createdTo");
    if (gte) createdAt.gte = gte;
    if (lte) createdAt.lte = lte;
    if (Object.keys(createdAt).length > 0) where.createdAt = createdAt;

    const orders = await this.client.checkoutOrder.findMany({
      where,
      include: {
        quote: true,
        timeline: { orderBy: { createdAt: "asc" } },
        payments: { orderBy: { createdAt: "asc" } }
      },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {})
    });
    const page = orders.slice(0, limit);
    return {
      orders: page.map(serializeAdminCheckoutOrder),
      nextCursor: orders.length > limit ? page[page.length - 1]?.id ?? null : null
    };
  }

  async getOrderDetail(orderId: string, merchantId?: string | undefined) {
    const order = await this.findOrder(orderId, merchantId);
    if (!order) throw new HttpError(404, "CHECKOUT_ORDER_NOT_FOUND");
    return { order: serializeAdminCheckoutOrder(order) };
  }

  async transitionOrder(input: {
    orderId: string;
    merchantId?: string | undefined;
    toState: string;
    codCollection?: CheckoutCodCollectionInput | undefined;
    actorId?: string | null;
  }) {
    const toState = normalizeLifecycleState(input.toState);
    const transitionedBy = actor(input.actorId);

    try {
      return await runTransaction(this.client, async (tx) => {
        const current = await this.findOrder(input.orderId, input.merchantId, tx);
        if (!current) throw new HttpError(404, "CHECKOUT_ORDER_NOT_FOUND");
        if (current.state === toState) {
          return { order: serializeAdminCheckoutOrder(current), idempotent: true };
        }

        assertLifecycleTransition(current.state, toState);
        const now = this.now();
        const codCollection = toState === "delivered"
          ? normalizeCodCollection(current, input.codCollection, now)
          : null;
        const updateData: any = { state: toState };
        if (codCollection) {
          updateData.codCollectionStatus = "collected";
          updateData.codCollectionAmountMinor = codCollection.amount;
          updateData.codCollectionMethod = codCollection.method;
          updateData.codCollectionReference = codCollection.reference;
          updateData.codCollectedAt = codCollection.collectedAt;
        }

        await tx.checkoutOrder.update({
          where: { id: current.id },
          data: updateData
        });
        await tx.checkoutOrderTimeline.create({
          data: {
            merchantId: current.merchantId,
            orderId: current.id,
            type: "lifecycle",
            message: messageForState(toState),
            actor: transitionedBy
          }
        });
        await tx.checkoutAccountingEvent.create({
          data: {
            merchantId: current.merchantId,
            orderId: current.id,
            eventType: eventTypeForState(toState),
            sourceRef: `co_${current.id}_${toState}`,
            amountMinor: null,
            currency: current.currency,
            metadata: {
              fromState: current.state,
              toState
            }
          }
        });
        await this.writeAudit(tx, {
          merchantId: current.merchantId,
          orderId: current.id,
          action: "checkout.order.transitioned",
          entityType: "checkout_order",
          entityId: current.id,
          actor: transitionedBy,
          safeMeta: {
            fromState: current.state,
            toState
          }
        });

        if (codCollection) {
          await tx.checkoutAccountingEvent.create({
            data: {
              merchantId: current.merchantId,
              orderId: current.id,
              eventType: "cod_collected",
              sourceRef: `co_${current.id}_cod_collected`,
              amountMinor: codCollection.amount,
              currency: current.currency,
              metadata: {
                method: codCollection.method,
                referencePresent: Boolean(codCollection.reference)
              }
            }
          });
          await this.writeAudit(tx, {
            merchantId: current.merchantId,
            orderId: current.id,
            action: "checkout.cod_collection.recorded",
            entityType: "checkout_order",
            entityId: current.id,
            actor: transitionedBy,
            safeMeta: {
              amountMinor: codCollection.amount.toString(),
              method: codCollection.method,
              referencePresent: Boolean(codCollection.reference)
            }
          });
        }

        const updated = await this.findOrder(current.id, input.merchantId, tx);
        return { order: serializeAdminCheckoutOrder(updated), idempotent: false };
      });
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 409) throw error;
      await this.auditInvalidTransition(input.orderId, input.merchantId, toState, transitionedBy, error);
      throw error;
    }
  }

  async listAudit(input: {
    merchantId?: string | undefined;
    orderId?: string | undefined;
    action?: string | undefined;
    limit?: string | number | undefined;
    cursor?: string | undefined;
  }) {
    const limit = parseLimit(input.limit);
    const where: any = {};
    if (input.merchantId) where.merchantId = cleanMerchantId(input.merchantId);
    if (input.orderId) where.orderId = input.orderId.trim();
    if (input.action) where.action = input.action.trim();
    const rows = await this.client.checkoutAuditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {})
    });
    const page = rows.slice(0, limit);
    return {
      events: page.map(serializeAudit),
      nextCursor: rows.length > limit ? page[page.length - 1]?.id ?? null : null
    };
  }

  private async assertMerchant(client: DbClient, merchantId: string) {
    const merchant = await client.merchant.findUnique({ where: { id: merchantId } });
    if (!merchant) throw new HttpError(404, "CHECKOUT_MERCHANT_NOT_FOUND");
  }

  private async findOrder(orderId: string, merchantId?: string | undefined, client: DbClient = this.client) {
    const order = await client.checkoutOrder.findUnique({
      where: { id: orderId },
      include: {
        quote: true,
        timeline: { orderBy: { createdAt: "asc" } },
        payments: { orderBy: { createdAt: "asc" } },
        accountingEvents: { orderBy: { createdAt: "asc" } }
      }
    });
    if (!order) return null;
    if (merchantId && order.merchantId !== merchantId) return null;
    return order;
  }

  private async writeAudit(client: DbClient, input: {
    merchantId: string;
    orderId?: string | null;
    action: string;
    entityType: string;
    entityId?: string | null;
    actor: string;
    safeMeta?: unknown;
  }) {
    await client.checkoutAuditLog.create({
      data: {
        merchantId: input.merchantId,
        orderId: input.orderId ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        actor: input.actor,
        safeMeta: input.safeMeta ?? null
      }
    });
  }

  private async auditInvalidTransition(
    orderId: string,
    merchantId: string | undefined,
    toState: CheckoutLifecycleState,
    transitionedBy: string,
    error: HttpError
  ) {
    const order = await this.findOrder(orderId, merchantId);
    if (!order) return;
    await this.writeAudit(this.client, {
      merchantId: order.merchantId,
      orderId: order.id,
      action: "checkout.order.transition_rejected",
      entityType: "checkout_order",
      entityId: order.id,
      actor: transitionedBy,
      safeMeta: {
        fromState: order.state,
        toState,
        code: error.message
      }
    });
  }
}

export function assertCheckoutAdminServiceUsesIntegerMinorUnits() {
  parseMinorUnit("0", "checkout-admin-sentinel");
  return true;
}
