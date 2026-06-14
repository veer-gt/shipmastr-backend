import type { InternalCourierProviderCode } from "./provider-adapter.types.js";
import { createBigshipAdapter } from "./bigship/bigship.adapter.js";

export function getInternalCourierProvider(code: InternalCourierProviderCode) {
  if (code === "bigship") {
    return createBigshipAdapter();
  }

  throw new Error(`Unsupported internal courier provider: ${code}`);
}
