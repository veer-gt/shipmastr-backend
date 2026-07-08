import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { HttpError } from "../../lib/httpError.js";
import {
  addAdminStorefrontDomain,
  assertAdminStorefrontDomainStatus,
  createAdminStorefront,
  findOrCreateMerchantStorefront,
  getAdminStorefront,
  getMerchantStorefront,
  getStorefrontByDomain,
  listAdminStorefrontDomainEvents,
  listAdminStorefrontDomains,
  listAdminStorefronts,
  updateAdminStorefrontDomainStatus,
  updateAdminStorefrontSettings,
  updateMerchantStorefrontSettings,
  type StorefrontLookupClient
} from "./storefronts.service.js";
import { confirmStorefrontAsset, createStorefrontAssetUploadUrl } from "./storefront-assets.service.js";
import { STOREFRONT_PRESET_VARIANTS, STOREFRONT_PRESETS, resolveStorefrontPresetTheme } from "./storefront-presets.js";

export const storefrontsRouter = Router();
export const publicStorefrontsRouter = Router();
export const adminStorefrontsRouter = Router();
export const merchantStorefrontsRouter = Router();
export const merchantStorefrontAssetsRouter = Router();

function sendNoStoreJson(res: Response, body: unknown, status = 200) {
  res.set({
    "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0"
  });
  res.status(status).json(body);
}

// SF1: themeJson may only ever reference an asset by id (imageAssetId) — never bytes,
// never a data: URL. The server resolves imageAssetId -> the real CDN url at save time
// (see storefronts.service.ts assertReadyStorefrontAssetOwnedByMerchant / resolveThemeImageUrls)
// after checking the asset is READY and owned by this merchant. The client cannot supply
// imageUrl directly at all, closing off arbitrary external image URLs too.
const assetIdSchema = z.string().trim().min(1).max(80);

const productSchema = z.object({
  // Stable, client-generated catalog key — lets repeat saves upsert the same
  // StorefrontProduct row (see resolveThemeJsonAssetReferences /
  // syncThemeJsonProductsToCatalog in storefronts.service.ts) instead of creating a new
  // one every save, and is what SF5's server-authoritative checkout quote endpoint keys
  // its price lookup on.
  id: z.string().trim().min(1).max(80).optional(),
  name: z.string().trim().min(1).max(160),
  price: z.string().trim().max(40).optional(),
  description: z.string().trim().max(400).optional(),
  imageAssetId: assetIdSchema.optional()
}).strict();

const themeJsonSchema = z.object({
  primaryColor: z.string().trim().min(1).max(80),
  backgroundColor: z.string().trim().min(1).max(80),
  textColor: z.string().trim().min(1).max(80),
  fontFamily: z.string().trim().min(1).max(200),
  heroTitle: z.string().trim().min(1).max(220),
  heroSubtitle: z.string().trim().min(1).max(500),
  ctaLabel: z.string().trim().min(1).max(80),
  logoAssetId: assetIdSchema.optional(),
  heroImageAssetId: assetIdSchema.optional(),
  templateStyle: z.string().trim().min(1).max(80).optional(),
  // SF5 Layer 1: closed enum, no URL field alongside it — the only purchase action a
  // storefront theme can ever express. Any other value is rejected at the schema level.
  ctaAction: z.literal("shipmastr_checkout").optional(),
  // SF4: closed enum — the 2 real hero layout archetypes extracted from the 75 preset
  // landing pages (see storefront-presets.ts).
  heroLayout: z.enum(["hero-center", "hero-split"]).optional(),
  presetId: z.string().trim().min(1).max(80).optional(),
  presetVersion: z.number().int().positive().optional(),
  products: z.array(productSchema).max(5).optional()
}).strict();

const createStorefrontSchema = z.object({
  merchantId: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(160),
  themeJson: themeJsonSchema
}).strict();

const settingsSchema = z.object({
  themeJson: themeJsonSchema
}).strict();

const merchantCreateStorefrontSchema = z.object({
  name: z.string().trim().min(1).max(160),
  themeJson: themeJsonSchema
}).strict();

const merchantSettingsSchema = settingsSchema;

const addDomainSchema = z.object({
  domain: z.string().trim().min(1).max(253),
  isPrimary: z.boolean().optional()
}).strict();

const statusUpdateSchema = z.object({
  status: z.string().trim().transform((value) => assertAdminStorefrontDomainStatus(value)),
  failureReason: z.string().trim().min(1).max(500).optional()
}).strict();

const assetUploadUrlSchema = z.object({
  contentType: z.enum(["image/webp", "image/jpeg", "image/png"])
}).strict();

export function createStorefrontLookupHandler(client?: StorefrontLookupClient) {
  return async function lookupInternalStorefront(req: Request, res: Response) {
    try {
      const domain = Array.isArray(req.params.domain) ? "" : req.params.domain || "";
      const storefront = await getStorefrontByDomain(domain, client);

      if (!storefront) {
        return res.status(404).json({
          error: "STOREFRONT_NOT_FOUND"
        });
      }

      return res.json(storefront);
    } catch (error) {
      if (error instanceof HttpError) {
        return res.status(error.status).json({
          error: error.message
        });
      }

      throw error;
    }
  };
}

export function createPublicStorefrontLookupHandler(client?: StorefrontLookupClient) {
  return async function lookupPublicStorefront(req: Request, res: Response) {
    try {
      const domain = typeof req.query.domain === "string" ? req.query.domain : "";
      const storefront = await getStorefrontByDomain(domain, client);

      if (!storefront) {
        return res.status(404).json({
          status: "NOT_FOUND",
          error: "STOREFRONT_NOT_FOUND"
        });
      }

      return res.json({
        domain: storefront.domain,
        merchantId: storefront.merchantId,
        storeName: storefront.storeName,
        status: storefront.status,
        themeJson: storefront.themeJson
      });
    } catch (error) {
      if (error instanceof HttpError) {
        return res.status(error.status).json({
          error: error.message
        });
      }

      throw error;
    }
  };
}

export const lookupInternalStorefront = createStorefrontLookupHandler();
export const lookupPublicStorefront = createPublicStorefrontLookupHandler();

storefrontsRouter.get("/:domain", lookupInternalStorefront);
publicStorefrontsRouter.get("/lookup", lookupPublicStorefront);

// SF4 — public preset registry + resolved-theme preview. The gallery (seller-panel)
// lists these; the storefront-renderer's /preview/[presetId] route resolves one and
// renders it through the exact same StorefrontShell component real storefronts use —
// "preview and production same code path" per the hardening spec, never a second,
// divergent rendering path or raw HTML file.
publicStorefrontsRouter.get("/presets", (_req, res) => {
  sendNoStoreJson(res, {
    variants: STOREFRONT_PRESET_VARIANTS,
    presets: STOREFRONT_PRESETS.map((preset) => ({
      presetId: preset.presetId,
      presetVersion: preset.presetVersion,
      label: preset.label,
      variant: preset.variant,
      heroLayout: preset.heroLayout,
      palette: preset.palette,
      tags: preset.tags
    }))
  });
});

publicStorefrontsRouter.get("/presets/:id", (req, res) => {
  const theme = resolveStorefrontPresetTheme(req.params.id);
  if (!theme) {
    return res.status(404).json({ error: "STOREFRONT_PRESET_NOT_FOUND" });
  }
  return sendNoStoreJson(res, { theme });
});

adminStorefrontsRouter.get("/", async (req, res) => {
  const result = await listAdminStorefronts();
  sendNoStoreJson(res, result);
});

adminStorefrontsRouter.post("/", async (req, res) => {
  const body = createStorefrontSchema.parse(req.body);
  const result = await createAdminStorefront(body);
  sendNoStoreJson(res, result, 201);
});

adminStorefrontsRouter.get("/:id", async (req, res) => {
  const result = await getAdminStorefront({ id: req.params.id });
  sendNoStoreJson(res, result);
});

adminStorefrontsRouter.get("/:id/domains", async (req, res) => {
  const result = await listAdminStorefrontDomains({ id: req.params.id });
  sendNoStoreJson(res, result);
});

adminStorefrontsRouter.patch("/:id/settings", async (req, res) => {
  const body = settingsSchema.parse(req.body);
  const result = await updateAdminStorefrontSettings({
    id: req.params.id,
    themeJson: body.themeJson
  });
  sendNoStoreJson(res, result);
});

adminStorefrontsRouter.post("/:id/domains", async (req, res) => {
  const body = addDomainSchema.parse(req.body);
  const result = await addAdminStorefrontDomain({
    id: req.params.id,
    domain: body.domain,
    isPrimary: body.isPrimary
  });
  sendNoStoreJson(res, result, 201);
});

adminStorefrontsRouter.get("/:id/domains/:domainId/events", async (req, res) => {
  const result = await listAdminStorefrontDomainEvents({
    id: req.params.id,
    domainId: req.params.domainId
  });
  sendNoStoreJson(res, result);
});

adminStorefrontsRouter.patch("/:id/domains/:domainId/status", async (req, res) => {
  const body = statusUpdateSchema.parse(req.body);
  const result = await updateAdminStorefrontDomainStatus({
    id: req.params.id,
    domainId: req.params.domainId,
    status: body.status,
    failureReason: body.failureReason
  });
  sendNoStoreJson(res, result);
});

// Merchant self-service — merchantId is always derived from the authenticated JWT (req.auth.merchantId),
// never accepted from the request body, matching the pattern already used by merchantDomainsRouter.
// A merchant can only ever see or touch their own storefront through these routes.

merchantStorefrontsRouter.get("/", async (req, res) => {
  const result = await getMerchantStorefront({
    merchantId: req.auth!.merchantId
  });
  sendNoStoreJson(res, result);
});

merchantStorefrontsRouter.post("/", async (req, res) => {
  const body = merchantCreateStorefrontSchema.parse(req.body);
  const result = await findOrCreateMerchantStorefront({
    merchantId: req.auth!.merchantId,
    name: body.name,
    themeJson: body.themeJson
  });
  sendNoStoreJson(res, result, 201);
});

merchantStorefrontsRouter.patch("/settings", async (req, res) => {
  const body = merchantSettingsSchema.parse(req.body);
  const result = await updateMerchantStorefrontSettings({
    merchantId: req.auth!.merchantId,
    themeJson: body.themeJson
  });
  sendNoStoreJson(res, result);
});

// SF1a — signed-URL asset upload flow. The API never receives image bytes: the client
// PUTs directly to GCS, then confirms so the server can verify size/type against the
// real object (never the client's claim) before the asset becomes referenceable.

merchantStorefrontAssetsRouter.post("/upload-url", async (req, res) => {
  const body = assetUploadUrlSchema.parse(req.body);
  const result = await createStorefrontAssetUploadUrl({
    merchantId: req.auth!.merchantId,
    contentType: body.contentType
  });
  sendNoStoreJson(res, result, 201);
});

merchantStorefrontAssetsRouter.post("/:id/confirm", async (req, res) => {
  const result = await confirmStorefrontAsset({
    merchantId: req.auth!.merchantId,
    assetId: req.params.id
  });
  sendNoStoreJson(res, result);
});
