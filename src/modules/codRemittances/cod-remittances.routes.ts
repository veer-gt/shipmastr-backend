import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import {
  commitCodRemittanceUpload,
  previewCodRemittanceUpload
} from "../imports/import-file.service.js";
import { importCodRemittances } from "./cod-remittance.service.js";

export const codRemittancesRouter = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: 10 * 1024 * 1024, fields: 8, fieldSize: 64 * 1024, parts: 16 }
});

const remittanceSchema = z.object({
  courierId: z.string().min(1).optional(),
  awb: z.string().min(1).optional(),
  orderId: z.string().min(1).optional(),
  externalOrderId: z.string().min(1).optional(),
  codAmount: z.number().nonnegative().optional(),
  remittedAmount: z.number().nonnegative(),
  remittedAt: z.coerce.date().optional(),
  utr: z.string().min(1).optional(),
  rawPayload: z.any().optional()
});

codRemittancesRouter.post("/import", async (req, res) => {
  const body = z.object({
    remittances: z.array(remittanceSchema).min(1)
  }).parse(req.body);
  const remittances = await importCodRemittances({
    merchantId: req.auth!.merchantId,
    remittances: body.remittances
  });

  res.status(201).json({ remittances });
});

codRemittancesRouter.post("/preview-upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "FILE_REQUIRED" });
    return;
  }

  const body = z.object({
    defaultCourierId: z.string().min(1).optional()
  }).parse(req.body);
  const preview = await previewCodRemittanceUpload({
    merchantId: req.auth!.merchantId,
    defaultCourierId: body.defaultCourierId,
    fileName: req.file.originalname,
    mimeType: req.file.mimetype,
    buffer: req.file.buffer
  });

  res.status(201).json(preview);
});

codRemittancesRouter.post("/commit-upload", async (req, res) => {
  const body = z.object({
    importFileId: z.string().min(1),
    triggerReconciliation: z.boolean().default(false)
  }).parse(req.body);
  const result = await commitCodRemittanceUpload({
    merchantId: req.auth!.merchantId,
    importFileId: body.importFileId,
    triggerReconciliation: body.triggerReconciliation
  });

  res.json(result);
});
