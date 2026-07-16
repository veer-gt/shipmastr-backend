import type { Request, Response } from "express";

/** Prefix reservation used when the feature flag is false. It deliberately
 * does not inspect the request body or touch any provider/H2B service. */
export function h2bDisabledPrefixGuard(_request: Request, response: Response) {
  return response.status(404).end();
}
