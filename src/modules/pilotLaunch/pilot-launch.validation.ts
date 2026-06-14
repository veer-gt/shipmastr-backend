import { z } from "zod";

export const pilotLaunchMerchantIdSchema = z.string().trim().min(1).max(128);
