import { Router } from "express";
import { env } from "../../config/env.js";
import { readH2BRawBody } from "./h2b-raw-body.js";
import { admitH2BWebhook } from "./h2b-admission.service.js";
import { providerFromPlatform } from "./h2b.types.js";
import { resolveH2BEndpoint } from "./h2b-endpoint.service.js";
import { allowH2BRequest } from "./h2b-rate-limit.js";

export const h2bPublicRouter = Router();

function routeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function limitForPlatform(platform: "SHOPIFY" | "WOOCOMMERCE" | "MAGENTO") {
  if (platform === "SHOPIFY") return env.H2B_SHOPIFY_BODY_LIMIT_BYTES;
  if (platform === "WOOCOMMERCE") return env.H2B_WOOCOMMERCE_BODY_LIMIT_BYTES;
  return env.H2B_MAGENTO_BODY_LIMIT_BYTES;
}

h2bPublicRouter.post("/:opaqueConnectionEndpoint", async (req, res) => {
  const endpointToken = routeParam(req.params.opaqueConnectionEndpoint);
  const sourceAddress = req.socket.remoteAddress ?? "unknown";
  if (!allowH2BRequest(null, sourceAddress)) return res.status(429).json({ error: "H2B_RATE_LIMITED" });
  const endpoint = await resolveH2BEndpoint(endpointToken);
  if (!allowH2BRequest(endpoint.safeFingerprint, sourceAddress)) return res.status(429).json({ error: "H2B_RATE_LIMITED" });
  const provider = providerFromPlatform(endpoint.platform);
  // Endpoint lookup is routing-only. The body reader rejects declared
  // oversize requests before attaching data listeners, then independently
  // enforces the provider-specific cap for chunked or misleading lengths.
  const rawBody = await readH2BRawBody(req, limitForPlatform(provider));
  const result = await admitH2BWebhook({ endpointToken, headers: req.headers, rawBody });
  if (result.status === "IGNORED") return res.status(202).json({ status: "IGNORED", provider: result.provider, topic: result.topic });
  return res.status(result.status === "DUPLICATE" ? 200 : 202).json({
    status: result.status,
    duplicate: result.duplicate,
    provider: result.provider,
    topic: result.topic,
    endpointFingerprint: result.safeEndpointFingerprint
  });
});
