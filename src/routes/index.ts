import { Router } from "express";

import { requireFirebaseAuth } from "../middleware/firebaseAuth.js";
import { requireJwtAuth } from "../middleware/jwtAuth.js";
import { authRouter } from "../modules/auth/auth.routes.js";
import { ordersRouter } from "../modules/orders/orders.routes.js";
import { shipmentsRouter } from "../modules/shipments/shipments.routes.js";
import { riskRouter } from "../modules/risk/risk.routes.js";
import { webhooksRouter } from "../modules/webhooks/webhooks.routes.js";
import { tasksRouter } from "../modules/tasks/tasks.routes.js";
import { trackingRouter } from "../modules/tracking/tracking.routes.js";

export const apiRouter = Router();

apiRouter.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "shipmastr-api",
  });
});

apiRouter.use("/auth", authRouter);
apiRouter.use("/tracking", trackingRouter);
apiRouter.use("/orders", requireJwtAuth, ordersRouter);
apiRouter.use("/shipments", requireJwtAuth, shipmentsRouter);
apiRouter.use("/risk", requireFirebaseAuth, riskRouter);
apiRouter.use("/webhooks", webhooksRouter);
apiRouter.use("/internal/tasks", requireFirebaseAuth, tasksRouter);
