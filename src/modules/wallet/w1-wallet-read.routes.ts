import { Router } from "express";
import { z } from "zod";
import {
  walletStatementService,
  w1WalletReadinessService
} from "./w1-closed-loop-wallet.service.js";

export const internalW1WalletRouter = Router();
export const adminW1WalletRouter = Router();
export const sellerW1WalletRouter = Router();

const sellerOrgIdSchema = z.string().trim().min(1).max(120);
const statementQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional()
});

export function sellerOrgIdFromAuth(auth: Express.Request["auth"]) {
  return sellerOrgIdSchema.parse(auth?.merchantId);
}

internalW1WalletRouter.get("/readiness", async (_req, res) => {
  res.json(w1WalletReadinessService.checkReadiness());
});

adminW1WalletRouter.get("/:sellerOrgId/summary", async (req, res) => {
  const sellerOrgId = sellerOrgIdSchema.parse(req.params.sellerOrgId);
  res.json(await walletStatementService.getWalletSummary(sellerOrgId));
});

adminW1WalletRouter.get("/:sellerOrgId/statement", async (req, res) => {
  const sellerOrgId = sellerOrgIdSchema.parse(req.params.sellerOrgId);
  const query = statementQuerySchema.parse(req.query);
  res.json(await walletStatementService.getWalletStatement(sellerOrgId, query));
});

sellerW1WalletRouter.get("/summary", async (req, res) => {
  walletStatementService.assertSellerReadAllowed();
  const sellerOrgId = sellerOrgIdFromAuth(req.auth);
  res.json(await walletStatementService.getWalletSummary(sellerOrgId));
});

sellerW1WalletRouter.get("/statement", async (req, res) => {
  walletStatementService.assertSellerReadAllowed();
  const sellerOrgId = sellerOrgIdFromAuth(req.auth);
  const query = statementQuerySchema.parse(req.query);
  res.json(await walletStatementService.getWalletStatement(sellerOrgId, query));
});
