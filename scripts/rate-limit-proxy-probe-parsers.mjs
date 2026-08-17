function fail(code) {
  process.exit(code);
}

function requiredText(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) fail(2);
  return value;
}

function parseObject(name) {
  let value;
  try {
    value = JSON.parse(requiredText(name));
  } catch {
    fail(2);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(2);
  return value;
}

function matchingTagEntries() {
  const service = parseObject("SERVICE_JSON");
  const tag = requiredText("TAG_TO_FIND");
  const traffic = service?.status?.traffic;
  if (!Array.isArray(traffic)) fail(3);
  return traffic.filter((entry) => entry?.tag === tag);
}

function tagState() {
  const matches = matchingTagEntries();
  if (matches.length === 0) {
    process.stdout.write("absent\n");
    return;
  }
  if (matches.length !== 1) fail(4);
  const revision = matches[0]?.revisionName;
  if (typeof revision !== "string" || revision.length === 0) fail(4);
  process.stdout.write(`${revision}\n`);
}

function ownedTag() {
  const expectedRevision = requiredText("EXPECTED_REVISION");
  const expectedImage = requiredText("EXPECTED_IMAGE_REF");
  if (!/@sha256:[0-9a-f]{64}$/u.test(expectedImage)) fail(2);

  const matches = matchingTagEntries();
  if (
    matches.length !== 1 ||
    matches[0]?.revisionName !== expectedRevision
  ) fail(4);

  const revision = parseObject("REVISION_JSON");
  if (revision?.metadata?.name !== expectedRevision) fail(5);
  const containers = revision?.spec?.containers;
  if (!Array.isArray(containers) || containers.length !== 1) fail(5);
  if (containers[0]?.image !== expectedImage) fail(5);
  process.stdout.write("owned\n");
}

const command = process.argv[2];
if (command === "tag-state") {
  tagState();
} else if (command === "owned-tag") {
  ownedTag();
} else {
  fail(64);
}
