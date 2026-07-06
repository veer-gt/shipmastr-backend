import { Router, type Request, type Response } from "express";

import { HttpError } from "../../lib/httpError.js";
import { addressPincodeService, type AddressPincodeService } from "./pincode.service.js";

export const pincodeRouter = Router();

export function createPincodeLookupHandler(service: Pick<AddressPincodeService, "lookup"> = addressPincodeService) {
  return async function lookupPincode(req: Request, res: Response) {
    try {
      const result = await service.lookup(req.params.pin);
      return res.json(result);
    } catch (error) {
      if (error instanceof HttpError) {
        return res.status(error.status).json({ error: error.message });
      }
      throw error;
    }
  };
}

pincodeRouter.get("/:pin", createPincodeLookupHandler());
