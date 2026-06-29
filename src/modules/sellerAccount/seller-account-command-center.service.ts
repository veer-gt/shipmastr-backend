import { prisma } from "../../lib/prisma.js";

type DbClient = typeof prisma | Record<string, any>;

const READY_ONBOARDING_STATUSES = new Set(["COMPLETED", "READY_TO_SHIP", "VERIFIED", "APPROVED"]);
const NEEDS_REVIEW_STATUSES = new Set(["BLOCKED", "REJECTED", "FAILED", "HELD", "NEEDS_ATTENTION"]);
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
  if (READY_ONBOARDING_STATUSES.has(status)) return "ready";
  if (NEEDS_REVIEW_STATUSES.has(status)) return "needs_review";
  if (status === "IN_PROGRESS" || status === "UNDER_REVIEW" || status === "DETAILS_SUBMITTED") return "needs_review";
  return "not_started";
}

function checklistItem(key: string, label: string, statusValue: unknown, route: string, detail: string) {
  const status = readinessStatus(statusValue);
  return {
    key,
    label,
    status,
    route,
    detail
  };
}

function setupScore(items: Array<{ status: string }>) {
  if (!items.length) return 0;
  const ready = items.filter((item) => item.status === "ready").length;
  return Math.round((ready / items.length) * 100);
}

function safeMoneyState(count: number, source: string) {
  return {
    status: count > 0 ? "available" : "no_activity",
    source,
    currency: "INR"
  };
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

function leakSafeResponse(value: unknown) {
  const serialized = JSON.stringify(value);
  return !/(courierPartner|provider|imageObjectKey|objectKey|bucket|storage\.googleapis\.com|signedUrl|uploadUrl|Bearer|DATABASE_URL|secret|token)/i.test(serialized);
}

export async function buildSellerAccountCommandCenter(merchantId: string, client: DbClient = prisma) {
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
    proofArchived
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
    safeCount((client as any).shippingWeightProof, { where: { merchantId, OR: [{ imageRetentionStatus: "DELETED_AFTER_PAYOUT" }, { imageDeletedAt: { not: null } }] } })
  ]);

  const readinessChecklist = [
    checklistItem("business-profile", "Business profile", merchant?.name ? "COMPLETED" : "PENDING", "/seller/setup", "Business identity and seller basics are present."),
    checklistItem("kyc", "GST/KYC readiness", merchant?.kycStatus ?? merchant?.sellerKycStatus, "/seller/onboarding", "GST, PAN, bank, and KYC readiness."),
    checklistItem("pickup", "Pickup readiness", pickupLocations > 0 ? "COMPLETED" : merchant?.pickupAddressStatus, "/seller/pickups", "At least one active pickup or warehouse location is ready."),
    checklistItem("first-shipment", "First shipment readiness", orderTotal > 0 || activeShipments > 0 ? "COMPLETED" : merchant?.firstShipmentStatus, "/seller/orders", "Order and shipment workflow is available."),
    checklistItem("wallet-cod", "Wallet/COD visibility", walletEntries > 0 || codPending > 0 || codReceived > 0 ? "COMPLETED" : "PENDING", "/seller/wallet", "Ledger and COD lifecycle are visible without mutation."),
    checklistItem("support", "Support readiness", "COMPLETED", "/seller/help", "Help, support, and training paths are available.")
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
      detail: "Orders, shipment exceptions, NDR, returns, or Weight Guard items need review.",
      route: "/seller/shipping",
      priority: 20,
      severity: "warning"
    });
  }
  if (readyToShipOrders || readyToShipShipments) {
    pushAction(nextActions, {
      key: "ready-to-ship",
      label: "Prepare ready-to-ship queue",
      detail: "Review ready orders and shipment drafts before release.",
      route: "/seller/shipping",
      priority: 30
    });
  }
  if (ndrOpen || returnsOpen) {
    pushAction(nextActions, {
      key: "exceptions",
      label: "Resolve NDR/returns attention",
      detail: "Open NDR or return/RTO cases are waiting for review.",
      route: ndrOpen ? "/seller/ndr" : "/seller/returns",
      priority: 40,
      severity: "warning"
    });
  }
  if (proofCaptured || proofArchived) {
    pushAction(nextActions, {
      key: "weight-guard",
      label: "Review Weight Guard evidence",
      detail: "Captured proof metadata is available for audit-safe review.",
      route: "/seller/weight-management",
      priority: 50
    });
  }
  if (!nextActions.length) {
    pushAction(nextActions, {
      key: "all-clear",
      label: "No immediate action required",
      detail: "No urgent setup, order, finance, NDR, return, or Weight Guard action is visible.",
      route: "/seller/reports",
      priority: 100,
      severity: "success"
    });
  }

  const response = {
    generatedAt: new Date().toISOString(),
    seller: {
      id: merchantId,
      displayName: merchant?.name ?? "Shipmastr Seller"
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
      status: proofCaptured || proofArchived ? "evidence_available" : "no_activity",
      imageStorage: "private",
      directSignedUpload: "parked",
      uploadMode: "backend_mediated"
    },
    pickupWarehouseSummary: {
      activePickupLocations: pickupLocations,
      status: pickupLocations > 0 ? "ready" : "needs_setup"
    },
    customerSummary: {
      status: orderTotal > 0 ? "activity_available" : "no_activity",
      source: "orders",
      knownFromOrders: orderTotal
    },
    alerts: nextActions
      .filter((action) => action.severity === "warning")
      .map((action) => ({
        key: action.key,
        label: action.label,
        route: action.route,
        severity: action.severity
      })),
    links: {
      orders: "/seller/orders",
      shipping: "/seller/shipping",
      wallet: "/seller/wallet",
      cod: "/seller/cod",
      billing: "/seller/billing",
      ndr: "/seller/ndr",
      returns: "/seller/returns",
      weightGuard: "/seller/weight-management",
      pickups: "/seller/pickups",
      warehouses: "/seller/warehouses",
      customers: "/seller/customers",
      notifications: "/seller/notifications",
      support: "/seller/support"
    }
  };

  if (!leakSafeResponse(response)) {
    throw new Error("SELLER_ACCOUNT_COMMAND_CENTER_UNSAFE_RESPONSE");
  }

  return response;
}
