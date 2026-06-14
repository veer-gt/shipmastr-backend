import {
  PlatformConnectionStatus,
  PlatformImportJobMode,
  PlatformImportSource,
  Prisma,
  type MerchantOnboardingState,
  type PlatformConnection
} from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { createPlatformImportJob, runPlatformImportJobFoundation } from "../platformIntegrations/importQueue/platform-import-queue.service.js";
import { testConnectionCredentialReadiness } from "../credentialVault/credential-vault.service.js";
import { serializeMerchantOnboardingState } from "./merchant-onboarding.serializer.js";
import {
  MERCHANT_STORE_ONBOARDING_STEPS,
  type MerchantOnboardingMilestone,
  type MerchantStoreOnboardingStep
} from "./merchant-onboarding.types.js";
import type {
  MerchantOnboardingConnectionActionInput,
  MerchantOnboardingFirstFetchInput,
  MerchantOnboardingStatePatchInput
} from "./merchant-onboarding.validation.js";

type Db = Prisma.TransactionClient | typeof prisma;

type OnboardingDeps = {
  testReadiness?: typeof testConnectionCredentialReadiness;
  createImportJob?: typeof createPlatformImportJob;
  runImportJob?: typeof runPlatformImportJobFoundation;
};

const milestoneDefinitions = [
  ["store_connected", "Store connected", "storeConnected"],
  ["credentials_ready", "Credentials ready", "credentialsReady"],
  ["first_fetch_completed", "First order fetch completed", "firstFetchCompleted"],
  ["reconciliation_viewed", "Import reconciliation reviewed", "reconciliationViewed"],
  ["first_conversion_completed", "Eligible orders prepared for shipping", "firstConversionCompleted"],
  ["shipping_workspace_ready", "Shipping workspace ready", "shippingWorkspaceReady"]
] as const;

function isOnboardingStep(value: string): value is MerchantStoreOnboardingStep {
  return (MERCHANT_STORE_ONBOARDING_STEPS as readonly string[]).includes(value);
}

function currentStepFor(record: MerchantOnboardingState): MerchantStoreOnboardingStep {
  if (record.completedAt || record.currentStep === "COMPLETE") return "COMPLETE";
  if (!record.storeConnected) return "CONNECT_STORE";
  if (!record.credentialsReady) return "ADD_CREDENTIALS";
  if (!record.firstFetchCompleted) return "FETCH_ORDERS";
  if (!record.reconciliationViewed) return "REVIEW_RECONCILIATION";
  if (!record.firstConversionCompleted) return "CONVERT_ELIGIBLE";
  if (!record.shippingWorkspaceReady) return "OPEN_SHIPPING_WORKSPACE";
  return isOnboardingStep(record.currentStep) ? record.currentStep : "OPEN_SHIPPING_WORKSPACE";
}

function milestonesFor(record: MerchantOnboardingState): MerchantOnboardingMilestone[] {
  return milestoneDefinitions.map(([key, label, field]) => ({
    key,
    label,
    complete: Boolean(record[field])
  }));
}

function nextActionsFor(step: MerchantStoreOnboardingStep) {
  const actions: Record<MerchantStoreOnboardingStep, string[]> = {
    WELCOME: ["Choose a store platform"],
    CHOOSE_PLATFORM: ["Choose a store platform"],
    CONNECT_STORE: ["Connect Shopify, WooCommerce, Magento, or Custom API store metadata"],
    ADD_CREDENTIALS: ["Add a one-time secure credential for read-only order import"],
    TEST_CONNECTION: ["Run a safe credential readiness check"],
    FETCH_ORDERS: ["Start a manual read-only order fetch"],
    REVIEW_RECONCILIATION: ["Review import reconciliation"],
    CONVERT_ELIGIBLE: ["Convert eligible import items into Shipmastr draft orders"],
    OPEN_SHIPPING_WORKSPACE: ["Open the shipping workspace and review Ready to Ship / Needs Attention"],
    COMPLETE: ["Continue with controlled Shipmastr shipping operations"]
  };
  return actions[step];
}

function serializeState(record: MerchantOnboardingState) {
  const milestones = milestonesFor(record);
  const currentStep = currentStepFor(record);
  const completed = milestones.filter((milestone) => milestone.complete).length;
  return serializeMerchantOnboardingState(record, {
    currentStep,
    milestones,
    progressPercent: Math.round((completed / milestones.length) * 100),
    nextActions: nextActionsFor(currentStep)
  });
}

async function getOrCreateState(merchantId: string, client: Db) {
  const existing = await client.merchantOnboardingState.findUnique({ where: { merchantId } });
  if (existing) return existing;
  return client.merchantOnboardingState.create({
    data: {
      merchantId,
      currentStep: "WELCOME"
    }
  });
}

async function findConnection(merchantId: string, connectionId: string, client: Db) {
  const connection = await client.platformConnection.findFirst({
    where: { id: connectionId, merchantId }
  });
  if (!connection) throw new HttpError(404, "PLATFORM_CONNECTION_NOT_FOUND");
  if (connection.status === PlatformConnectionStatus.DISABLED) {
    throw new HttpError(409, "PLATFORM_CONNECTION_DISABLED");
  }
  return connection;
}

function statePatch(input: MerchantOnboardingStatePatchInput): Prisma.MerchantOnboardingStateUpdateInput {
  const data: Prisma.MerchantOnboardingStateUpdateInput = {};
  if (input.currentStep !== undefined) data.currentStep = input.currentStep;
  if (input.storeConnected !== undefined) data.storeConnected = input.storeConnected;
  if (input.credentialsReady !== undefined) data.credentialsReady = input.credentialsReady;
  if (input.firstFetchCompleted !== undefined) data.firstFetchCompleted = input.firstFetchCompleted;
  if (input.reconciliationViewed !== undefined) data.reconciliationViewed = input.reconciliationViewed;
  if (input.firstConversionCompleted !== undefined) data.firstConversionCompleted = input.firstConversionCompleted;
  if (input.shippingWorkspaceReady !== undefined) data.shippingWorkspaceReady = input.shippingWorkspaceReady;
  return data;
}

async function updateState(
  merchantId: string,
  data: Prisma.MerchantOnboardingStateUpdateInput,
  client: Db
) {
  await getOrCreateState(merchantId, client);
  const updated = await client.merchantOnboardingState.update({
    where: { merchantId },
    data
  });
  return serializeState(updated);
}

export async function getMerchantStoreOnboardingState(merchantId: string, client: Db = prisma) {
  return serializeState(await getOrCreateState(merchantId, client));
}

export async function updateMerchantStoreOnboardingState(
  merchantId: string,
  input: MerchantOnboardingStatePatchInput,
  client: Db = prisma
) {
  return updateState(merchantId, statePatch(input), client);
}

export async function testMerchantStoreConnection(
  merchantId: string,
  input: MerchantOnboardingConnectionActionInput,
  client: Db = prisma,
  deps: OnboardingDeps = {}
) {
  const connection = await findConnection(merchantId, input.connectionId, client);
  const testReadiness = deps.testReadiness ?? testConnectionCredentialReadiness;
  const readiness = await testReadiness(merchantId, connection.id, client);
  const state = await updateState(merchantId, {
    storeConnected: true,
    credentialsReady: Boolean(readiness.ready),
    currentStep: readiness.ready ? "FETCH_ORDERS" : "ADD_CREDENTIALS"
  }, client);

  return {
    state,
    connection: connectionSummary(connection),
    credential_readiness: readiness
  };
}

export async function startMerchantOnboardingFirstFetch(
  merchantId: string,
  input: MerchantOnboardingFirstFetchInput,
  client: Db = prisma,
  deps: OnboardingDeps = {}
) {
  const connection = await findConnection(merchantId, input.connectionId, client);
  const createImportJob = deps.createImportJob ?? createPlatformImportJob;
  const runImportJob = deps.runImportJob ?? runPlatformImportJobFoundation;
  const created = await createImportJob(merchantId, {
    connectionId: connection.id,
    mode: PlatformImportJobMode.READ_ONLY_FETCH_PLACEHOLDER,
    source: PlatformImportSource.POLLING_PLACEHOLDER,
    requestedBy: "merchant-onboarding",
    orders: [],
    readOptions: {
      ...(input.limit ? { limit: input.limit } : {})
    }
  }, client);
  const ran = await runImportJob(merchantId, created.job.job_id, client);
  const state = await updateState(merchantId, {
    storeConnected: true,
    firstFetchCompleted: true,
    currentStep: "REVIEW_RECONCILIATION"
  }, client);

  return {
    state,
    connection: connectionSummary(connection),
    import_job: ran.job,
    imported_items: ran.items,
    safety: {
      read_only_fetch: true,
      creates_shipments: false,
      updates_store: false
    }
  };
}

export async function markMerchantOnboardingReconciliationViewed(
  merchantId: string,
  client: Db = prisma
) {
  return updateState(merchantId, {
    reconciliationViewed: true,
    currentStep: "CONVERT_ELIGIBLE"
  }, client);
}

export async function completeMerchantStoreOnboarding(merchantId: string, client: Db = prisma) {
  const state = await getOrCreateState(merchantId, client);
  const missing = milestonesFor(state)
    .filter((milestone) => milestone.key !== "shipping_workspace_ready" && !milestone.complete)
    .map((milestone) => milestone.key);
  if (missing.length) {
    throw new HttpError(409, "MERCHANT_ONBOARDING_MILESTONES_INCOMPLETE", { missing });
  }
  const updated = await client.merchantOnboardingState.update({
    where: { merchantId },
    data: {
      shippingWorkspaceReady: true,
      currentStep: "COMPLETE",
      completedAt: state.completedAt ?? new Date()
    }
  });
  return serializeState(updated);
}

function connectionSummary(connection: PlatformConnection) {
  return {
    connection_id: connection.id,
    platform: connection.platform,
    store_name: connection.storeName,
    store_url: connection.storeUrl,
    status: connection.status
  };
}
