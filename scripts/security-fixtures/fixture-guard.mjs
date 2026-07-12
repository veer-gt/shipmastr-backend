import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";

const ALLOWED_EXTENSIONS = new Set([".json", ".jsonl", ".txt", ".mjs", ".ts", ".md"]);
const RESERVED_EMAIL_DOMAIN = /@(example\.test|example\.com|example\.org)$/i;

export function scanFixtureText(text) {
  const findings = [];
  const rules = [
    ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i],
    ["bearer-token", /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i],
    ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9._-]{8,}\.[A-Za-z0-9._-]{8,}\b/],
    ["database-credential-url", /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s/:]+:[^\s@]+@/i],
    ["common-api-key", /\b(?:sk_live_|sk_test_|AKIA|AIza|ghp_|xox[baprs]-)[A-Za-z0-9_-]{12,}/],
    ["non-reserved-email", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
    ["indian-mobile", /(?:\+91[- ]?|0)?[6-9]\d{9}\b/],
    ["street-address", /\b\d{1,5}\s+[A-Za-z][A-Za-z .'-]{1,40}\s+(?:street|st|road|rd|avenue|ave|lane|ln|nagar)\b/i],
    ["unredacted-order-or-awb", /(?:awb|tracking|order[_ -]?reference)\s*["']?\s*[:=]\s*["'](?!fixture[_-])[A-Za-z0-9-]{6,}["']/i]
  ];
  for (const [lineNumber, line] of String(text).split(/\r?\n/).entries()) {
    for (const [rule, pattern] of rules) {
      if (!pattern.test(line)) continue;
      if (rule === "non-reserved-email" && RESERVED_EMAIL_DOMAIN.test(line.match(pattern)?.[0] ?? "")) continue;
      if (rule === "bearer-token" && /Bearer\s+<redacted>/i.test(line)) continue;
      findings.push({ line: lineNumber + 1, rule });
    }
  }
  return findings;
}

export async function scanFixtureDirectory(directory) {
  const findings = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (ALLOWED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        const content = await readFile(path, "utf8");
        for (const finding of scanFixtureText(content)) findings.push({ file: path, ...finding });
      }
    }
  }
  await visit(directory);
  return findings;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const directory = process.argv[2] ?? new URL("./fixtures", import.meta.url).pathname;
  const findings = await scanFixtureDirectory(directory);
  for (const finding of findings) console.error(`${finding.file}:${finding.line}:${finding.rule}`);
  if (findings.length) process.exitCode = 1;
  else console.log(`Fixture guard: clean (${directory})`);
}
