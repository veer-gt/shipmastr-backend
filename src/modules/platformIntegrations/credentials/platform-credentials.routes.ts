import { Router } from "express";
import { successEnvelope } from "../../shippingNetwork/shipping-public-serializers.js";
import {
  attachCredentialToConnection,
  createPlatformCredential,
  detachCredentialFromConnection,
  getPlatformCredential,
  listPlatformCredentials,
  revokePlatformCredential,
  rotatePlatformCredential,
  validateCredentialShapeForResponse
} from "./platform-credentials.service.js";
import {
  createPlatformCredentialSchema,
  listPlatformCredentialsQuerySchema,
  rotatePlatformCredentialSchema,
  validateCredentialShapeSchema
} from "./platform-credentials.validation.js";
import {
  getConnectionCredentialStatus,
  revokeConnectionCredential,
  rotateConnectionCredential,
  testConnectionCredentialReadiness,
  upsertConnectionCredential
} from "../../credentialVault/credential-vault.service.js";
import {
  rotateConnectionCredentialSchema,
  testConnectionCredentialReadinessSchema,
  upsertConnectionCredentialSchema
} from "../../credentialVault/credential-vault.validation.js";

export const platformCredentialsRouter = Router();

function routeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

platformCredentialsRouter.post("/platform-credentials", async (req, res) => {
  const body = createPlatformCredentialSchema.parse(req.body);
  const data = await createPlatformCredential(req.auth!.merchantId, body);
  return res.status(201).json(successEnvelope("Platform credential stored successfully.", data));
});

platformCredentialsRouter.get("/platform-credentials", async (req, res) => {
  const query = listPlatformCredentialsQuerySchema.parse(req.query);
  const data = await listPlatformCredentials(req.auth!.merchantId, query);
  return res.json(successEnvelope("Platform credentials fetched successfully.", data));
});

platformCredentialsRouter.get("/platform-credentials/:credentialId", async (req, res) => {
  const data = await getPlatformCredential(req.auth!.merchantId, routeParam(req.params.credentialId));
  return res.json(successEnvelope("Platform credential fetched successfully.", data));
});

platformCredentialsRouter.put("/platform-credentials/:credentialId/rotate", async (req, res) => {
  const body = rotatePlatformCredentialSchema.parse(req.body);
  const data = await rotatePlatformCredential(req.auth!.merchantId, routeParam(req.params.credentialId), body);
  return res.json(successEnvelope("Platform credential rotated successfully.", data));
});

platformCredentialsRouter.delete("/platform-credentials/:credentialId", async (req, res) => {
  const data = await revokePlatformCredential(req.auth!.merchantId, routeParam(req.params.credentialId));
  return res.json(successEnvelope("Platform credential revoked successfully.", data));
});

platformCredentialsRouter.post("/platform-connections/:connectionId/credentials/:credentialId/attach", async (req, res) => {
  const data = await attachCredentialToConnection(
    req.auth!.merchantId,
    routeParam(req.params.connectionId),
    routeParam(req.params.credentialId)
  );
  return res.json(successEnvelope("Platform credential attached successfully.", data));
});

platformCredentialsRouter.post("/platform-connections/:connectionId/credentials", async (req, res) => {
  const body = upsertConnectionCredentialSchema.parse(req.body);
  const data = await upsertConnectionCredential(req.auth!.merchantId, routeParam(req.params.connectionId), body);
  return res.status(201).json(successEnvelope("Platform connection credential stored safely.", data));
});

platformCredentialsRouter.get("/platform-connections/:connectionId/credentials/status", async (req, res) => {
  const data = await getConnectionCredentialStatus(req.auth!.merchantId, routeParam(req.params.connectionId));
  return res.json(successEnvelope("Platform connection credential status fetched safely.", data));
});

platformCredentialsRouter.post("/platform-connections/:connectionId/credentials/rotate", async (req, res) => {
  const body = rotateConnectionCredentialSchema.parse(req.body);
  const data = await rotateConnectionCredential(req.auth!.merchantId, routeParam(req.params.connectionId), body);
  return res.json(successEnvelope("Platform connection credential rotated safely.", data));
});

platformCredentialsRouter.post("/platform-connections/:connectionId/credentials/revoke", async (req, res) => {
  const data = await revokeConnectionCredential(req.auth!.merchantId, routeParam(req.params.connectionId));
  return res.json(successEnvelope("Platform connection credential revoked safely.", data));
});

platformCredentialsRouter.post("/platform-connections/:connectionId/credentials/test-readiness", async (req, res) => {
  testConnectionCredentialReadinessSchema.parse(req.body ?? {});
  const data = await testConnectionCredentialReadiness(req.auth!.merchantId, routeParam(req.params.connectionId));
  return res.json(successEnvelope("Platform connection credential readiness tested safely.", data));
});

platformCredentialsRouter.delete("/platform-connections/:connectionId/credentials", async (req, res) => {
  const data = await detachCredentialFromConnection(req.auth!.merchantId, routeParam(req.params.connectionId));
  return res.json(successEnvelope("Platform credential detached successfully.", data));
});

platformCredentialsRouter.post("/platform-credentials/validate-foundation", async (req, res) => {
  const body = validateCredentialShapeSchema.parse(req.body);
  const data = validateCredentialShapeForResponse(body);
  return res.json(successEnvelope("Platform credential shape validated successfully.", data));
});
