import { Router, type Request, type Response } from "express";
import { z } from "zod";

import { HttpError } from "../../lib/httpError.js";
import { sendJournalEmail } from "../../lib/email.js";
import { logger } from "../../lib/logger.js";
import { requireJournalAdmin } from "./journal-auth.js";
import { getJournalEmailConfig } from "./journal-email.service.js";
import { validateJournalPost } from "./journal.guardrails.js";
import {
  listPublishedJournalPosts,
  publishJournalPost,
  rollbackLastPublishedJournalPost,
  runDailyJournalAutopublish
} from "./journal-post.service.js";

export const journalRouter = Router();

const publishOptionsSchema = z.object({
  mode: z.string().trim().optional(),
  publish: z.boolean().optional(),
  sendEmail: z.boolean().optional()
}).passthrough();

const sendTestEmailSchema = z.object({
  to: z.string().email(),
  subject: z.string().trim().min(1).max(160),
  text: z.string().trim().min(1).max(10000),
  html: z.string().trim().min(1).max(20000)
});

function safeRouteErrorName(error: unknown) {
  return error instanceof Error ? error.name : "UnknownError";
}

function safeRouteErrorMessage(error: unknown) {
  return error instanceof Error && /^[A-Z0-9_]{3,80}$/.test(error.message) ? error.message : "JOURNAL_DAILY_RUN_UNAVAILABLE";
}

function dailyRunSkippedResponse(input: {
  reason: string;
  options?: z.infer<typeof publishOptionsSchema>;
}) {
  return {
    ok: false,
    status: "SKIPPED",
    skipped: true,
    reason: input.reason,
    error: input.reason,
    published: false,
    emailSent: false,
    requested: {
      mode: input.options?.mode || "auto",
      publish: Boolean(input.options?.publish),
      sendEmail: Boolean(input.options?.sendEmail)
    },
    failedChecks: [input.reason]
  };
}

journalRouter.get("/email-config", async (_req, res) => {
  res.json(await getJournalEmailConfig());
});

journalRouter.get(["/posts", "/posts.json"], async (req, res) => {
  const limit = z.coerce.number().int().min(1).max(100).optional().parse(req.query.limit);
  res.json(await listPublishedJournalPosts(limit === undefined ? {} : { limit }));
});

journalRouter.post("/send-test-email", async (req, res) => {
  requireJournalAdmin(req);
  const input = sendTestEmailSchema.parse(req.body);
  const config = await getJournalEmailConfig();

  if (!config.ready) {
    return res.status(409).json({
      ok: false,
      error: "JOURNAL_EMAIL_NOT_READY",
      missing: config.missing,
      config: {
        provider: config.provider,
        sender: config.sender,
        envFlags: config.envFlags,
        smtp: config.smtp,
        secrets: config.secrets,
        domainAuth: config.domainAuth
      }
    });
  }

  const result = await sendJournalEmail({
    ...input,
    logPrefix: "journal_test_email_send",
    metadata: {
      source: "admin-test-endpoint"
    }
  });

  res.json({
    ok: true,
    ...result
  });
});

journalRouter.post("/validate", (req, res) => {
  requireJournalAdmin(req);
  res.json(validateJournalPost(req.body));
});

export async function handleRunDailyJournal(req: Request, res: Response) {
  try {
    requireJournalAdmin(req);
  } catch (error) {
    if (error instanceof HttpError && error.message === "JOURNAL_ADMIN_TOKEN_NOT_CONFIGURED") {
      logger.warn(
        {
          message: "journal_daily_run_skipped",
          journal: {
            reason: "JOURNAL_ADMIN_TOKEN_NOT_CONFIGURED"
          }
        },
        "journal_daily_run_skipped"
      );

      return res.status(202).json(dailyRunSkippedResponse({
        reason: "JOURNAL_ADMIN_TOKEN_NOT_CONFIGURED"
      }));
    }

    throw error;
  }

  const options = publishOptionsSchema.parse(req.body);
  try {
    const result = await runDailyJournalAutopublish({
      ...(options.mode === undefined ? {} : { mode: options.mode }),
      ...(options.publish === undefined ? {} : { publish: options.publish }),
      ...(options.sendEmail === undefined ? {} : { sendEmail: options.sendEmail })
    });

    res.status((result as { skipped?: boolean }).skipped ? 202 : 200).json(result);
  } catch (error) {
    logger.error(
      {
        message: "journal_daily_run_failed",
        journal: {
          errorName: safeRouteErrorName(error),
          error: safeRouteErrorMessage(error)
        }
      },
      "journal_daily_run_failed"
    );

    res.status(202).json(dailyRunSkippedResponse({
      reason: "JOURNAL_DAILY_RUN_UNAVAILABLE",
      options
    }));
  }
}

journalRouter.post("/run-daily", handleRunDailyJournal);

journalRouter.post("/publish", async (req, res) => {
  requireJournalAdmin(req);
  const validation = validateJournalPost(req.body);
  if (!validation.pass) {
    return res.status(400).json({
      status: "FAILED_GUARDRAILS",
      ...validation
    });
  }
  res.json(await publishJournalPost(req.body));
});

journalRouter.post("/rollback-last", async (req, res) => {
  requireJournalAdmin(req);
  const result = await rollbackLastPublishedJournalPost();
  if (!result.ok) {
    throw new HttpError(result.error === "NO_PUBLISHED_JOURNAL_POST" ? 404 : 501, result.error || "JOURNAL_ROLLBACK_FAILED");
  }
  res.json(result);
});
