import { Router } from "express";
import { z } from "zod";

import { HttpError } from "../../lib/httpError.js";
import { requireJournalAdmin } from "../journal/journal-auth.js";
import {
  newsletterSubscriberStatus,
  subscribeNewsletter,
  unsubscribeNewsletter
} from "./newsletter.service.js";

export const newsletterRouter = Router();

const subscribeSchema = z.object({
  email: z.string().trim().email(),
  source: z.string().trim().min(1).max(120).optional()
});

const unsubscribeSchema = z.object({
  token: z.string().trim().min(16)
});

newsletterRouter.post("/subscribe", async (req, res) => {
  const input = subscribeSchema.parse(req.body);
  const subscriber = await subscribeNewsletter(input);
  res.status(201).json({
    id: subscriber.id,
    status: subscriber.status,
    message: "SUBSCRIBED"
  });
});

newsletterRouter.get("/unsubscribe", async (req, res) => {
  const input = unsubscribeSchema.parse(req.query);
  const subscriber = await unsubscribeNewsletter(input);
  if (!subscriber) {
    throw new HttpError(404, "INVALID_UNSUBSCRIBE_TOKEN");
  }

  res.json({
    message: "You have been unsubscribed from Shipmastr Journal.",
    status: subscriber.status
  });
});

newsletterRouter.get("/status", async (req, res) => {
  requireJournalAdmin(req);
  res.json(await newsletterSubscriberStatus());
});
