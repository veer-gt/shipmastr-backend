import { Router } from "express";
import { z } from "zod";
import { requireInternalSecret } from "../../middleware/internal.js";
import { processAddressGeocodeTask } from "../addressGeocoding/address-geocoding.service.js";
import { processLeadNotificationTask } from "./email-task.service.js";

export const tasksRouter = Router();

tasksRouter.use(requireInternalSecret);

const leadNotificationTaskSchema = z.object({
  leadId: z.string().trim().min(1)
});

const addressGeocodeTaskSchema = z.object({
  taskId: z.string().trim().min(1)
});

tasksRouter.post(
  "/email/lead-notification",
  async (req, res) => {
    const body = leadNotificationTaskSchema.parse(req.body);
    const result = await processLeadNotificationTask({ leadId: body.leadId });

    if (result.status === "failed") {
      return res.status(500).json(result);
    }

    res.json(result);
  }
);

tasksRouter.post(
  "/address-geocode",
  async (req, res) => {
    const body = addressGeocodeTaskSchema.parse(req.body);
    const result = await processAddressGeocodeTask(body.taskId);
    res.json(result);
  }
);

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
