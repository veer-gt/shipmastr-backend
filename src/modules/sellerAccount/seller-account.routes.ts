import { Router } from "express";
import { buildSellerAccountCommandCenter } from "./seller-account-command-center.service.js";

export const sellerAccountRouter = Router();

sellerAccountRouter.get("/command-center", async (req, res) => {
  const commandCenter = await buildSellerAccountCommandCenter(req.auth!.merchantId);
  res.json({ data: commandCenter });
});
