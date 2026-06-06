import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PartnerType, SellerCourierPartnerStatus } from "@prisma/client";
import {
  serializePublicAutoEnableResult,
  type AutoEnableCourierPartnersResult
} from "../../courier-partners.service.js";
import {
  mapBigshipRatesToProviderRates,
  serializeProviderRateForSeller
} from "./bigship.mapper.js";

const forbiddenPublicTerms =
  /bigship|access_key|bearer|warehouseId|warehouse_id|MasterCustomOrderId|providerOrder|token|password/i;

describe("Bigship public safety boundary", () => {
  it("does not leak provider internals in public courier partner serialization", () => {
    const internalResult: AutoEnableCourierPartnersResult = {
      enabled: [{
        id: "mapping_1",
        sellerId: "seller_1",
        courierPartnerId: "courier_bigship",
        status: SellerCourierPartnerStatus.active,
        partnerType: PartnerType.system_managed,
        credentialsRequiredFromSeller: false,
        country: "IN",
        courierPartner: {
          id: "courier_bigship",
          code: "bigship",
          name: "Bigship",
          isSystemManaged: true
        }
      }],
      skipped: []
    };

    const publicResult = serializePublicAutoEnableResult(internalResult);
    const json = JSON.stringify(publicResult);

    assert.equal(publicResult.enabled[0]?.partner_code, "shipmastr_courier_network");
    assert.equal(publicResult.enabled[0]?.partner_name, "Shipmastr Courier Network");
    assert.doesNotMatch(json, forbiddenPublicTerms);
  });

  it("does not leak provider internals in public rate serialization", () => {
    const providerRates = mapBigshipRatesToProviderRates({
      rates: [{
        courierId: "internal_courier_1",
        courierName: "Internal Courier",
        total_charge: 100,
        charged_weight: 1,
        tat_days: 3,
        recommended: true
      }]
    });

    const publicRates = providerRates.map(serializeProviderRateForSeller);
    const json = JSON.stringify(publicRates);

    assert.equal(publicRates[0]?.courierNetwork, "Shipmastr Courier Network");
    assert.match(json, /Shipmastr/);
    assert.doesNotMatch(json, forbiddenPublicTerms);
  });
});
