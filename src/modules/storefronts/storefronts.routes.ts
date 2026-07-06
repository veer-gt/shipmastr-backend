import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { HttpError } from "../../lib/httpError.js";
import {
  addAdminStorefrontDomain,
  assertAdminStorefrontDomainStatus,
  createAdminStorefront,
  getAdminStorefront,
  getStorefrontByDomain,
  listAdminStorefrontDomainEvents,
  listAdminStorefrontDomains,
  listAdminStorefronts,
  updateAdminStorefrontDomainStatus,
  updateAdminStorefrontSettings,
  type StorefrontLookupClient
} from "./storefronts.service.js";

export const storefrontsRouter = Router();
export const publicStorefrontsRouter = Router();
export const adminStorefrontsRouter = Router();

function sendNoStoreJson(res: Response, body: unknown, status = 200) {
  res.set({
    "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0"
  });
  res.status(status).json(body);
}

const themeJsonSchema = z.object({
  primaryColor: z.string().trim().min(1).max(80),
  backgroundColor: z.string().trim().min(1).max(80),
  textColor: z.string().trim().min(1).max(80),
  fontFamily: z.string().trim().min(1).max(200),
  heroTitle: z.string().trim().min(1).max(220),
  heroSubtitle: z.string().trim().min(1).max(500),
  ctaLabel: z.string().trim().min(1).max(80),
  logoUrl: z.string().trim().url().max(1000).optional()
}).strict();

const createStorefrontSchema = z.object({
  merchantId: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(160),
  themeJson: themeJsonSchema
}).strict();

const settingsSchema = z.object({
  themeJson: themeJsonSchema
}).strict();

const addDomainSchema = z.object({
  domain: z.string().trim().min(1).max(253),
  isPrimary: z.boolean().optional()
}).strict();

const statusUpdateSchema = z.object({
  status: z.string().trim().transform((value) => assertAdminStorefrontDomainStatus(value)),
  failureReason: z.string().trim().min(1).max(500).optional()
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
