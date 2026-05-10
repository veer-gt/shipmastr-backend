import type { Order, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { phoneHash } from "./fingerprint.js";

type Db = Prisma.TransactionClient | typeof prisma;

function rate(part: number, total: number) {
  return total ? Number((part / total).toFixed(4)) : 0;
}

export function calculateMerchantMetricSnapshot(orders: Array<Pick<Order, "paymentMode" | "status" | "codAmount" | "orderValue">>, fraudSignalCount = 0) {
  const total = orders.length;
  const codOrders = orders.filter((order) => order.paymentMode === "COD").length;
  const prepaidOrders = total - codOrders;
  const delivered = orders.filter((order) => order.status === "DELIVERED").length;
  const ndr = orders.filter((order) => order.status === "NDR").length;
  const rto = orders.filter((order) => order.status === "RTO").length;
  const codExposure = orders.reduce((sum, order) => sum + order.codAmount, 0);
  const orderValueTotal = orders.reduce((sum, order) => sum + order.orderValue, 0);
  const trustScore = Math.max(0, Math.min(100, Math.round(50 + rate(delivered, total) * 35 - rate(rto, total) * 45 - rate(ndr, total) * 20 - Math.min(fraudSignalCount * 4, 20))));

  return {
    total,
    codOrders,
    prepaidOrders,
    delivered,
    ndr,
    rto,
    codExposure,
    orderValueTotal,
    rtoRate: rate(rto, total),
    ndrRate: rate(ndr, total),
    deliveryRate: rate(delivered, total),
    trustScore
  };
}

export async function updateBuyerBehaviourProfile(order: Order, client: Db = prisma) {
  const hash = phoneHash(order.buyerPhone);
  const isCod = order.paymentMode === "COD";
  const isDelivered = order.status === "DELIVERED";
  const isNdr = order.status === "NDR";
  const isRto = order.status === "RTO";

  return client.buyerBehaviourProfile.upsert({
    where: {
      merchantId_phoneHash: {
        merchantId: order.merchantId,
        phoneHash: hash
      }
    },
    create: {
      merchantId: order.merchantId,
      phoneHash: hash,
      totalOrders: 1,
      codOrders: isCod ? 1 : 0,
      prepaidOrders: isCod ? 0 : 1,
      deliveredOrders: isDelivered ? 1 : 0,
      ndrOrders: isNdr ? 1 : 0,
      rtoOrders: isRto ? 1 : 0,
      riskScore: isRto ? 65 : isNdr ? 50 : 20
    },
    update: {
      totalOrders: { increment: 1 },
      ...(isCod ? { codOrders: { increment: 1 } } : {}),
      ...(!isCod ? { prepaidOrders: { increment: 1 } } : {}),
      ...(isDelivered ? { deliveredOrders: { increment: 1 } } : {}),
      ...(isNdr ? { ndrOrders: { increment: 1 } } : {}),
      ...(isRto ? { rtoOrders: { increment: 1 } } : {}),
      riskScore: isRto ? 65 : isNdr ? 50 : 20
    }
  });
}

export async function updateCodBehaviourProfile(order: Order, client: Db = prisma) {
  if (order.paymentMode !== "COD") return null;

  const hash = phoneHash(order.buyerPhone);
  const isDelivered = order.status === "DELIVERED";
  const isRto = order.status === "RTO";

  const profile = await client.codBehaviourProfile.upsert({
    where: {
      merchantId_phoneHash: {
        merchantId: order.merchantId,
        phoneHash: hash
      }
    },
    create: {
      merchantId: order.merchantId,
      phoneHash: hash,
      totalCodOrders: 1,
      deliveredCodOrders: isDelivered ? 1 : 0,
      rtoCodOrders: isRto ? 1 : 0,
      codExposure: order.codAmount,
      codSuccessRate: isDelivered ? 1 : 0
    },
    update: {
      totalCodOrders: { increment: 1 },
      ...(isDelivered ? { deliveredCodOrders: { increment: 1 } } : {}),
      ...(isRto ? { rtoCodOrders: { increment: 1 } } : {}),
      codExposure: { increment: order.codAmount }
    }
  });

  return client.codBehaviourProfile.update({
    where: { id: profile.id },
    data: {
      codSuccessRate: rate(profile.deliveredCodOrders, profile.totalCodOrders)
    }
  });
}

export async function updateMerchantMetrics(merchantId: string, client: Db = prisma) {
  const [orders, fraudSignals] = await Promise.all([
    client.order.findMany({ where: { merchantId } }),
    client.fraudSignal.count({ where: { merchantId } })
  ]);

  const snapshot = calculateMerchantMetricSnapshot(orders, fraudSignals);

  return client.merchantMetrics.upsert({
    where: { merchantId },
    create: {
      merchantId,
      totalOrders: snapshot.total,
      codOrders: snapshot.codOrders,
      prepaidOrders: snapshot.prepaidOrders,
      deliveredOrders: snapshot.delivered,
      ndrOrders: snapshot.ndr,
      rtoOrders: snapshot.rto,
      fraudSignalCount: fraudSignals,
      codExposure: snapshot.codExposure,
      orderValueTotal: snapshot.orderValueTotal,
      rtoRate: snapshot.rtoRate,
      ndrRate: snapshot.ndrRate,
      deliveryRate: snapshot.deliveryRate,
      trustScore: snapshot.trustScore
    },
    update: {
      totalOrders: snapshot.total,
      codOrders: snapshot.codOrders,
      prepaidOrders: snapshot.prepaidOrders,
      deliveredOrders: snapshot.delivered,
      ndrOrders: snapshot.ndr,
      rtoOrders: snapshot.rto,
      fraudSignalCount: fraudSignals,
      codExposure: snapshot.codExposure,
      orderValueTotal: snapshot.orderValueTotal,
      rtoRate: snapshot.rtoRate,
      ndrRate: snapshot.ndrRate,
      deliveryRate: snapshot.deliveryRate,
      trustScore: snapshot.trustScore
    }
  });
}
