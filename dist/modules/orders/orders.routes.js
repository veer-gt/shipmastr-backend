import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../../middleware/auth.js";
import { requireIdempotency } from "../../middleware/idempotency.js";
import { scoreOrder } from "../risk/risk.service.js";
export const ordersRouter = Router();
ordersRouter.use(requireAuth);
const createOrderSchema = z.object({
    externalOrderId: z.string(),
    buyerName: z.string(),
    buyerPhone: z.string(),
    addressLine1: z.string(),
    addressLine2: z.string().optional(),
    city: z.string(),
    state: z.string(),
    pincode: z.string(),
    orderValue: z.number(),
    codAmount: z.number().default(0),
    paymentMode: z.enum(["PREPAID", "COD"]),
    weightGrams: z.number().optional()
});
ordersRouter.post("/", requireIdempotency, async (req, res) => {
    const body = createOrderSchema.parse(req.body);
    const order = await prisma.order.create({
        data: {
            merchantId: req.auth.merchantId,
            externalOrderId: body.externalOrderId,
            buyerName: body.buyerName,
            buyerPhone: body.buyerPhone,
            addressLine1: body.addressLine1,
            addressLine2: body.addressLine2 ?? null,
            city: body.city,
            state: body.state,
            pincode: body.pincode,
            orderValue: body.orderValue,
            codAmount: body.codAmount,
            paymentMode: body.paymentMode,
            weightGrams: body.weightGrams ?? null
        }
    });
    const risk = await scoreOrder(order.id);
    res.status(201).json({
        order,
        risk
    });
});
ordersRouter.get("/", async (req, res) => {
    const orders = await prisma.order.findMany({
        where: {
            merchantId: req.auth.merchantId
        },
        include: {
            riskScores: true
        },
        orderBy: {
            createdAt: "desc"
        }
    });
    res.json({ orders });
});
ordersRouter.get("/:id", async (req, res) => {
    const order = await prisma.order.findFirstOrThrow({
        where: {
            id: req.params.id,
            merchantId: req.auth.merchantId
        },
        include: {
            riskScores: true,
            webhookEvents: true
        }
    });
    res.json({ order });
});
//# sourceMappingURL=orders.routes.js.map