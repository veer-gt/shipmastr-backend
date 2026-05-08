import { LeadStatus } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../../lib/httpError.js";
import { createLead } from "./lead.service.js";

export const leadsRouter = Router();

const createLeadSchema = z.object({
  name: z.string().trim().min(2).max(120),
  businessName: z.string().trim().min(2).max(160),
  phone: z.string().trim().min(7).max(24),
  email: z.string().trim().email().max(180),
  monthlyShipments: z.union([z.string(), z.number()]).optional(),
  currentProvider: z.string().trim().max(120).optional().or(z.literal("")),
  biggestIssue: z.string().trim().max(240).optional().or(z.literal("")),
  notes: z.string().trim().max(1200).optional().or(z.literal(""))
});

const normalizeOptionalText = (value: unknown) => {
  if (value === undefined || value === null) return undefined;
  const next = String(value).trim();
  return next ? next : undefined;
};

leadsRouter.post("/", async (req, res) => {
  const body = createLeadSchema.parse(req.body);
  const input = {
    name: body.name,
    businessName: body.businessName,
    phone: body.phone,
    email: body.email
  };

  const monthlyShipments = normalizeOptionalText(body.monthlyShipments);
  const currentProvider = normalizeOptionalText(body.currentProvider);
  const biggestIssue = normalizeOptionalText(body.biggestIssue);
  const notes = normalizeOptionalText(body.notes);

  const result = await createLead({
    ...input,
    ...(monthlyShipments ? { monthlyShipments } : {}),
    ...(currentProvider ? { currentProvider } : {}),
    ...(biggestIssue ? { biggestIssue } : {}),
    ...(notes ? { notes } : {})
  });

  res.status(201).json(result);
});

export function parseLeadStatus(value: unknown) {
  if (!value) return undefined;
  const status = String(value).trim().toUpperCase();
  if (!(status in LeadStatus)) {
    throw new HttpError(400, "INVALID_LEAD_STATUS");
  }
  return LeadStatus[status as keyof typeof LeadStatus];
}
