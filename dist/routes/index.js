import { Router } from "express";
import { authRouter } from "../modules/auth/auth.routes.js";
import { ordersRouter } from "../modules/orders/orders.routes.js";
import { riskRouter } from "../modules/risk/risk.routes.js";
import { webhooksRouter } from "../modules/webhooks/webhooks.routes.js";
import { tasksRouter } from "../modules/tasks/tasks.routes.js";
export const apiRouter = Router();
apiRouter.get("/health", (_req, res) => {
    res.json({
        ok: true,
        service: "shipmastr-api"
    });
});
apiRouter.use("/auth", authRouter);
apiRouter.use("/orders", ordersRouter);
apiRouter.use("/risk", riskRouter);
apiRouter.use("/webhooks", webhooksRouter);
apiRouter.use("/internal/tasks", tasksRouter);
//# sourceMappingURL=index.js.map