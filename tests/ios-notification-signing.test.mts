import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { validatePushEnvironment, verifyPushSigning, writePushEntitlements } from "../scripts/ios-notification-signing.mjs";
import { parseArguments } from "../scripts/ios-phone-suite.mjs";

test("push defaults off and explicit requests require matching signed/profile grants for the exact bundle", () => {
  assert.equal(parseArguments([]).options.pushNotifications, null);
  assert.equal(parseArguments(["update", "--push-notifications", "development"]).options.pushNotifications, "development");
  assert.throws(() => validatePushEnvironment("pretend"));
  const base = { requested: "development", signed: "development", provisioned: "development",
    bundleIdentifier: "tech.caseline.vigil.instagram", applicationIdentifier: "12345ABCDE.tech.caseline.vigil.instagram" };
  assert.equal(verifyPushSigning(base), "development");
  for (const override of [{ signed: "" }, { provisioned: "" }, { signed: "production" },
    { applicationIdentifier: "12345ABCDE.*" }, { applicationIdentifier: "12345ABCDE.com.toyopagroup.picaboo" }]) {
    assert.throws(() => verifyPushSigning({ ...base, ...override }));
  }
  assert.equal(verifyPushSigning({ ...base, requested: "off", signed: "" }), "");
  assert.throws(() => verifyPushSigning({ ...base, requested: "off" }));
});
test("optional host entitlements preserve existing capabilities without modifying the free source", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vigil-notification-signing-"));
  try {
    for (const xml of ['<plist><dict/></plist>', '<plist><dict><key>existing</key><true/></dict></plist>']) {
      const base = join(dir, "base.entitlements"), destination = join(dir, "push.entitlements");
      await writeFile(base, xml);
      await writePushEntitlements({ base, destination, environment: "development" });
      assert.equal(await readFile(base, "utf8"), xml);
      const output = await readFile(destination, "utf8");
      assert.match(output, /<key>aps-environment<\/key><string>development<\/string>/u);
      if (xml.includes("existing")) assert.match(output, /<key>existing<\/key><true\/>/u);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
