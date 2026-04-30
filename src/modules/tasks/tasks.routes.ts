import { Router } from "express";
import { requireInternalSecret } from "../../middleware/internal.js";

export const tasksRouter = Router();

tasksRouter.use(requireInternalSecret);

tasksRouter.post(
  "/notifications",
  async (_req, res) => {
    res.json({
      ok: true,
      task: "notifications"
    });
  }
);

tasksRouter.post(
  "/ndr-actions",
  async (_req, res) => {
    res.json({
      ok: true,
      task: "ndr"
    });
  }
);
