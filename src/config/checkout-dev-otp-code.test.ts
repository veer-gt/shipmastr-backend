import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertCheckoutDevOtpCodeProductionSafety,
  CheckoutDevOtpCodeConfigError
} from "./checkout-dev-otp-code.js";

describe("checkout dev OTP code config guard", () => {
  it("allows the smoke OTP code in staging and development", () => {
    assert.doesNotThrow(() => assertCheckoutDevOtpCodeProductionSafety({
      NODE_ENV: "production",
      APP_ENV: "staging",
      CHECKOUT_DEV_OTP_CODE: "123456"
    }));
    assert.doesNotThrow(() => assertCheckoutDevOtpCodeProductionSafety({
      NODE_ENV: "development",
      APP_ENV: "development",
      CHECKOUT_DEV_OTP_CODE: "123456"
    }));
  });

  it("forbids the smoke OTP code in production", () => {
    assert.throws(
      () => assertCheckoutDevOtpCodeProductionSafety({
        NODE_ENV: "production",
        APP_ENV: "production",
        CHECKOUT_DEV_OTP_CODE: "123456"
      }),
      (error) => error instanceof CheckoutDevOtpCodeConfigError
        && error.message === "CHECKOUT_DEV_OTP_CODE is forbidden in production"
        && !error.message.includes("123456")
    );
  });

  it("defaults NODE_ENV=production without APP_ENV to production", () => {
    assert.throws(
      () => assertCheckoutDevOtpCodeProductionSafety({
        NODE_ENV: "production",
        CHECKOUT_DEV_OTP_CODE: "123456"
      }),
      (error) => error instanceof CheckoutDevOtpCodeConfigError
        && /forbidden in production/.test(error.message)
    );
  });

  it("defaults an unset runtime to production", () => {
    assert.throws(
      () => assertCheckoutDevOtpCodeProductionSafety({
        CHECKOUT_DEV_OTP_CODE: "123456"
      }),
      (error) => error instanceof CheckoutDevOtpCodeConfigError
        && /forbidden in production/.test(error.message)
    );
  });
});
