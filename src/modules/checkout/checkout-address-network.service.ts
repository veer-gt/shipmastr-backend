import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";
import type { VerifiedCheckoutSessionContext } from "./checkout-address-session.service.js";
import { findNetworkEligibleAddressesForShopper } from "./checkout-address-graph.service.js";
import {
  recordAddressGraphHitNetwork,
  recordAddressGraphMiss,
  type AddressEventInput
} from "./checkout-address-telemetry.service.js";

type DbClient = typeof prisma | any;
type NetworkEligibleAddressFinder = (shopperId: string, currentMerchantId: string) => Promise<unknown[]>;
type AddressGraphEventRecorder = (input: Omit<AddressEventInput, "event">) => Promise<unknown>;

export type AddressNetworkConfig = {
  shadowEnabled: boolean;
  displayEnabled: boolean;
  activationThresholdPercent: number;
  metricsWindowDays: number;
};

export type AddressNetworkShadowSummary = {
  checked: boolean;
  hit: boolean;
  count: number;
};

export const ADDRESS_NETWORK_DEFAULT_CONFIG: AddressNetworkConfig = {
  shadowEnabled: true,
  displayEnabled: false,
  activationThresholdPercent: 8,
  metricsWindowDays: 30
};

function cleanWindowDays(value: unknown) {
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 365) return ADDRESS_NETWORK_DEFAULT_CONFIG.metricsWindowDays;
  return days;
}

function percent(numerator: number, denominator: number) {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 10000) / 100;
}

function windowStart(now: Date, windowDays: number) {
  return new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
}

export function getAddressNetworkConfig(overrides: Partial<AddressNetworkConfig> = {}): AddressNetworkConfig {
  return {
    shadowEnabled: overrides.shadowEnabled ?? env.ADDRESS_NETWORK_SHADOW_ENABLED,
    displayEnabled: overrides.displayEnabled ?? env.ADDRESS_NETWORK_PREFILL_ENABLED,
    activationThresholdPercent: overrides.activationThresholdPercent ?? env.ADDRESS_NETWORK_MIN_HIT_RATE_PERCENT,
    metricsWindowDays: overrides.metricsWindowDays ?? env.ADDRESS_NETWORK_METRICS_WINDOW_DAYS
  };
}

export class CheckoutAddressNetworkService {
  private readonly client: DbClient;
  private readonly now: () => Date;
  private readonly config: AddressNetworkConfig;
  private readonly networkEligibleAddressFinder: NetworkEligibleAddressFinder;
  private readonly graphHitNetworkRecorder: AddressGraphEventRecorder;
  private readonly graphMissRecorder: AddressGraphEventRecorder;

  constructor(input: {
    client?: DbClient | undefined;
    now?: (() => Date) | undefined;
    config?: Partial<AddressNetworkConfig> | undefined;
    networkEligibleAddressFinder?: NetworkEligibleAddressFinder | undefined;
    graphHitNetworkRecorder?: AddressGraphEventRecorder | undefined;
    graphMissRecorder?: AddressGraphEventRecorder | undefined;
  } = {}) {
    this.client = input.client ?? prisma;
    this.now = input.now ?? (() => new Date());
    this.config = getAddressNetworkConfig(input.config);
    this.networkEligibleAddressFinder = input.networkEligibleAddressFinder ?? findNetworkEligibleAddressesForShopper;
    this.graphHitNetworkRecorder = input.graphHitNetworkRecorder ?? recordAddressGraphHitNetwork;
    this.graphMissRecorder = input.graphMissRecorder ?? recordAddressGraphMiss;
  }

  async runAddressNetworkShadowLookupForVerifiedSession(
    ctx: Pick<VerifiedCheckoutSessionContext, "sessionId" | "merchantId" | "phoneHash" | "phoneLast2">
  ): Promise<AddressNetworkShadowSummary> {
    try {
      const phoneHash = String(ctx.phoneHash ?? "").trim();
      if (!phoneHash) {
        await this.recordMiss(ctx, { count: 0, status: "miss", reason: "shopper_not_found" });
        return { checked: true, hit: false, count: 0 };
      }

      const shopper = await this.client.shopperIdentity.findUnique({
        where: { phoneHash },
        select: { id: true }
      });

      if (!shopper?.id) {
        await this.recordMiss(ctx, { count: 0, status: "miss", reason: "shopper_not_found" });
        return { checked: true, hit: false, count: 0 };
      }

      const addresses = await this.networkEligibleAddressFinder(shopper.id, ctx.merchantId);
      const count = addresses.length;

      if (count > 0) {
        await this.recordHit(ctx, { count, status: "hit" });
        return { checked: true, hit: true, count };
      }

      await this.recordMiss(ctx, { count: 0, status: "miss", reason: "network_address_not_found" });
      return { checked: true, hit: false, count: 0 };
    } catch {
      logger.warn("checkout_address_network_shadow_failed");
      return { checked: false, hit: false, count: 0 };
    }
  }

  async getAddressNetworkMetrics(input: { windowDays?: unknown } = {}) {
    const windowDays = cleanWindowDays(input.windowDays ?? this.config.metricsWindowDays);
    const createdAt = { gte: windowStart(this.now(), windowDays) };
    const countEvent = (event: string) => this.client.addressEvent.count({ where: { event, createdAt } });

    const [
      graphHitNetworkCount,
      graphMissCount,
      graphHitMerchantCount,
      prefillOfferedCount,
      prefillAcceptedCount,
      prefillEditedCount
    ] = await Promise.all([
      countEvent("graph_hit_network"),
      countEvent("graph_miss"),
      countEvent("graph_hit_merchant"),
      countEvent("prefill_offered"),
      countEvent("prefill_accepted"),
      countEvent("prefill_edited")
    ]);

    const networkLookupCount = graphHitNetworkCount + graphMissCount;
    const networkHitRatePercent = percent(graphHitNetworkCount, networkLookupCount);
    const acceptRatePercent = percent(prefillAcceptedCount, prefillOfferedCount);

    return {
      windowDays,
      shadowEnabled: this.config.shadowEnabled,
      displayEnabled: this.config.displayEnabled,
      activationThresholdPercent: this.config.activationThresholdPercent,
      networkLookupCount,
      graphHitNetworkCount,
      graphMissCount,
      networkHitRatePercent,
      eligibleForDisplay: this.config.displayEnabled && networkHitRatePercent >= this.config.activationThresholdPercent,
      t1: {
        graphHitMerchantCount,
        prefillOfferedCount,
        prefillAcceptedCount,
        prefillEditedCount,
        acceptRatePercent
      }
    };
  }

  private async recordHit(
    ctx: Pick<VerifiedCheckoutSessionContext, "sessionId" | "merchantId">,
    meta: Record<string, unknown>
  ) {
    try {
      await this.graphHitNetworkRecorder({
        sessionId: ctx.sessionId,
        merchantId: ctx.merchantId,
        meta
      });
    } catch {
      logger.warn({ event: "graph_hit_network" }, "checkout_address_network_telemetry_failed");
    }
  }

  private async recordMiss(
    ctx: Pick<VerifiedCheckoutSessionContext, "sessionId" | "merchantId">,
    meta: Record<string, unknown>
  ) {
    try {
      await this.graphMissRecorder({
        sessionId: ctx.sessionId,
        merchantId: ctx.merchantId,
        meta
      });
    } catch {
      logger.warn({ event: "graph_miss" }, "checkout_address_network_telemetry_failed");
    }
  }
}

export const checkoutAddressNetworkService = new CheckoutAddressNetworkService();

export function runAddressNetworkShadowLookupForVerifiedSession(ctx: VerifiedCheckoutSessionContext) {
  return checkoutAddressNetworkService.runAddressNetworkShadowLookupForVerifiedSession(ctx);
}

export function getAddressNetworkMetrics(input: { windowDays?: unknown } = {}) {
  return checkoutAddressNetworkService.getAddressNetworkMetrics(input);
}
