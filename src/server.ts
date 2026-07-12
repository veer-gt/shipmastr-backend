import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import { pinoHttp } from "pino-http";

import { allowedCorsOrigins, env } from "./config/env.js";
import { corsAllowedHeaders } from "./config/cors.js";
import { logger } from "./lib/logger.js";
import { codDashboardRouter } from "./modules/codDashboard/cod-dashboard.routes.js";
import { apiRouter } from "./routes/index.js";
import { errorHandler } from "./middleware/error.js";
import { validateRequestTarget } from "./middleware/request-target.js";

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

const app = express();

app.set("trust proxy", env.TRUSTED_PROXY_HOPS);

app.use(helmet());
app.use(compression());

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedCorsOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [...corsAllowedHeaders],
    credentials: true
  })
);

app.use(
  rateLimit({
    windowMs: 60_000,
    limit: 240
  })
);

app.use(pinoHttp({ logger }));
app.use(validateRequestTarget);

app.use(
  express.json({
    // SF2: reverted from a temporary 8mb global limit. Product/hero/logo images no
    // longer travel through the JSON body at all — they upload browser -> GCS via
    // SF1's V4 signed-URL flow (see storefront-assets.service.ts), and themeJson
    // only ever carries small asset-id references plus a 200KB serialized-size
    // guard (assertThemeJsonSaveSafety in storefronts.service.ts). 256kb is a
    // generous cushion over Express's 100kb default for normal API payloads
    // without reopening the door to inline image bytes in a JSON body.
    limit: "256kb",
    verify: (req, _res, buf) => {
      (req as express.Request).rawBody = Buffer.from(buf);
    }
  })
);

app.get("/", (_req, res) => {
  res.json({ ok: true });
});

app.use("/cod", codDashboardRouter);
app.use("/api", apiRouter);
app.use("/v1", apiRouter);

app.use(errorHandler);

app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "shipmastr api running");
});
