import {
  CourierPartnerOnboardingStatus,
  CourierSandboxVerificationStatus
} from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../../lib/httpError.js";
import {
  createAdminCourierPartner,
  getAdminCourierPartner,
  getCourierOnboarding,
  listAdminCourierPartners,
  requestCourierOnboardingChange,
  reopenAdminCourierPartner,
  saveCourierOnboardingDraft,
  setAdminCourierPartnerStatus,
  submitCourierOnboarding,
  updateCourierSandboxVerificationItem
} from "./onboarding.service.js";

export const adminCourierPartnerRouter = Router();
export const courierOnboardingRouter = Router();

const jsonSectionSchema = z.object({}).passthrough();

const credentialEnvironmentSchema = z.object({
  apiKey: z.string().optional(),
  token: z.string().optional(),
  clientSecret: z.string().optional(),
  password: z.string().optional(),
  webhookSecret: z.string().optional()
}).partial();

const onboardingPatchSchema = z.object({
  companyLegal: jsonSectionSchema.optional(),
  commercial: jsonSectionSchema.optional(),
  serviceability: jsonSectionSchema.optional(),
  codRemittance: jsonSectionSchema.optional(),
  api: jsonSectionSchema.optional(),
  webhookSecurity: jsonSectionSchema.optional(),
  escalation: jsonSectionSchema.optional(),
  credentials: z.object({
    sandbox: credentialEnvironmentSchema.optional(),
    prod: credentialEnvironmentSchema.optional()
  }).optional()
}).refine((body) => Object.keys(body).length > 0, {
  message: "At least one onboarding field is required"
});

const createPartnerSchema = z.object({
  name: z.string().trim().min(2),
  code: z.string().trim().min(2),
  contactName: z.string().trim().min(2),
  contactEmail: z.string().trim().email(),
  legalName: z.string().trim().optional().or(z.literal("")),
  gstin: z.string().trim().max(15).optional().or(z.literal("")),
  gstNumber: z.string().trim().optional().or(z.literal("")),
  serviceCodeType: z.literal("SAC").optional(),
  serviceCode: z.enum(["996811", "996812", "996813", "996819"]).optional(),
  serviceDescription: z.string().trim().optional().or(z.literal("")),
  gstRate: z.coerce.number().optional(),
  address: z.string().trim().optional().or(z.literal("")),
  accountManager: z.string().trim().optional().or(z.literal(""))
});

const approvableStatuses: CourierPartnerOnboardingStatus[] = [
  CourierPartnerOnboardingStatus.IN_REVIEW,
  CourierPartnerOnboardingStatus.SANDBOX_TESTING,
  CourierPartnerOnboardingStatus.PROD_READY,
  CourierPartnerOnboardingStatus.LIVE
];

const approveStatusSchema = z.object({
  status: z.nativeEnum(CourierPartnerOnboardingStatus)
    .default(CourierPartnerOnboardingStatus.SANDBOX_TESTING),
  note: z.string().trim().max(1500).optional().or(z.literal(""))
}).refine((body) => approvableStatuses.includes(body.status), {
  path: ["status"],
  message: "status must be IN_REVIEW, SANDBOX_TESTING, PROD_READY, or LIVE"
});

const noteSchema = z.object({
  reason: z.string().trim().min(2).max(1500).optional(),
  note: z.string().trim().min(2).max(1500).optional()
}).refine((body) => body.reason || body.note, {
  path: ["reason"],
  message: "reason is required"
});

const optionalTextSchema = (maxLength: number) => z.union([
  z.string().trim().max(maxLength),
  z.null()
]).optional();

const verificationItemPatchSchema = z.object({
  status: z.nativeEnum(CourierSandboxVerificationStatus).optional(),
  owner: optionalTextSchema(160),
  notes: optionalTextSchema(4000),
  evidenceUrl: optionalTextSchema(2000)
}).refine((body) => Object.values(body).some((value) => value !== undefined), {
  message: "At least one checklist field is required"
});

function courierIdFromRequest(req: import("express").Request) {
  const courierId = req.auth?.courierId;
  if (!courierId) throw new HttpError(401, "COURIER_TOKEN_REQUIRED");
  return courierId;
}

adminCourierPartnerRouter.get("/", async (_req, res) => {
  res.json(await listAdminCourierPartners());
});

adminCourierPartnerRouter.post("/", async (req, res) => {
  const body = createPartnerSchema.parse(req.body);
  res.status(201).json(await createAdminCourierPartner({
    ...body,
    actorId: req.auth?.userId
  }));
});

adminCourierPartnerRouter.get("/:id", async (req, res) => {
  res.json(await getAdminCourierPartner(req.params.id));
});

adminCourierPartnerRouter.patch("/:id/verification-checklist/:itemKey", async (req, res) => {
  const body = verificationItemPatchSchema.parse(req.body);
  res.json(await updateCourierSandboxVerificationItem({
    courierIdOrOnboardingId: req.params.id,
    itemKey: req.params.itemKey,
    actorId: req.auth?.userId,
    patch: body
  }));
});

adminCourierPartnerRouter.post("/:id/approve", async (req, res) => {
  const body = approveStatusSchema.parse(req.body);
  res.json(await setAdminCourierPartnerStatus({
    courierIdOrOnboardingId: req.params.id,
    actorId: req.auth?.userId,
    status: body.status,
    note: body.note || undefined
  }));
});

adminCourierPartnerRouter.post("/:id/block", async (req, res) => {
  const body = noteSchema.parse(req.body);
  res.json(await setAdminCourierPartnerStatus({
    courierIdOrOnboardingId: req.params.id,
    actorId: req.auth?.userId,
    status: CourierPartnerOnboardingStatus.BLOCKED,
    note: body.reason || body.note
  }));
});

adminCourierPartnerRouter.post("/:id/reopen", async (req, res) => {
  const body = noteSchema.parse(req.body);
  res.json(await reopenAdminCourierPartner({
    courierIdOrOnboardingId: req.params.id,
    actorId: req.auth?.userId,
    reason: body.reason || body.note!
  }));
});

courierOnboardingRouter.get("/", async (req, res) => {
  res.json(await getCourierOnboarding(courierIdFromRequest(req)));
});

courierOnboardingRouter.patch("/", async (req, res) => {
  const body = onboardingPatchSchema.parse(req.body);
  res.json(await saveCourierOnboardingDraft({
    courierId: courierIdFromRequest(req),
    actorId: req.auth!.userId,
    patch: body
  }));
});

courierOnboardingRouter.post("/submit", async (req, res) => {
  res.json(await submitCourierOnboarding({
    courierId: courierIdFromRequest(req),
    actorId: req.auth!.userId
  }));
});

courierOnboardingRouter.post("/change-request", async (req, res) => {
  const body = noteSchema.parse(req.body);
  res.json(await requestCourierOnboardingChange({
    courierId: courierIdFromRequest(req),
    actorId: req.auth!.userId,
    reason: body.reason || body.note!
  }));
});
