import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(8080),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  WEBHOOK_SECRET: z.string().min(32),
  CORS_ORIGINS: z.string().default("")
});

export const env = schema.parse(process.env);

export const corsOrigins = env.CORS_ORIGINS
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
