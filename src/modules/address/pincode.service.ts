import { prisma } from "../../lib/prisma.js";
import { HttpError } from "../../lib/httpError.js";

export type AddressPincodeResponse = {
  city: string;
  district: string;
  state: string;
  localities: string[];
};

type AddressPincodeRow = AddressPincodeResponse & {
  pincode: string;
};

export type AddressPincodeClient = {
  addressPincode: {
    findUnique(input: {
      where: { pincode: string };
      select: {
        pincode: true;
        city: true;
        district: true;
        state: true;
        localities: true;
      };
    }): Promise<AddressPincodeRow | null>;
  };
};

export class BoundedPincodeCache {
  private readonly rows = new Map<string, AddressPincodeResponse>();

  constructor(private readonly maxEntries = 500) {}

  get(pin: string) {
    const value = this.rows.get(pin);
    if (!value) return null;
    this.rows.delete(pin);
    this.rows.set(pin, value);
    return value;
  }

  set(pin: string, value: AddressPincodeResponse) {
    if (this.rows.has(pin)) this.rows.delete(pin);
    this.rows.set(pin, value);
    while (this.rows.size > this.maxEntries) {
      const oldest = this.rows.keys().next().value;
      if (!oldest) break;
      this.rows.delete(oldest);
    }
  }
}

const defaultClient = prisma as unknown as AddressPincodeClient;
const defaultCache = new BoundedPincodeCache();

function cleanPincode(value: unknown) {
  const pin = String(value ?? "").trim();
  if (!/^\d{6}$/.test(pin)) {
    throw new HttpError(400, "PINCODE_INVALID");
  }
  return pin;
}

function serializePincode(row: AddressPincodeRow): AddressPincodeResponse {
  return {
    city: row.city,
    district: row.district,
    state: row.state,
    localities: Array.isArray(row.localities) ? row.localities : []
  };
}

export class AddressPincodeService {
  constructor(
    private readonly client: AddressPincodeClient = defaultClient,
    private readonly cache: BoundedPincodeCache = defaultCache
  ) {}

  async lookup(inputPin: unknown): Promise<AddressPincodeResponse> {
    const pin = cleanPincode(inputPin);
    const cached = this.cache.get(pin);
    if (cached) return cached;

    const row = await this.client.addressPincode.findUnique({
      where: { pincode: pin },
      select: {
        pincode: true,
        city: true,
        district: true,
        state: true,
        localities: true
      }
    });

    if (!row) {
      throw new HttpError(404, "PINCODE_NOT_FOUND");
    }

    const response = serializePincode(row);
    this.cache.set(pin, response);
    return response;
  }
}

export const addressPincodeService = new AddressPincodeService();
