import { prisma } from "../../lib/prisma.js";

type DbClient = typeof prisma | Record<string, any>;

const READY_STATUSES = new Set(["COMPLETED", "READY_TO_SHIP", "VERIFIED", "APPROVED"]);
const REVIEW_STATUSES = new Set(["BLOCKED", "REJECTED", "FAILED", "HELD", "NEEDS_ATTENTION", "IN_PROGRESS", "UNDER_REVIEW", "DETAILS_SUBMITTED"]);
const OPEN_NDR_STATUSES = ["open", "action_required", "pending", "needs_action"];
const OPEN_RTO_STATUSES = ["initiated", "in_transit", "received", "open", "pending"];

function numberValue(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

async function safeCount(model: any, args: Record<string, unknown>) {
  if (!model?.count) return 0;
  try {
    return numberValue(await model.count(args));
  } catch {
    return 0;
  }
}

async function safeFindUnique(model: any, args: Record<string, unknown>) {
  if (!model?.findUnique) return null;
  try {
    return await model.findUnique(args);
  } catch {
    return null;
  }
}

async function latestWalletLedger(client: DbClient, merchantId: string) {
  const model = (client as any).sellerWalletLedger;
  if (!model?.findFirst) return null;
  try {
    return await model.findFirst({
      where: { merchantId },
      orderBy: [{ postedAt: "desc" }, { createdAt: "desc" }],
      select: {
        balanceAfter: true,
        currency: true,
        status: true,
        postedAt: true,
        createdAt: true
      }
    });
  } catch {
    return null;
  }
}

function readinessStatus(value: unknown) {
  const status = String(value ?? "").trim().toUpperCase();
  if (READY_STATUSES.has(status)) return "ready";
  if (REVIEW_STATUSES.has(status)) return "needs_review";
  return "not_started";
}

function checklistItem(key: string, label: string, statusValue: unknown, route: string, detail: string) {
  return {
    key,
    label,
    status: readinessStatus(statusValue),
    route,
    detail
  };
}

function setupScore(items: Array<{ status: string }>) {
  if (!items.length) return 0;
  const ready = items.filter((item) => item.status === "ready").length;
  return Math.round((ready / items.length) * 100);
}

function queueItem(key: string, label: string, count: number, route: string, status: string, detail: string) {
  return { key, label, count, route, status, detail };
}

function pushAction(actions: any[], input: {
  key: string;
  label: string;
  detail: string;
  route: string;
  priority: number;
  severity?: string;
}) {
  actions.push({
    severity: input.severity ?? "info",
    ...input
  });
}

function safeMoneyState(count: number, source: string) {
  return {
    status: count > 0 ? "available" : "no_activity",
    source,
    currency: "INR"
  };
}

function leakSafeResponse(value: unknown) {
  const serialized = JSON.stringify(value);
  return !/(courierPartner|provider|imageObjectKey|objectKey|bucket|storage\.googleapis\.com|signedUrl|uploadUrl|Bearer|DATABASE_URL|secret|token)/i.test(serialized);
}

export async function buildMerchantAccountCommandCenter(merchantId: string, client: DbClient = prisma) {
  const merchant = await safeFindUnique((client as any).merchant, {
    where: { id: merchantId },
    select: {
      id: true,
      name: true,
      onboardingStatus: true,
      pickupAddressStatus: true,
      kycStatus: true,
      bankStatus: true,
      firstShipmentStatus: true,
      sellerKycStatus: true
    }
  });

  const [
    orderTotal,
    unfulfilledOrders,
    readyToShipOrders,
    orderNeedsAttention,
    activeShipments,
    readyToShipShipments,
    inTransitShipments,
    deliveredShipments,
    returnShipments,
    exceptionShipments,
    pickupLocations,
    ndrOpen,
    returnsOpen,
    codPending,
    codReceived,
    walletEntries,
    walletLedger,
    proofCaptured,
    proofArchived,
    customerCount
  ] = await Promise.all([
    safeCount((client as any).order, { where: { merchantId } }),
    safeCount((client as any).order, { where: { merchantId, status: { in: ["CREATED", "RISK_SCORED", "VERIFIED", "HELD", "NEEDS_ATTENTION"] } } }),
    safeCount((client as any).order, { where: { merchantId, status: "READY_TO_SHIP" } }),
    safeCount((client as any).order, { where: { merchantId, status: { in: ["HELD", "NEEDS_ATTENTION", "NDR", "RTO"] } } }),
    safeCount((client as any).shipment, { where: { sellerId: merchantId } }),
    safeCount((client as any).shipment, { where: { sellerId: merchantId, status: { in: ["draft", "rates_fetched", "manifested", "pickup_scheduled"] } } }),
    safeCount((client as any).shipment, { where: { sellerId: merchantId, status: { in: ["picked_up", "in_transit", "out_for_delivery"] } } }),
    safeCount((client as any).shipment, { where: { sellerId: merchantId, status: "delivered" } }),
    safeCount((client as any).shipment, { where: { sellerId: merchantId, status: { in: ["rto_initiated", "rto_in_transit", "rto_delivered", "cancelled"] } } }),
    safeCount((client as any).shipment, { where: { sellerId: merchantId, status: { in: ["delivery_failed", "lost", "damaged", "exception"] } } }),
    safeCount((client as any).pickupLocation, { where: { sellerId: merchantId, status: "active" } }),
    safeCount((client as any).ndrCase, { where: { merchantId, status: { in: OPEN_NDR_STATUSES } } }),
    safeCount((client as any).rtoCase, { where: { merchantId, status: { in: OPEN_RTO_STATUSES } } }),
    safeCount((client as any).codLedgerEntry, { where: { merchantId, status: { in: ["pending", "due", "delayed"] } } }),
    safeCount((client as any).codLedgerEntry, { where: { merchantId, status: { in: ["collected", "remitted"] } } }),
    safeCount((client as any).sellerWalletLedger, { where: { merchantId } }),
    latestWalletLedger(client, merchantId),
    safeCount((client as any).shippingWeightProof, { where: { merchantId, imageRetentionStatus: "ACTIVE" } }),
    safeCount((client as any).shippingWeightProof, { where: { merchantId, OR: [{ imageRetentionStatus: "DELETED_AFTER_PAYOUT" }, { imageDeletedAt: { not: null } }] } }),
    safeCount((client as any).customer, { where: { merchantId } })
  ]);

  const readinessChecklist = [
    checklistItem("business-profile", "Business profile", merchant?.name ? "COMPLETED" : "PENDING", "/merchant/setup", "Merchant identity and account basics are present."),
    checklistItem("kyc", "GST/KYC readiness", merchant?.kycStatus ?? merchant?.sellerKycStatus, "/merchant/setup", "GST, PAN, bank, and KYC readiness."),
    checklistItem("pickup", "Pickup readiness", pickupLocations > 0 ? "COMPLETED" : merchant?.pickupAddressStatus, "/merchant/pickups", "At least one active pickup location is ready."),
    checklistItem("warehouse", "Warehouse readiness", pickupLocations > 0 ? "COMPLETED" : "PENDING", "/merchant/warehouses", "Warehouse and dispatch readiness is available."),
    checklistItem("first-shipment", "First shipment readiness", orderTotal > 0 || activeShipments > 0 ? "COMPLETED" : merchant?.firstShipmentStatus, "/merchant/orders", "Order and shipment workflow is available."),
    checklistItem("finance", "Wallet/COD/Billing visibility", walletEntries > 0 || codPending > 0 || codReceived > 0 ? "COMPLETED" : "PENDING", "/merchant/finance", "Finance surfaces are visible without mutation."),
    checklistItem("customers", "Customer readiness", customerCount > 0 || orderTotal > 0 ? "COMPLETED" : "PENDING", "/merchant/customers", "Customer records or order-derived customer activity are available.")
  ];

  const score = setupScore(readinessChecklist);
  const nextActions: any[] = [];
  const firstIncomplete = readinessChecklist.find((item) => item.status !== "ready");
  if (firstIncomplete) {
    pushAction(nextActions, {
      key: `setup-${firstIncomplete.key}`,
      label: firstIncomplete.label,
      detail: firstIncomplete.detail,
      route: firstIncomplete.route,
      priority: 10,
      severity: firstIncomplete.status === "needs_review" ? "warning" : "info"
    });
  }
  if (orderNeedsAttention || exceptionShipments) {
    pushAction(nextActions, {
      key: "needs-attention",
      label: "Review needs-attention queue",
      detail: "Orders, shipment exceptions, NDR, returns, or Weight Guard items need merchant review.",
      route: "/merchant/shipping",
      priority: 20,
      severity: "warning"
    });
  }
  if (readyToShipOrders || readyToShipShipments) {
    pushAction(nextActions, {
      key: "ready-to-ship",
      label: "Prepare ready-to-ship queue",
      detail: "Review ready orders and shipment drafts before release.",
      route: "/merchant/quick-delivery",
      priority: 30
    });
  }
  if (ndrOpen || returnsOpen) {
    pushAction(nextActions, {
      key: "ndr-returns",
      label: "Resolve NDR/returns attention",
      detail: "Open NDR or return/RTO cases are waiting for review.",
      route: ndrOpen ? "/merchant/ndr" : "/merchant/returns",
      priority: 40,
      severity: "warning"
    });
  }
  if (proofCaptured || proofArchived) {
    pushAction(nextActions, {
      key: "weight-guard",
      label: "Review Weight Guard evidence",
      detail: "Captured proof metadata is available for audit-safe review.",
      route: "/merchant/weight",
      priority: 50
    });
  }
  if (!pickupLocations) {
    pushAction(nextActions, {
      key: "pickup-warehouse-setup",
      label: "Complete pickup or warehouse setup",
      detail: "Add at least one active pickup or warehouse location before operating at scale.",
      route: "/merchant/pickups",
      priority: 60,
      severity: "warning"
    });
  }
  if (walletLedger?.balanceAfter !== null && walletLedger?.balanceAfter !== undefined && numberValue(walletLedger.balanceAfter) < 500) {
    pushAction(nextActions, {
      key: "wallet-review",
      label: "Review wallet balance",
      detail: "Wallet balance is low. Review the audit-safe passbook before shipping volume increases.",
      route: "/merchant/wallet",
      priority: 70,
      severity: "warning"
    });
  }
  const proofMissing = activeShipments > 0 && proofCaptured + proofArchived === 0 ? activeShipments : 0;
  if (proofMissing) {
    pushAction(nextActions, {
      key: "weight-guard-proof-missing",
      label: "Capture Weight Guard proof",
      detail: "Active shipments do not yet show private Weight Guard evidence metadata.",
      route: "/merchant/weight",
      priority: 80
    });
  }
  if (!nextActions.length) {
    pushAction(nextActions, {
      key: "all-clear",
      label: "No immediate action required",
      detail: "No urgent setup, order, finance, NDR, return, or Weight Guard action is visible.",
      route: "/merchant/reports",
      priority: 100,
      severity: "success"
    });
  }

  const response = {
    generatedAt: new Date().toISOString(),
    merchantProfile: {
      id: merchantId,
      displayName: merchant?.name ?? "Shipmastr Merchant"
    },
    setupScore: score,
    readinessChecklist,
    nextActions: nextActions.sort((left, right) => left.priority - right.priority),
    orderSummary: {
      total: orderTotal,
      unfulfilled: unfulfilledOrders,
      readyToShip: readyToShipOrders,
      needsAttention: orderNeedsAttention
    },
    shipmentSummary: {
      total: activeShipments,
      readyToShip: readyToShipShipments,
      inTransit: inTransitShipments,
      delivered: deliveredShipments,
      returnsRto: returnShipments,
      needsAttention: exceptionShipments
    },
    walletSummary: {
      ...safeMoneyState(walletEntries, "seller_wallet_ledger"),
      ledgerEntries: walletEntries,
      latestBalance: walletLedger?.balanceAfter ?? null,
      latestBalanceAt: walletLedger?.postedAt ?? walletLedger?.createdAt ?? null
    },
    codSummary: {
      ...safeMoneyState(codPending + codReceived, "cod_ledger_entries"),
      pendingCount: codPending,
      receivedCount: codReceived
    },
    billingSummary: {
      status: "read_only",
      source: "finance_dashboard",
      openItems: 0,
      note: "Billing and settlement amounts remain finance-reviewed and are not fabricated by this read model."
    },
    ndrSummary: {
      open: ndrOpen,
      status: ndrOpen > 0 ? "needs_attention" : "clear"
    },
    returnsSummary: {
      open: returnsOpen,
      status: returnsOpen > 0 ? "needs_attention" : "clear"
    },
    weightGuardSummary: {
      proofCaptured,
      proofArchivedAfterPayout: proofArchived,
      proofMissing,
      status: proofMissing ? "needs_attention" : proofCaptured || proofArchived ? "evidence_available" : "no_activity",
      uploadMode: "backend_mediated"
    },
    pickupWarehouseSummary: {
      activePickupLocations: pickupLocations,
      status: pickupLocations > 0 ? "ready" : "needs_setup"
    },
    customerSummary: {
      knownCustomers: customerCount,
      knownFromOrders: orderTotal,
      status: customerCount > 0 || orderTotal > 0 ? "activity_available" : "no_activity",
      source: customerCount > 0 ? "customers" : "orders"
    },
    queues: [
      queueItem("unfulfilled-orders", "Unfulfilled", unfulfilledOrders, "/merchant/orders", unfulfilledOrders ? "needs_review" : "clear", "Orders waiting for merchant review."),
      queueItem("ready-to-ship", "Ready to Ship", readyToShipOrders + readyToShipShipments, "/merchant/quick-delivery", readyToShipOrders + readyToShipShipments ? "ready" : "clear", "Orders or shipment drafts ready for guarded shipping review."),
      queueItem("needs-attention", "Needs Attention", orderNeedsAttention + exceptionShipments, "/merchant/shipping", orderNeedsAttention + exceptionShipments ? "needs_attention" : "clear", "Orders and shipments that need review before movement."),
      queueItem("in-transit", "In Transit", inTransitShipments, "/merchant/shipping", inTransitShipments ? "active" : "clear", "Shipments currently moving through the Shipmastr lifecycle."),
      queueItem("returns-rto", "Returns/RTO", returnShipments + returnsOpen, "/merchant/returns", returnShipments + returnsOpen ? "needs_attention" : "clear", "Return and RTO work stays separate from forward movement."),
      queueItem("ndr", "NDR", ndrOpen, "/merchant/ndr", ndrOpen ? "needs_attention" : "clear", "NDR cases requiring merchant review."),
      queueItem("wallet", "Wallet", walletLedger?.balanceAfter !== null && walletLedger?.balanceAfter !== undefined && numberValue(walletLedger.balanceAfter) < 500 ? 1 : 0, "/merchant/wallet", walletLedger ? "available" : "no_activity", "Audit-safe wallet and passbook visibility."),
      queueItem("cod", "COD", codPending + codReceived, "/merchant/cod", codPending ? "needs_review" : codReceived ? "available" : "no_activity", "COD pending and received states remain finance-reviewed."),
      queueItem("billing", "Billing", 0, "/merchant/billing", "read_only", "Billing due amounts are not fabricated by this read model."),
      queueItem("weight-guard", "Weight Guard", proofMissing + proofCaptured + proofArchived, "/merchant/weight", proofMissing ? "needs_attention" : proofCaptured + proofArchived ? "available" : "no_activity", "Private proof metadata is available without file details."),
      queueItem("pickup-warehouse", "Pickup/Warehouse", pickupLocations, "/merchant/pickups", pickupLocations ? "ready" : "needs_setup", "Pickup and warehouse readiness for daily operations."),
      queueItem("customers", "Customers", customerCount || orderTotal, "/merchant/customers", customerCount || orderTotal ? "available" : "no_activity", "Customer readiness based on merchant-scoped activity.")
    ],
    alerts: nextActions
      .filter((action) => action.severity === "warning")
      .map((action) => ({
        key: action.key,
        label: action.label,
        route: action.route,
        severity: action.severity
      })),
    links: {
      home: "/merchant/home",
      dashboard: "/merchant/dashboard",
      orders: "/merchant/orders",
      shipping: "/merchant/shipping",
      quickDelivery: "/merchant/quick-delivery",
      wallet: "/merchant/wallet",
      cod: "/merchant/cod",
      billing: "/merchant/billing",
      ndr: "/merchant/ndr",
      returns: "/merchant/returns",
      weightGuard: "/merchant/weight",
      pickups: "/merchant/pickups",
      warehouses: "/merchant/warehouses",
      customers: "/merchant/customers",
      vas: "/merchant/vas",
      setup: "/merchant/setup"
    }
  };

  if (!leakSafeResponse(response)) {
    throw new Error("MERCHANT_ACCOUNT_COMMAND_CENTER_UNSAFE_RESPONSE");
  }

  return response;
}
