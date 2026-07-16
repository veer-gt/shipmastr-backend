import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import { pinoHttp } from "pino-http";
import { fileURLToPath } from "node:url";

import { allowedCorsOrigins, env } from "./config/env.js";
import { corsAllowedHeaders } from "./config/cors.js";
import { logger } from "./lib/logger.js";
import { codDashboardRouter } from "./modules/codDashboard/cod-dashboard.routes.js";
import { apiRouter } from "./routes/index.js";
import { errorHandler } from "./middleware/error.js";
import { validateRequestTarget } from "./middleware/request-target.js";
import { h2bDisabledPrefixGuard } from "./modules/h2b/h2b-disabled.guard.js";

declare global { namespace Express { interface Request { rawBody?: Buffer; } } }

export async function createApp(options: { h2bEnabled?: boolean } = {}) {
  const app = express();
  const h2bEnabled = options.h2bEnabled ?? env.H2B_PUBLIC_PROVIDER_INGRESS_ENABLED;
  const h2bPublicRouter = h2bEnabled ? (await import("./modules/h2b/h2b-public.routes.js")).h2bPublicRouter : null;
  app.set("trust proxy", env.TRUSTED_PROXY_HOPS);
  app.use(helmet());
  app.use(compression());
  app.use(cors({ origin: (origin, cb) => !origin || allowedCorsOrigins.includes(origin) ? cb(null, true) : cb(null, false), methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], allowedHeaders: [...corsAllowedHeaders], credentials: true }));
  app.use(rateLimit({ windowMs: 60_000, limit: 240 }));
  app.use((request, response, next) => {
    const raw = request.url;
    if (!(raw === "/api/public/provider-webhooks" || raw.startsWith("/api/public/provider-webhooks/"))) return next();
    const query = raw.indexOf("?") >= 0 ? raw.slice(raw.indexOf("?") + 1) : "";
    if (query.length > 4096 || (query && query.split("&").length > 32) || /[\u0000-\u001f]/.test(raw)) return response.status(404).json({ error: "H2B_ROUTE_NOT_FOUND" });
    try { decodeURIComponent(raw); } catch { return response.status(404).json({ error: "H2B_ROUTE_NOT_FOUND" }); }
    return next();
  });
  if (h2bPublicRouter) app.use("/api/public/provider-webhooks", h2bPublicRouter);
  else app.use("/api/public/provider-webhooks", h2bDisabledPrefixGuard);
  app.use(pinoHttp({ logger }));
  app.use(validateRequestTarget);
  app.use(express.json({ limit: "256kb", verify: (req, _res, buf) => { (req as express.Request).rawBody = Buffer.from(buf); } }));
  app.get("/", (_req, res) => res.json({ ok: true }));
  app.use("/cod", codDashboardRouter);
  app.use("/api", apiRouter);
  app.use("/v1", apiRouter);
  app.use(errorHandler);
  return app;
}

export async function startServer() {
  const app = await createApp();
  return app.listen(env.PORT, () => logger.info({ port: env.PORT }, "shipmastr api running"));
}

if (process.env.H2B_NO_LISTEN !== "1" && process.argv[1] === fileURLToPath(import.meta.url)) await startServer();
