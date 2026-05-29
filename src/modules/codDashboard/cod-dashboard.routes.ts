import { Router, type Request, type Response } from "express";
import { buildCodDashboardApiResponse } from "./cod-dashboard-summary.service.js";

export const codDashboardRouter = Router();

export function getCodDashboardSummaryHandler(_req: Request, res: Response) {
  res.json(buildCodDashboardApiResponse());
}

codDashboardRouter.get("/dashboard/summary", getCodDashboardSummaryHandler);
