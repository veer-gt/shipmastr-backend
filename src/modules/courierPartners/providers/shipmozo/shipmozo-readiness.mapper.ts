export function mapShipmozoReadinessSummary(input: { passed: boolean; probeType: string }) {
  return {
    passed: input.passed,
    probe_type: input.probeType,
    non_destructive: true,
    raw_response_stored: false,
    raw_headers_stored: false
  };
}

