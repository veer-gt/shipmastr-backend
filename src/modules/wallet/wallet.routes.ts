import { Router } from "express";
import { z } from "zod";
import {
  getBalance,
  getOrCreateWalletForSellerOrMerchant,
  listLedgerEntries,
  listMerchantWallets,
  reconcileBalance
} from "./wallet.service.js";
import { serializeWalletBalance, serializeWalletLedgerEntry } from "./wallet.serializer.js";
import { walletDirections, walletStatuses } from "./wallet.types.js";

export const walletRouter = Router();
export const adminWalletRouter = Router();

const ledgerQuerySchema = z.object({
  direction: z.enum(walletDirections).optional(),
  status: z.enum(walletStatuses).optional(),
  entryType: z.string().min(1).max(80).optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).optional()
}).refine((query) => !query.dateFrom || !query.dateTo || query.dateFrom <= query.dateTo, {
  message: "dateFrom must be before dateTo",
  path: ["dateTo"]
});

const adminListQuerySchema = z.object({
  search: z.string().trim().min(1).max(80).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional()
});

const reconcileQuerySchema = z.object({
  cachedBalance: z.coerce.number().finite().optional(),
  cachedBalanceSource: z.string().trim().min(1).max(80).optional()
});

function serializeLedgerPage(page: Awaited<ReturnType<typeof listLedgerEntries>>) {
  return {
    entries: page.entries.map(serializeWalletLedgerEntry),
    limit: page.limit,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor
  };
}

walletRouter.get("/", async (req, res) => {
  const merchantId = req.auth!.merchantId;
  const [{ wallet, merchant }, balance] = await Promise.all([
    getOrCreateWalletForSellerOrMerchant(merchantId),
    getBalance(merchantId)
  ]);

  res.json({
    wallet: {
      ...wallet,
      ownerName: merchant.name
    },
    balance: serializeWalletBalance(balance)
  });
});

walletRouter.get("/ledger", async (req, res) => {
  const query = ledgerQuerySchema.parse(req.query);
  const page = await listLedgerEntries(req.auth!.merchantId, query);

  res.json(serializeLedgerPage(page));
});

walletRouter.get("/reconcile", async (req, res) => {
  const query = reconcileQuerySchema.parse(req.query);
  const result = await reconcileBalance(req.auth!.merchantId, undefined, {
    legacyCachedBalance: query.cachedBalance,
    legacyCachedBalanceSource: query.cachedBalanceSource
  });

  res.json({
    ...result,
    balance: serializeWalletBalance(result.balance)
  });
});

adminWalletRouter.get("/", async (req, res) => {
  const query = adminListQuerySchema.parse(req.query);
  const result = await listMerchantWallets(query);

  res.json({
    wallets: result.wallets.map((row) => ({
      merchant: row.merchant,
      balance: serializeWalletBalance(row.balance)
    })),
    limit: result.limit
  });
});

adminWalletRouter.get("/:merchantId", async (req, res) => {
  const merchantId = z.string().min(1).parse(req.params.merchantId);
  const [{ wallet, merchant }, balance] = await Promise.all([
    getOrCreateWalletForSellerOrMerchant(merchantId),
    getBalance(merchantId)
  ]);

  res.json({
    wallet: {
      ...wallet,
      ownerName: merchant.name
    },
    merchant,
    balance: serializeWalletBalance(balance)
  });
});

adminWalletRouter.get("/:merchantId/ledger", async (req, res) => {
  const merchantId = z.string().min(1).parse(req.params.merchantId);
  const query = ledgerQuerySchema.parse(req.query);
  const page = await listLedgerEntries(merchantId, query);

  res.json(serializeLedgerPage(page));
});
