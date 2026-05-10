import { Router } from "express";
import { z } from "zod";
import { getImportFile, listImportFiles } from "./import-file.service.js";

export const importsRouter = Router();

importsRouter.get("/", async (req, res) => {
  const imports = await listImportFiles(req.auth!.merchantId);

  res.json({ imports });
});

importsRouter.get("/:id", async (req, res) => {
  const params = z.object({ id: z.string().min(1) }).parse(req.params);
  const importFile = await getImportFile({
    merchantId: req.auth!.merchantId,
    id: params.id
  });

  res.json(importFile);
});
