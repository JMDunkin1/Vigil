import assert from "node:assert/strict";
import { parsePlist, plistStringForKey } from "../src/plist.js";

const parsed = parsePlist("<plist version=\"1.0\"><dict><!-- <key>fake</key><string>bad</string> --><key>real</key><string>ok</string></dict></plist>") as Record<string, unknown>;
assert.equal(Object.getPrototypeOf(parsed), null);
assert.equal(parsed.real, "ok");
assert.equal((parsePlist("<dict><key>x</key><string>&amp;#84;okenUpdate</string></dict>") as Record<string, unknown>).x, "&#84;okenUpdate");
assert.equal((parsePlist("<dict><key>x</key><string>&#84;okenUpdate</string></dict>") as Record<string, unknown>).x, "TokenUpdate");
assert.throws(() => parsePlist("<dict><key>x</key><string>one</string><key>x</key><string>two</string></dict>"), /Duplicate/u);
assert.throws(() => plistStringForKey("<dict><key>a</key><dict><key>x</key><string>one</string></dict><key>b</key><dict><key>x</key><string>two</string></dict></dict>", "x"), /Ambiguous/u);
assert.throws(() => parsePlist("<!DOCTYPE plist [<!ENTITY xxe SYSTEM \"file:///etc/passwd\">]><plist><dict><key>x</key><string>&xxe;</string></dict></plist>"), /entities/u);
assert.throws(() => parsePlist("<plist><dict><key>x</key><string>missing close</dict></plist>"), /nested markup|closed/u);
assert.throws(() => parsePlist(`<dict><key>x</key><string>${"a".repeat(1024 * 1024)}</string></dict>`), /1 MiB/u);
for (const key of ["__proto__", "prototype", "constructor"]) {
  assert.throws(() => parsePlist(`<dict><key>${key}</key><dict><key>polluted</key><true/></dict></dict>`), /Forbidden/u);
}
assert.equal(({} as { polluted?: boolean }).polluted, undefined, "parsing must not mutate Object.prototype");
assert.throws(() => parsePlist("<dict><key>x</key><true></true></dict>"), /self-closing/u);
assert.throws(() => parsePlist("<dict><key>x</key><integer>9007199254740992</integer></dict>"), /safe integer/u);
assert.throws(() => parsePlist("<dict><key>x</key><real>1e999</real></dict>"), /finite/u);
assert.throws(() => parsePlist("<dict><key>x</key><date>2026-99-99T00:00:00Z</date></dict>"), /date/u);
assert.throws(() => parsePlist("<dict><key>x</key><date>2026-02-30T00:00:00Z</date></dict>"), /date/u);
assert.throws(() => parsePlist("<dict><key>x</key><date>2025-02-29T00:00:00Z</date></dict>"), /date/u);
assert.equal((parsePlist("<dict><key>x</key><date>2024-02-29T00:00:00Z</date></dict>") as Record<string, unknown>).x, "2024-02-29T00:00:00Z");
assert.throws(() => parsePlist(`<dict>${"<key>x</key><array>".repeat(70)}${"</array>".repeat(70)}</dict>`), /depth/u);
