import { Router, type Request, type Response } from "express";
import { prisma } from "../../lib/prisma.js";
import {
  buildCodDashboardApiResponse,
  buildCodDashboardApiResponseFromOrders
} from "./cod-dashboard-summary.service.js";

export const codDashboardRouter = Router();

export async function getCodDashboardSummaryHandler(req: Request, res: Response) {
  const generatedAt = new Date().toISOString();
  const merchantId = req.auth?.merchantId;

  if (!merchantId) {
    return res.json(buildCodDashboardApiResponse(generatedAt));
  }

  try {
    const orders = await prisma.order.findMany({
      where: {
        merchantId,
        paymentMode: "COD"
      },
      orderBy: {
        createdAt: "desc"
      },
      take: 50,
      select: {
        id: true,
        externalOrderId: true,
        city: true,
        state: true,
        orderValue: true,
        codAmount: true,
        paymentMode: true,
        status: true,
        weightGrams: true,
        shipmentDetails: {
          select: {
            awb: true,
            courierId: true,
            weightGrams: true,
            volumetricWeight: true,
            shipmentStatus: true
          }
        },
        orderIntelligence: {
          select: {
            consigneeTier: true,
            codDecision: true,
            shipmentDecision: true,
            courierId: true
          }
        }
      }
    });

    const courierIds = [...new Set(orders.flatMap((order) => [
      order.shipmentDetails?.courierId,
      order.orderIntelligence?.courierId
    ].filter((courierId): courierId is string => Boolean(courierId))))];
    const couriers = courierIds.length > 0
      ? await prisma.courierPartner.findMany({
        where: {
          id: {
            in: courierIds
          }
        },
        select: {
          id: true,
          name: true,
          code: true
        }
      })
      : [];
    const courierLabels = new Map(couriers.map((courier) => [
      courier.id,
      courier.name || courier.code
    ]));
    const enrichedOrders = orders.map((order) => {
      const shipmentCourierId = order.shipmentDetails?.courierId ?? order.orderIntelligence?.courierId ?? null;

      return {
        ...order,
        shipmentDetails: order.shipmentDetails
          ? {
            ...order.shipmentDetails,
            carrierName: shipmentCourierId ? courierLabels.get(shipmentCourierId) ?? null : null
          }
          : null
      };
    });

    return res.json(buildCodDashboardApiResponseFromOrders(enrichedOrders, generatedAt));
  } catch {
    return res.json(buildCodDashboardApiResponse(generatedAt));
  }
}

codDashboardRouter.get("/dashboard/summary", getCodDashboardSummaryHandler);
