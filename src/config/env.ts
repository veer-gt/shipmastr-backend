import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_ENV: z.enum(["development", "test", "staging", "production"]).default("production"),
  PORT: z.coerce.number().default(8080),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  APP_SECRET_PEPPER: z.string().min(16),
  WEBHOOK_SECRET: z.string().min(32),
  CORS_ORIGINS: z.string().default(""),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_SECURE: z.coerce.boolean().default(true),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  SMTP_REPLY_TO: z.string().optional(),
  ADMIN_EMAIL: z.string().email().optional(),
  JOURNAL_EMAIL_PROVIDER: z.enum(["smtp", "mock", "webhook", "not_configured"]).default("not_configured"),
  JOURNAL_EMAIL_LIVE_SEND: z.coerce.boolean().default(false),
  JOURNAL_AUTOPUBLISH_STORE: z.enum(["postgres", "db", "not_configured"]).default("not_configured"),
  JOURNAL_EMAIL_FROM: z.string().optional(),
  EMAIL_FROM: z.string().email().optional(),
  EMAIL_FROM_NAME: z.string().optional(),
  NEWSLETTER_SECRET: z.string().optional(),
  JOURNAL_ADMIN_TOKEN: z.string().optional(),
  EMAIL_SPF_VERIFIED: z.coerce.boolean().default(false),
  EMAIL_DKIM_VERIFIED: z.coerce.boolean().default(false),
  EMAIL_DMARC_VERIFIED: z.coerce.boolean().default(false),
  EMAIL_DKIM_SELECTORS: z.string().default("google,default,selector1,selector2,resend"),
  GCP_PROJECT_ID: z.string().optional(),
  CLOUD_TASKS_LOCATION: z.string().default("asia-south1"),
  EMAIL_QUEUE_NAME: z.string().default("shipmastr-email-queue"),
  TASK_HANDLER_URL: z.string().url().optional(),
  COMM_PROVIDER: z.enum(["mock", "whatsapp", "sms"]).default("mock"),
  WHATSAPP_PROVIDER: z.enum(["mock", "gupshup", "interakt", "wati", "aisensy"]).default("mock"),
  SMS_PROVIDER: z.enum(["mock", "msg91", "twilio"]).default("mock"),
  CARRIER_PROVIDER: z.enum(["manual", "mock"]).default("manual"),
  CARRIER_API_BASE_URL: z.string().optional(),
  CARRIER_API_KEY_SECRET_NAME: z.string().optional(),
  CARRIER_ACCOUNT_ID_SECRET_NAME: z.string().optional(),
  CARRIER_WEBHOOK_SECRET_NAME: z.string().optional()
});

export const env = schema.parse(process.env);

export const corsOrigins = env.CORS_ORIGINS
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const defaultCorsOrigins = [
  "https://shipmastr.com",
  "https://www.shipmastr.com",
  "https://shipmastr.in",
  "https://www.shipmastr.in"
];

export const allowedCorsOrigins = Array.from(new Set([...corsOrigins, ...defaultCorsOrigins]));
