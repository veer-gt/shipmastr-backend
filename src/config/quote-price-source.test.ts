import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { QuotePriceSourceConfigError, resolveQuotePriceSource } from "./quote-price-source.js";

describe("quote price source config guard", () => {
  it("defaults protected runtimes to catalog_strict", () => {
    assert.equal(resolveQuotePriceSource({ NODE_ENV: "production" }), "catalog_strict");
    assert.equal(resolveQuotePriceSource({ NODE_ENV: "development", APP_ENV: "staging" }), "catalog_strict");
  });

  it("allows client_allowed only in local/demo-style runtimes", () => {
    assert.equal(resolveQuotePriceSource({
      NODE_ENV: "development",
      APP_ENV: "development",
      QUOTE_PRICE_SOURCE: "client_allowed"
    }), "client_allowed");
  });

  it("refuses to boot with client_allowed in production or staging", () => {
    assert.throws(
      () => resolveQuotePriceSource({
        NODE_ENV: "production",
        QUOTE_PRICE_SOURCE: "client_allowed"
      }),
      (error) => error instanceof QuotePriceSourceConfigError
        && /forbidden/.test(error.message)
    );
    assert.throws(
      () => resolveQuotePriceSource({
        NODE_ENV: "development",
        APP_ENV: "staging",
        QUOTE_PRICE_SOURCE: "client_allowed"
      }),
      (error) => error instanceof QuotePriceSourceConfigError
        && /forbidden/.test(error.message)
    );
  });
});
