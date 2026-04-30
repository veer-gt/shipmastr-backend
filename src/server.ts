import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import { pinoHttp } from "pino-http";

import { env, corsOrigins } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { apiRouter } from "./routes/index.js";
import { errorHandler } from "./middleware/error.js";

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

const app = express();

app.set("trust proxy", 1);

app.use(helmet());
app.use(compression());

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || corsOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("CORS"));
    }
  })
);

app.use(
  rateLimit({
    windowMs: 60_000,
    limit: 240
  })
);

app.use(pinoHttp({ logger }));

app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as express.Request).rawBody = Buffer.from(buf);
    }
  })
);

app.get("/", (_req, res) => {
  res.json({ ok: true });
});

app.use("/v1", apiRouter);

app.use(errorHandler);

app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "shipmastr api running");
});
