import { Router, type Request, type Response } from "express";
import { env } from "../../config/env.js";
import { readH2BRawBody } from "./h2b-raw-body.js";
import { admitH2BWebhook } from "./h2b-admission.service.js";
import { endpointParts, H2B_ABSOLUTE_BODY_LIMIT_BYTES, H2B_PUBLIC_ROUTE_PREFIX, providerFromPlatform, providerFromHint, type H2BProvider } from "./h2b.types.js";
import { resolveH2BEndpoint } from "./h2b-endpoint.service.js";
import { allowH2BRequest } from "./h2b-rate-limit.js";
import { HttpError } from "../../lib/httpError.js";

export const h2bPublicRouter = Router();

function routeParam(value: string | string[] | undefined) { return Array.isArray(value) ? value[0] ?? "" : value ?? ""; }
function limitForProvider(provider: H2BProvider) {
  if (provider === "SHOPIFY") return env.H2B_SHOPIFY_BODY_LIMIT_BYTES;
  if (provider === "WOOCOMMERCE") return env.H2B_WOOCOMMERCE_BODY_LIMIT_BYTES;
  return env.H2B_MAGENTO_BODY_LIMIT_BYTES;
}
function header(req: Request, name: string) {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}
function boundHeaders(req: Request, provider: H2BProvider) {
  const names = ["x-shopify-topic", "x-shopify-webhook-id", "x-shopify-hmac-sha256", "x-shopify-shop-domain"];
  if (provider === "WOOCOMMERCE") names.push("x-wc-webhook-topic", "x-wc-webhook-id", "x-wc-webhook-signature", "x-wc-webhook-source", "x-wc-webhook-resource", "x-wc-webhook-event");
  if (provider === "MAGENTO") names.push("x-magento-topic", "x-magento-webhook-id", "x-magento-signature", "x-magento-event");
  for (const name of names) if (String(header(req, name)).length > 512) throw new HttpError(400, "H2B_HEADER_TOO_LONG");
}
function safe404(_request: Request, response: Response) { return response.status(404).json({ error: "H2B_ROUTE_NOT_FOUND" }); }

export const h2bTerminalPrefixGuard = safe404;

h2bPublicRouter.post("/:opaqueConnectionEndpoint", async (req, res) => {
  const endpointToken = routeParam(req.params.opaqueConnectionEndpoint);
  const parts = endpointParts(endpointToken);
  if (!parts) return safe404(req, res);
  const sourceAddress = req.socket.remoteAddress ?? "unknown";
  if (!allowH2BRequest(null, sourceAddress, Date.now(), parts.provider)) return res.status(429).json({ error: "H2B_RATE_LIMITED" });
  boundHeaders(req, parts.provider);
  const declared = header(req, "content-length");
  const limit = limitForProvider(parts.provider);
  if (/^\d+$/.test(String(declared).trim()) && Number(declared) > Math.min(limit, H2B_ABSOLUTE_BODY_LIMIT_BYTES)) {
    res.setHeader("connection", "close");
    return res.status(413).json({ error: "H2B_PAYLOAD_TOO_LARGE" });
  }
  const rawBody = await readH2BRawBody(req, Math.min(limit, H2B_ABSOLUTE_BODY_LIMIT_BYTES));
  let endpoint;
  try { endpoint = await resolveH2BEndpoint(endpointToken); }
  catch (error) { if (error instanceof HttpError && error.status === 404) return safe404(req, res); throw error; }
  if (providerFromPlatform(endpoint.platform) !== parts.provider) return safe404(req, res);
  if (!allowH2BRequest(endpoint.safeFingerprint, sourceAddress, Date.now(), parts.provider)) return res.status(429).json({ error: "H2B_RATE_LIMITED" });
  const result = await admitH2BWebhook({ endpointToken, endpoint, headers: req.headers, rawBody });
  if (result.status === "IGNORED") return res.status(202).json({ status: "IGNORED", provider: result.provider, topic: result.topic });
  return res.status(result.status === "DUPLICATE" ? 200 : 202).json({ status: result.status, duplicate: result.duplicate, provider: result.provider, topic: result.topic, endpointFingerprint: result.safeEndpointFingerprint });
});

h2bPublicRouter.use(safe404);

export { H2B_PUBLIC_ROUTE_PREFIX };
