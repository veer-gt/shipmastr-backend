import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import {
  commitCourierInvoiceUpload,
  previewCourierInvoiceUpload
} from "../imports/import-file.service.js";
import { importCourierInvoice } from "./courier-invoice.service.js";

export const courierInvoicesRouter = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const invoiceLineSchema = z.object({
  awb: z.string().min(1).optional(),
  orderId: z.string().min(1).optional(),
  externalOrderId: z.string().min(1).optional(),
  chargedWeightGrams: z.number().int().positive().optional(),
  billedWeightGrams: z.number().int().positive().optional(),
  zone: z.string().min(1).optional(),
  forwardFreight: z.number().nonnegative().optional(),
  rtoFreight: z.number().nonnegative().optional(),
  codFee: z.number().nonnegative().optional(),
  otherCharges: z.number().optional(),
  gstAmount: z.number().nonnegative().optional(),
  totalCharge: z.number().nonnegative(),
  rawPayload: z.any().optional()
});

courierInvoicesRouter.post("/import", async (req, res) => {
  const body = z.object({
    courierId: z.string().min(1),
    invoiceNumber: z.string().min(1).optional(),
    periodStart: z.coerce.date(),
    periodEnd: z.coerce.date(),
    lines: z.array(invoiceLineSchema).min(1)
  }).parse(req.body);
  const invoice = await importCourierInvoice({
    merchantId: req.auth!.merchantId,
    courierId: body.courierId,
    invoiceNumber: body.invoiceNumber,
    periodStart: body.periodStart,
    periodEnd: body.periodEnd,
    lines: body.lines
  });

  res.status(201).json({ invoice });
});

courierInvoicesRouter.post("/preview-upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "FILE_REQUIRED" });
    return;
  }

  const body = z.object({
    courierId: z.string().min(1),
    invoiceNumber: z.string().min(1).optional(),
    periodStart: z.coerce.date(),
    periodEnd: z.coerce.date()
  }).parse(req.body);
  const preview = await previewCourierInvoiceUpload({
    merchantId: req.auth!.merchantId,
    courierId: body.courierId,
    invoiceNumber: body.invoiceNumber,
    periodStart: body.periodStart,
    periodEnd: body.periodEnd,
    fileName: req.file.originalname,
    mimeType: req.file.mimetype,
    buffer: req.file.buffer
  });

  res.status(201).json(preview);
});

courierInvoicesRouter.post("/commit-upload", async (req, res) => {
  const body = z.object({
    importFileId: z.string().min(1),
    triggerReconciliation: z.boolean().default(false)
  }).parse(req.body);
  const result = await commitCourierInvoiceUpload({
    merchantId: req.auth!.merchantId,
    importFileId: body.importFileId,
    triggerReconciliation: body.triggerReconciliation
  });

  res.json(result);
});
