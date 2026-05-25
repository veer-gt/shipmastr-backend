import { Router, type Response } from "express";
import { getVasActionCenter } from "./vas.service.js";

export const vasRouter = Router();

function sendNoStoreJson(res: Response, body: unknown) {
  res.set({
    "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0"
  });
  res.json(body);
}

vasRouter.get("/action-center", async (req, res) => {
  const actionCenter = await getVasActionCenter(req.auth!.merchantId);
  sendNoStoreJson(res, actionCenter);
});

vasRouter.get("/products", async (req, res) => {
  const actionCenter = await getVasActionCenter(req.auth!.merchantId);
  sendNoStoreJson(res, actionCenter);
});

vasRouter.get("/", async (req, res) => {
  const actionCenter = await getVasActionCenter(req.auth!.merchantId);
  sendNoStoreJson(res, actionCenter);
});
