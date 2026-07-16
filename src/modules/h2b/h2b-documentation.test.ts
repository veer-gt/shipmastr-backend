import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("Magento 64 KB cap is documented as an internal Shipmastr limit", async () => {
  const currentFile = fileURLToPath(import.meta.url);
  const documentation = await readFile(resolve(dirname(currentFile), "../../../docs/security/h2b-source-implementation-and-scratch-proof.md"), "utf8");
  assert.match(documentation, /SHIPMASTR_MAGENTO_EXTENSION_V1/);
  assert.match(documentation, /Conservative Shipmastr admission limit/);
  assert.match(documentation, /does not inherit Adobe Commerce Webhooks, Adobe I\/O Events or Adobe Experience Platform payload limits/);
  assert.doesNotMatch(documentation, /Adobe Commerce's documented 64 KB event-size limitation/);
  assert.doesNotMatch(documentation, /Adobe Commerce \[event size limitation\]/);
});
