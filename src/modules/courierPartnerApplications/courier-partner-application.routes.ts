import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import {
  convertCourierPartnerApplication,
  createCourierPartnerApplication,
  listCourierPartnerApplications
} from "./courier-partner-application.service.js";

export const courierPartnerApplicationRouter = Router();
export const adminCourierPartnerApplicationRouter = Router();

const publicApplicationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false
});

const operationalStatesSchema = z.preprocess((value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split(/[,\n\r\t]+/);
  return value;
}, z.array(z.string().trim().min(1).max(80)).min(1).max(40));

const applicationSchema = z.object({
  companyName: z.string().trim().min(2).max(180),
  contactName: z.string().trim().min(2).max(160),
  phone: z.string().trim().min(7).max(30),
  email: z.string().trim().email().max(220),
  website: z.string().trim().url().max(400).optional().or(z.literal("")),
  gstin: z.string().trim().min(1).max(15),
  registeredState: z.string().trim().min(2).max(80),
  registeredCity: z.string().trim().min(2).max(80),
  operationalStates: operationalStatesSchema,
  serviceablePincodesEstimate: z.string().trim().min(1).max(120),
  codSupported: z.boolean(),
  apiAvailable: z.boolean(),
  notes: z.string().trim().max(2000).optional().or(z.literal(""))
});

const convertSchema = z.object({
  code: z.string().trim().min(2).max(40).optional().or(z.literal(""))
});

courierPartnerApplicationRouter.post("/", publicApplicationLimiter, async (req, res) => {
  const body = applicationSchema.parse(req.body);
  const result = await createCourierPartnerApplication({
    ...body,
    website: body.website || null,
    notes: body.notes || null
  });

  res.status(201).json(result);
});

adminCourierPartnerApplicationRouter.get("/", async (_req, res) => {
  res.json(await listCourierPartnerApplications());
});

adminCourierPartnerApplicationRouter.post("/:id/convert", async (req, res) => {
  const body = convertSchema.parse(req.body);
  const result = await convertCourierPartnerApplication({
    applicationId: req.params.id,
    actorId: req.auth?.userId,
    code: body.code || undefined
  });

  res.status(201).json(result);
});
