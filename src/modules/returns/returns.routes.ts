import { Router, type Response } from "express";
import { getReturnsActionCenter } from "./returns.service.js";

export const returnsRouter = Router();

function sendNoStoreJson(res: Response, body: unknown) {
  res.set({
    "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0"
  });
  res.json(body);
}

returnsRouter.get("/action-center", async (req, res) => {
  const actionCenter = await getReturnsActionCenter(req.auth!.merchantId);
  sendNoStoreJson(res, actionCenter);
});

returnsRouter.get("/summary", async (req, res) => {
  const actionCenter = await getReturnsActionCenter(req.auth!.merchantId);
  sendNoStoreJson(res, actionCenter.summary);
});

returnsRouter.get("/", async (req, res) => {
  const actionCenter = await getReturnsActionCenter(req.auth!.merchantId);
  sendNoStoreJson(res, actionCenter.requests);
});
