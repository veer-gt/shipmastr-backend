import { ADDRESS_FLAGS } from "./shipping-order-foundation.types.js";

const TEST_PATTERNS = /^(test|xyz|aaa|bbb|ccc|abc|dummy|fake|sample|asdf|1234)/i;
const INDIAN_PINCODE = /^[1-9][0-9]{5}$/;

export type AddressQualityResult = {
  score: number;
  flags: string[];
  passed: boolean;
};

export function scoreAddress(params: {
  addressLine1?: string | null | undefined;
  addressLine2?: string | null | undefined;
  city?: string | null | undefined;
  state?: string | null | undefined;
  pincode?: string | null | undefined;
  landmark?: string | null | undefined;
}): AddressQualityResult {
  const flags: string[] = [];
  let score = 0;

  try {
    const pincode = params.pincode?.trim() ?? "";
    const state = params.state?.trim() ?? "";
    const city = params.city?.trim() ?? "";
    const addressLine1 = params.addressLine1?.trim() ?? "";

    if (INDIAN_PINCODE.test(pincode)) {
      score += 20;
    } else {
      flags.push(ADDRESS_FLAGS.PINCODE_INVALID_FORMAT);
    }

    if (state.length >= 2) {
      score += 15;
    } else {
      flags.push(ADDRESS_FLAGS.STATE_MISSING);
    }

    if (city.length >= 2) {
      score += 15;
    } else {
      flags.push(ADDRESS_FLAGS.CITY_MISSING);
    }

    if (addressLine1.length >= 10) {
      score += 20;
    } else {
      flags.push(ADDRESS_FLAGS.ADDRESS_TOO_SHORT);
    }

    if (!TEST_PATTERNS.test(addressLine1)) {
      score += 10;
    } else {
      flags.push(ADDRESS_FLAGS.ADDRESS_LOOKS_TEST);
    }

    if (addressLine1.length <= 200) {
      score += 10;
    }

    if (!params.landmark && !params.addressLine2) {
      flags.push(ADDRESS_FLAGS.LANDMARK_HELPFUL);
    }
  } catch {
    flags.push(ADDRESS_FLAGS.ADDRESS_TOO_SHORT);
  }

  const boundedScore = Math.min(Math.max(score, 0), 100);
  return {
    score: boundedScore,
    flags,
    passed: boundedScore >= 60
  };
}
