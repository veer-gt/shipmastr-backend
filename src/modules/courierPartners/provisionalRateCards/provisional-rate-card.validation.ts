import { z } from "zod";
import {
  provisionalRateCardZoneCodes,
  shipmastrOutcomeTierCodes
} from "./provisional-rate-card.types.js";

export const provisionalRateCardSimulationSchema = z.object({
  outcome_code: z.enum(shipmastrOutcomeTierCodes).default("SHIPMASTR_SMART"),
  zone_code: z.enum(provisionalRateCardZoneCodes),
  weight_kg: z.coerce.number().positive(),
  seller_facing: z.coerce.boolean().default(false)
});
