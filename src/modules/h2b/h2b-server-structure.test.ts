import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("H2B route is dynamically loaded and reserved before the global JSON parser", async () => {
  const source = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), "../../server.ts"), "utf8").catch(async () =>
    readFile(resolve(dirname(fileURLToPath(import.meta.url)), "../../server.js"), "utf8")
  );
  const routePosition = source.indexOf("/api/public/provider-webhooks");
  const parserPosition = source.indexOf("express.json(");
  assert.notEqual(routePosition, -1);
  assert.ok(routePosition < parserPosition);
  assert.match(source, /import\("\.\/modules\/h2b\/h2b-public\.routes\.js"\)/);
  assert.doesNotMatch(source, /import\s+\{[^}]*h2bPublicRouter/);
});
