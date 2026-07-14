import { Router } from "express";
import { requireMasterAdminJwt } from "../../middleware/jwtAuth.js";
import { HttpError } from "../../lib/httpError.js";
import { createH2AStagingTenant, cleanupH2AStagingTenant, getH2AStagingTenant } from "./h2a-staging-tenant.service.js";
import { h2aCleanupSchema, h2aCreateSchema, isH2ALifecycleHeader } from "./h2a-staging-tenant.validation.js";

export const h2aStagingTenantRouter = Router();

function requireFixtureHeader(req: { header(name: string): string | undefined }) {
  if (!isH2ALifecycleHeader(req.header("X-Shipmastr-Security-Fixture"))) throw new HttpError(404, "NOT_FOUND");
}

h2aStagingTenantRouter.use(requireMasterAdminJwt, (req, _res, next) => {
  requireFixtureHeader(req);
  next();
});

h2aStagingTenantRouter.post("/", async (req, res) => {
  const input = h2aCreateSchema.parse(req.body);
  res.status(201).json(await createH2AStagingTenant(input, req.auth!.userId));
});

h2aStagingTenantRouter.get("/:fixtureId", async (req, res) => {
  res.json(await getH2AStagingTenant(req.params.fixtureId));
});

h2aStagingTenantRouter.post("/:fixtureId/cleanup", async (req, res) => {
  h2aCleanupSchema.parse(req.body);
  res.json(await cleanupH2AStagingTenant(req.params.fixtureId));
});
