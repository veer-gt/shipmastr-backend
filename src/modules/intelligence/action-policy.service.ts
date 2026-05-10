import type { MerchantAutomationPolicy, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

type Db = Prisma.TransactionClient | typeof prisma;

type BooleanPolicyKey =
  | "autoCodControlEnabled"
  | "autoOtpForBronzeEnabled"
  | "autoPrepaidOnlyForIronEnabled"
  | "autoAddressCorrectionEnabled"
  | "autoCourierSelectionEnabled"
  | "autoNdrRecoveryEnabled"
  | "autoRtoHoldEnabled"
  | "autoCancelAfterFailedVerificationEnabled"
  | "allowPrepaidConversionMessage"
  | "allowBuyerWhatsappMessages"
  | "allowBuyerSmsMessages"
  | "communicationEnabled";

export type MerchantAutomationPolicyPatch = {
  [Key in BooleanPolicyKey]?: MerchantAutomationPolicy[Key] | undefined;
} & {
  maxAutoHoldOrderValue?: number | null | undefined;
  maxAutoCourierCostIncrease?: number | null | undefined;
  maxAutoCodAmount?: number | null | undefined;
  dailyWhatsappLimit?: number | null | undefined;
  dailySmsLimit?: number | null | undefined;
  buyerMessageQuietHoursStart?: string | null | undefined;
  buyerMessageQuietHoursEnd?: string | null | undefined;
};

export async function getOrCreateMerchantAutomationPolicy(merchantId: string, client: Db = prisma) {
  return client.merchantAutomationPolicy.upsert({
    where: { merchantId },
    create: { merchantId },
    update: {}
  });
}

export async function updateMerchantAutomationPolicy(merchantId: string, patch: MerchantAutomationPolicyPatch, client: Db = prisma) {
  await getOrCreateMerchantAutomationPolicy(merchantId, client);
  const data = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined)
  ) as Prisma.MerchantAutomationPolicyUpdateInput;

  return client.merchantAutomationPolicy.update({
    where: { merchantId },
    data
  });
}
