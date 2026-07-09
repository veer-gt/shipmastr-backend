import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import express from "express";

import { errorHandler } from "./error.js";

async function withApp<T>(callback: (baseUrl: string) => Promise<T>) {
  const app = express();
  app.use(express.json({ limit: "1kb" }));
  app.post("/json", (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);

  const server = createServer(app);
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

describe("errorHandler", () => {
  it("maps oversized JSON bodies to a safe 413 response", async () => {
    await withApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/json`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload: "x".repeat(2048) })
      });

      assert.equal(response.status, 413);
      assert.deepEqual(await response.json(), { error: "PAYLOAD_TOO_LARGE" });
    });
  });
});
