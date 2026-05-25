import { Router } from "express";

import { requireFirebaseAuth } from "../middleware/firebaseAuth.js";
import { requireInternalSecret } from "../middleware/internal.js";
import { requireAdminJwt, requireCourierJwt, requireJwtAuth } from "../middleware/jwtAuth.js";
import { adminRouter } from "../modules/admin/admin.routes.js";
import { automationCallbacksRouter, automationCommunicationsRouter, automationRouter } from "../modules/automation/automation.routes.js";
import { authRouter } from "../modules/auth/auth.routes.js";
import { codRemittancesRouter } from "../modules/codRemittances/cod-remittances.routes.js";
import { adminCourierPartnerApplicationRouter, courierPartnerApplicationRouter } from "../modules/courierPartnerApplications/courier-partner-application.routes.js";
import { adminCourierPartnerRouter, courierOnboardingRouter } from "../modules/courierPartnerOnboarding/onboarding.routes.js";
import { courierRouter } from "../modules/courier/courier.routes.js";
import { courierInvoicesRouter } from "../modules/courierInvoices/courier-invoices.routes.js";
import { adminDomainsRouter, domainStatusRouter, internalDomainProvisioningRouter, merchantDomainsRouter } from "../modules/domains/domains.routes.js";
import { ordersRouter } from "../modules/orders/orders.routes.js";
import { financeRouter } from "../modules/sellerSettlements/finance.routes.js";
import { firstShipmentRequestRouter } from "../modules/firstShipmentRequest/first-shipment-request.routes.js";
import { importsRouter } from "../modules/imports/imports.routes.js";
import { shipmentsRouter } from "../modules/shipments/shipments.routes.js";
import { riskRouter } from "../modules/risk/risk.routes.js";
import { intelligenceOpsRouter, intelligenceRouter } from "../modules/intelligence/intelligence.routes.js";
import { journalRouter } from "../modules/journal/journal.routes.js";
import { leadsRouter } from "../modules/leads/leads.routes.js";
import { newsletterRouter } from "../modules/newsletter/newsletter.routes.js";
import { onboardingRouter } from "../modules/onboarding/onboarding.routes.js";
import { reconciliationRouter } from "../modules/reconciliation/reconciliation.routes.js";
import { adminStorefrontsRouter, publicStorefrontsRouter, storefrontsRouter } from "../modules/storefronts/storefronts.routes.js";
import { adminTaxComplianceRouter, courierTaxComplianceRouter, sellerTaxComplianceRouter } from "../modules/taxCompliance/tax-compliance.routes.js";
import { webhooksRouter } from "../modules/webhooks/webhooks.routes.js";
import { tasksRouter } from "../modules/tasks/tasks.routes.js";
import { trackingRouter } from "../modules/tracking/tracking.routes.js";

export const apiRouter = Router();

apiRouter.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "shipmastr-api",
  });
});

apiRouter.use("/auth", authRouter);
apiRouter.use("/courier-partner-applications", courierPartnerApplicationRouter);
apiRouter.use("/admin/courier-partner-applications", requireAdminJwt, adminCourierPartnerApplicationRouter);
apiRouter.use("/admin/courier-partners", requireAdminJwt, adminCourierPartnerRouter);
apiRouter.use("/admin/tax-compliance", requireAdminJwt, adminTaxComplianceRouter);
apiRouter.use("/admin/domains", requireAdminJwt, adminDomainsRouter);
apiRouter.use("/admin/storefronts", requireAdminJwt, adminStorefrontsRouter);
apiRouter.use("/admin", requireAdminJwt, adminRouter);
apiRouter.use("/automation/callbacks", automationCallbacksRouter);
apiRouter.use("/automation/communications", requireInternalSecret, automationCommunicationsRouter);
apiRouter.use("/automation", requireJwtAuth, automationRouter);
apiRouter.use("/cod-remittances", requireJwtAuth, codRemittancesRouter);
apiRouter.use("/courier/onboarding", requireCourierJwt, courierOnboardingRouter);
apiRouter.use("/courier/tax-compliance", requireCourierJwt, courierTaxComplianceRouter);
apiRouter.use("/courier", courierRouter);
apiRouter.use("/courier-invoices", requireJwtAuth, courierInvoicesRouter);
apiRouter.use("/finance", requireJwtAuth, financeRouter);
apiRouter.use("/first-shipment-request", requireJwtAuth, firstShipmentRequestRouter);
apiRouter.use("/imports", requireJwtAuth, importsRouter);
apiRouter.use("/journal", journalRouter);
apiRouter.use("/leads", leadsRouter);
apiRouter.use("/domains", requireJwtAuth, domainStatusRouter);
apiRouter.use("/merchant/domains", requireJwtAuth, merchantDomainsRouter);
apiRouter.use("/newsletter", newsletterRouter);
apiRouter.use("/onboarding", requireJwtAuth, onboardingRouter);
apiRouter.use("/tax-compliance", requireJwtAuth, sellerTaxComplianceRouter);
apiRouter.use("/tracking", trackingRouter);
apiRouter.use("/intelligence/ops", requireInternalSecret, intelligenceOpsRouter);
apiRouter.use("/intelligence", requireJwtAuth, intelligenceRouter);
apiRouter.use("/orders", requireJwtAuth, ordersRouter);
apiRouter.use("/reconciliation", requireJwtAuth, reconciliationRouter);
apiRouter.use("/shipments", requireJwtAuth, shipmentsRouter);
apiRouter.use("/storefronts", publicStorefrontsRouter);
apiRouter.use("/risk", requireFirebaseAuth, riskRouter);
apiRouter.use("/webhooks", webhooksRouter);
apiRouter.use("/tasks", tasksRouter);
apiRouter.use("/internal/provisioning", requireInternalSecret, internalDomainProvisioningRouter);
apiRouter.use("/internal/storefronts", storefrontsRouter);
apiRouter.use("/internal/tasks", requireFirebaseAuth, tasksRouter);
