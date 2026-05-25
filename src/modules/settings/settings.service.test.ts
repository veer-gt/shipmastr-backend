import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { getSellerSettingsProfile, updateSellerSettingsProfile } from "./settings.service.js";

const merchant = {
  id: "merchant_1",
  name: "Skymax",
  email: "ops@skymax.example",
  phone: "+919876543210",
  onboardingStatus: "READY_TO_SHIP"
};

const user = {
  id: "user_1",
  email: "owner@skymax.example",
  name: "Skymax Owner",
  role: "SELLER_OWNER",
  userType: "SELLER_ACCOUNT",
  merchantId: "merchant_1"
};

function makeClient(overrides: Record<string, unknown> = {}) {
  const state = {
    merchant: { ...merchant },
    user: { ...user },
    policy: {
      metadata: {}
    },
    updatedMerchantName: "",
    upsertedMetadata: null as unknown
  };

  const client = {
    user: {
      findUnique: async () => state.user
    },
    merchant: {
      findUnique: async () => state.merchant,
      update: async ({ data }: any) => {
        state.updatedMerchantName = data.name;
        state.merchant.name = data.name;
        return state.merchant;
      }
    },
    automationPreference: {
      findUnique: async () => state.policy,
      upsert: async ({ create, update }: any) => {
        state.upsertedMetadata = update.metadata || create.metadata;
        state.policy.metadata = update.metadata || create.metadata;
        return { merchantId: "merchant_1", metadata: state.policy.metadata };
      }
    },
    ...overrides
  };

  return { client, state };
}

describe("seller settings profile", () => {
  it("mounts settings routes behind JWT auth", () => {
    const routes = readFileSync("src/routes/index.ts", "utf8");
    const settingsRoutes = readFileSync("src/modules/settings/settings.routes.ts", "utf8");

    assert.match(routes, /apiRouter\.use\("\/settings", requireJwtAuth, settingsRouter\);/);
    assert.match(routes, /apiRouter\.use\("\/seller\/settings", requireJwtAuth, settingsRouter\);/);
    assert.match(settingsRoutes, /settingsRouter\.get\("\/profile"/);
    assert.match(settingsRoutes, /settingsRouter\.patch\("\/profile"/);
  });

  it("returns safe defaults for a merchant with no explicit settings", async () => {
    const { client } = makeClient();

    const profile = await getSellerSettingsProfile("user_1", "merchant_1", client as any);

    assert.equal(profile.businessName, "Skymax");
    assert.equal(profile.merchantId, "merchant_1");
    assert.equal(profile.settings.businessName, "Skymax");
    assert.equal(profile.settings.trackingPageEnabled, true);
    assert.equal(profile.settings.trackingBranding.logoText, "Skymax");
    assert.equal(profile.settings.trackingBranding.supportEmail, "ops@skymax.example");
    assert.equal(profile.settings.trackingBranding.supportPhone, "+919876543210");
    assert.deepEqual(profile.settings.notificationChannels, { email: true, whatsapp: false });
  });

  it("rejects a user from another merchant", async () => {
    const { client } = makeClient({
      user: {
        findUnique: async () => ({ ...user, merchantId: "merchant_2" })
      }
    });

    await assert.rejects(
      () => getSellerSettingsProfile("user_1", "merchant_1", client as any),
      /MERCHANT_SETTINGS_SCOPE_DENIED/
    );
  });

  it("returns only seller-safe fields and does not expose credential metadata", async () => {
    const { client, state } = makeClient();
    state.policy.metadata = {
      sellerSettingsProfile: {
        brandedWhatsAppNumber: "+919999999999",
        trackingBranding: {
          logoText: "Skymax Direct",
          supportEmail: "help@skymax.example",
          primaryColor: "#123456"
        },
        socialLinks: {
          instagram: "https://instagram.example/skymax"
        },
        notificationPreferences: {
          email: true,
          whatsapp: true
        }
      },
      providerInternalA: "must-not-leak",
      providerInternalB: "also-must-not-leak",
      providerInternalReference: "internal-reference-must-not-leak"
    };

    const profile = await getSellerSettingsProfile("user_1", "merchant_1", client as any);
    const serialized = JSON.stringify(profile);

    assert.equal(profile.settings.brandedWhatsAppNumber, "+919999999999");
    assert.equal(profile.settings.trackingBranding.logoText, "Skymax Direct");
    assert.equal(profile.settings.trackingBranding.primaryColor, "#123456");
    assert.equal(profile.settings.notificationChannels.whatsapp, true);
    assert.equal(serialized.includes("must-not-leak"), false);
    assert.equal(serialized.includes("also-must-not-leak"), false);
    assert.equal(serialized.includes("internal-reference-must-not-leak"), false);
  });

  it("updates only allowed seller-safe fields", async () => {
    const { client, state } = makeClient();

    const profile = await updateSellerSettingsProfile({
      userId: "user_1",
      merchantId: "merchant_1",
      patch: {
        businessName: "Skymax Retail",
        brandedWhatsAppNumber: "+918888888888",
        settings: {
          trackingBranding: {
            supportEmail: "support@skymax.example",
            supportPhone: "+917777777777",
            primaryColor: "#abcdef"
          },
          socialLinks: {
            supportPortal: "https://support.skymax.example"
          },
          notificationPreferences: {
            email: true,
            whatsapp: true
          }
        }
      }
    }, client as any);

    const metadata = state.upsertedMetadata as any;

    assert.equal(state.updatedMerchantName, "Skymax Retail");
    assert.equal(profile.businessName, "Skymax Retail");
    assert.equal(profile.settings.brandedWhatsAppNumber, "+918888888888");
    assert.equal(profile.settings.trackingBranding.supportEmail, "support@skymax.example");
    assert.equal(metadata.sellerSettingsProfile.trackingBranding.supportPhone, "+917777777777");
    assert.equal(metadata.sellerSettingsProfile.socialLinks.supportPortal, "https://support.skymax.example");
    assert.equal(metadata.sellerSettingsProfile.notificationPreferences.whatsapp, true);
  });
});
