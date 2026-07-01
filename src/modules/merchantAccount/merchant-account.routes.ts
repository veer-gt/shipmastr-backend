import { Router } from "express";
import { z } from "zod";
import { ActorType, actorTypeForAccount } from "../../lib/accountRoles.js";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import {
  createMerchantPickupPoint,
  listMerchantTaxProfile,
  updateMerchantPickupPoint
} from "../taxCompliance/tax-compliance.service.js";
import { buildMerchantAccountCommandCenter } from "./merchant-account-command-center.service.js";
import {
  assertMerchantWorkspaceResponseSafe,
  buildMerchantSetupWorkspace,
  createMerchantCustomer,
  createMerchantWarehouse,
  listMerchantCustomers,
  listMerchantWarehouses,
  updateMerchantCustomer,
  updateMerchantWarehouse
} from "./merchant-account-workspaces.service.js";

export const merchantAccountRouter = Router();
export const merchantWorkspaceRouter = Router();

const baseAddressSchema = z.object({
  phone: z.string().trim().min(8).max(20),
  addressLine1: z.string().trim().min(4).max(500),
  addressLine2: z.string().trim().max(500).optional().nullable().or(z.literal("")),
  city: z.string().trim().min(2).max(160),
  state: z.string().trim().min(2).max(120),
  pincode: z.string().trim().regex(/^\d{6}$/),
  country: z.string().trim().max(20).optional().nullable().or(z.literal("")),
  latitude: z.never().optional(),
  longitude: z.never().optional()
});

const googlePlaceIdSchema = {
  googlePlaceId: z.string().trim().max(240).optional().nullable().or(z.literal(""))
};

const baseLocationSchema = baseAddressSchema.extend({
  contactName: z.string().trim().min(2).max(160)
});

const pickupSchema = baseLocationSchema.extend({
  ...googlePlaceIdSchema,
  label: z.string().trim().min(2).max(160),
  isDefault: z.boolean().optional()
});

const pickupPatchSchema = pickupSchema.partial().refine((body) => Object.keys(body).length > 0, {
  message: "At least one pickup field is required"
});

const warehouseSchema = baseLocationSchema.extend({
  ...googlePlaceIdSchema,
  name: z.string().trim().min(2).max(160),
  notes: z.string().trim().max(800).optional().nullable().or(z.literal("")),
  isPrimary: z.boolean().optional(),
  isActive: z.boolean().optional()
});

const warehousePatchSchema = warehouseSchema.partial().refine((body) => Object.keys(body).length > 0, {
  message: "At least one warehouse field is required"
});

const customerSchema = baseAddressSchema.extend({
  name: z.string().trim().min(2).max(160),
  email: z.string().trim().email().optional().nullable().or(z.literal("")),
  isActive: z.boolean().optional()
});

const customerPatchSchema = customerSchema.partial().refine((body) => Object.keys(body).length > 0, {
  message: "At least one customer field is required"
});

export async function requireMerchantCommandCenterActor(input: {
  userId: string;
  merchantId: string;
}, client: Pick<typeof prisma, "user"> | Record<string, any> = prisma) {
  const user = await (client as any).user.findUnique({
    where: { id: input.userId },
    select: {
      id: true,
      merchantId: true,
      role: true,
      userType: true,
      merchant: {
        select: {
          onboardingStatus: true
        }
      }
    }
  });

  if (!user || user.merchantId !== input.merchantId) {
    throw new HttpError(403, "MERCHANT_SCOPE_DENIED");
  }

  const actorType = actorTypeForAccount({
    role: user.role,
    userType: user.userType,
    onboardingStatus: user.merchant?.onboardingStatus
  });

  if (actorType !== ActorType.MERCHANT) {
    throw new HttpError(403, "MERCHANT_ACCOUNT_ONLY");
  }

  return user;
}

merchantAccountRouter.get("/command-center", async (req, res) => {
  await requireMerchantCommandCenterActor({
    userId: req.auth!.userId,
    merchantId: req.auth!.merchantId!
  });

  const commandCenter = await buildMerchantAccountCommandCenter(req.auth!.merchantId!);
  res.json({ data: commandCenter });
});

async function requireMerchantWorkspace(req: any) {
  await requireMerchantCommandCenterActor({
    userId: req.auth!.userId,
    merchantId: req.auth!.merchantId!
  });
  return req.auth!.merchantId! as string;
}

merchantWorkspaceRouter.get("/setup", async (req, res) => {
  const merchantId = await requireMerchantWorkspace(req);
  const data = await buildMerchantSetupWorkspace(merchantId);
  assertMerchantWorkspaceResponseSafe(data);
  res.json({ data });
});

merchantWorkspaceRouter.get("/pickups", async (req, res) => {
  const merchantId = await requireMerchantWorkspace(req);
  const profile = await listMerchantTaxProfile(merchantId);
  const data = { pickupPoints: profile.pickupPoints || [] };
  assertMerchantWorkspaceResponseSafe(data);
  res.json({ data });
});

merchantWorkspaceRouter.post("/pickups", async (req, res) => {
  const merchantId = await requireMerchantWorkspace(req);
  const body = pickupSchema.parse(req.body);
  const pickupPoint = await createMerchantPickupPoint({
    merchantId,
    actorId: req.auth!.userId,
    pickup: body
  });
  const data = { pickupPoint };
  assertMerchantWorkspaceResponseSafe(data);
  res.status(201).json({ data });
});

merchantWorkspaceRouter.patch("/pickups/:pickupPointId", async (req, res) => {
  const merchantId = await requireMerchantWorkspace(req);
  const body = pickupPatchSchema.parse(req.body);
  const pickupPoint = await updateMerchantPickupPoint({
    merchantId,
    pickupPointId: req.params.pickupPointId,
    actorId: req.auth!.userId,
    patch: body
  });
  const data = { pickupPoint };
  assertMerchantWorkspaceResponseSafe(data);
  res.json({ data });
});

merchantWorkspaceRouter.get("/warehouses", async (req, res) => {
  const merchantId = await requireMerchantWorkspace(req);
  const data = { warehouses: await listMerchantWarehouses(merchantId) };
  assertMerchantWorkspaceResponseSafe(data);
  res.json({ data });
});

merchantWorkspaceRouter.post("/warehouses", async (req, res) => {
  const merchantId = await requireMerchantWorkspace(req);
  const warehouse = await createMerchantWarehouse(merchantId, warehouseSchema.parse(req.body));
  const data = { warehouse };
  assertMerchantWorkspaceResponseSafe(data);
  res.status(201).json({ data });
});

merchantWorkspaceRouter.patch("/warehouses/:warehouseId", async (req, res) => {
  const merchantId = await requireMerchantWorkspace(req);
  const warehouse = await updateMerchantWarehouse(merchantId, req.params.warehouseId, warehousePatchSchema.parse(req.body));
  const data = { warehouse };
  assertMerchantWorkspaceResponseSafe(data);
  res.json({ data });
});

merchantWorkspaceRouter.get("/customers", async (req, res) => {
  const merchantId = await requireMerchantWorkspace(req);
  const data = { customers: await listMerchantCustomers(merchantId) };
  assertMerchantWorkspaceResponseSafe(data);
  res.json({ data });
});

merchantWorkspaceRouter.post("/customers", async (req, res) => {
  const merchantId = await requireMerchantWorkspace(req);
  const customer = await createMerchantCustomer(merchantId, customerSchema.parse(req.body));
  const data = { customer };
  assertMerchantWorkspaceResponseSafe(data);
  res.status(201).json({ data });
});

merchantWorkspaceRouter.patch("/customers/:customerId", async (req, res) => {
  const merchantId = await requireMerchantWorkspace(req);
  const customer = await updateMerchantCustomer(merchantId, req.params.customerId, customerPatchSchema.parse(req.body));
  const data = { customer };
  assertMerchantWorkspaceResponseSafe(data);
  res.json({ data });
});
