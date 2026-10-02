import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const projectRoot = existsSync(join(runtimeRoot, "ios")) ? runtimeRoot
  : existsSync(join(process.cwd(), "ios")) ? process.cwd() : resolve(runtimeRoot, "..", "..");
const source = await readFile(join(projectRoot, "ios/VigilSocial/VigilSocial/DOMAdapters.swift"), "utf8");
const factorySource = source.match(/private static let rootRegistryFactory = #"""\n([\s\S]*?)\n    """#/u)?.[1];
assert.ok(factorySource);

interface Registry extends Iterable<object> {
  add(root: object): Registry;
  has(root: object): boolean;
  forEach(callback: (root: object, key: object, registry: Registry) => void, thisArg?: object): void;
}
class FakeWeakRef {
  static entries: FakeWeakRef[] = [];
  target: object | undefined;
  reads = 0;
  constructor(target: object) { this.target = target; FakeWeakRef.entries.push(this); }
  deref(): object | undefined { this.reads += 1; return this.target; }
}
const createRegistry = runInNewContext(factorySource, {
  WeakRef: FakeWeakRef, FinalizationRegistry: undefined
}) as (initial?: object[]) => Registry;
const alive = { isConnected: false, mode: "closed" };
const discarded = {};
const registry = createRegistry([alive, discarded]);
assert.equal(registry.add(alive), registry);
assert.equal(FakeWeakRef.entries.length, 2, "re-registering a live root must not duplicate weak handles");
assert.deepEqual([...registry], [alive, discarded], "detached roots still owned by the site must remain protected");
const discardedReference = FakeWeakRef.entries[1];
discardedReference.target = undefined; // Deterministically simulate collection.
assert.deepEqual([...registry], [alive]);
const readsAfterPrune = discardedReference.reads;
assert.deepEqual([...registry], [alive]);
assert.equal(discardedReference.reads, readsAfterPrune, "expired weak handles must be removed, not rechecked forever");
alive.isConnected = true;
assert.equal(registry.has(alive), true, "reattached closed roots must retain their registry identity");
const callbackContext = {};
registry.forEach(function (this: object, root, key, owner) {
  assert.equal(this, callbackContext);
  assert.equal(root, alive);
  assert.equal(key, alive);
  assert.equal(owner, registry);
}, callbackContext);

const accumulated = createRegistry();
const dead: FakeWeakRef[] = [];
for (let i = 0; i < 63; i += 1) {
  accumulated.add({});
  const reference = FakeWeakRef.entries.at(-1)!;
  reference.target = undefined;
  dead.push(reference);
}
accumulated.add(alive);
const deadReadCounts = dead.map((reference) => reference.reads);
assert.deepEqual([...accumulated], [alive]);
assert.deepEqual(dead.map((reference) => reference.reads), deadReadCounts,
  "insertion must periodically prune dead wrappers even without finalizers or traversal");

const fallback = runInNewContext(factorySource, { WeakRef: undefined }) as (initial?: object[]) => Registry;
const strong = fallback([alive]);
strong.add(alive);
assert.deepEqual([...strong], [alive], "engines without WeakRef must preserve strong enforcement registration");

// Every shipped protection script must use the weak registry, including the
// expanded-services adapter. Resolve owners so an added declaration cannot be
// missed merely because its registry variable has a new name.
const scriptOwners = [...source.matchAll(/(?:private )?static (?:func|let) ([A-Za-z][A-Za-z0-9]*)/gu)];
const ownerAt = (index: number) => scriptOwners.filter(owner => owner.index! < index).at(-1)?.[1];
const declarations = [...source.matchAll(/const ([A-Za-z][A-Za-z0-9]*) = ROOT_REGISTRY_FACTORY\(([^;]*)\);/gu)];
assert.deepEqual(declarations.map(declaration => [ownerAt(declaration.index!), declaration[1]]), [
  ["contentFilterBootstrap", "protectedRoots"],
  ["earlyMediaGate", "mediaRoots"],
  ["instagramCompatibilityScript", "mediaRoots"],
  ["common", "inspectionRoots"],
  ["focusedSocialAdapter", "closedRoots"]
], "every named safety/compatibility adapter must retain its live shadow roots without owning dead trees");
const installations = [...source.matchAll(/\.replacingOccurrences\(of: "ROOT_REGISTRY_FACTORY", with: rootRegistryFactory\)/gu)];
assert.deepEqual(installations.map(installation => ownerAt(installation.index!)), [
  "contentFilterBootstrap", "earlyMediaGate", "instagramCompatibilityScript", "common", "expandedServiceScript"
], "each registry declaration must be expanded into its actual shipped script");
assert.equal(installations.length, declarations.length);
for (const [declaration, name, initializer] of declarations) {
  const document = {};
  const instance = runInNewContext(`${declaration}\n${name}`, {
    ROOT_REGISTRY_FACTORY: createRegistry, document
  }) as Registry;
  instance.add(alive);
  assert.equal(instance.has(alive), true);
  assert.ok([...instance].includes(alive));
  assert.equal([...instance].includes(document), initializer === "[document]",
    `${name}: preserve each adapter's actual document registration`);
}

// Run the bootstrap's unchanged protection and registration logic against the
// weak registry: a detached but live closed root must keep its observer and be
// rediscovered through the host's WeakMap when attached again.
const protectionStart = source.indexOf("      const protectRoot = (root) => {");
const protectionEnd = source.indexOf("      const signalVisualMutation", protectionStart);
assert.ok(protectionStart >= 0 && protectionEnd > protectionStart);
const protectedRoots = createRegistry();
const hostShadowRoots = new WeakMap<object, object>();
const root = { host: {}, isConnected: false };
let observed = 0;
let safetyChecks = 0;
let notifications = 0;
const register = runInNewContext(`${source.slice(protectionStart, protectionEnd)}\nregisterShadowRoot`, {
  protectedRoots, hostShadowRoots,
  isShadowRoot: (value: unknown) => value === root,
  markVisualPending() {},
  ensureSafetyStyle() { safetyChecks += 1; },
  discoverOpenRoots() {},
  notifyRoot() { notifications += 1; },
  MutationObserver: class { observe() { observed += 1; } }
}) as (root: object) => object;
register(root);
assert.equal(observed, 1);
assert.equal(hostShadowRoots.get(root.host), root);
assert.deepEqual([...protectedRoots], [root]);
root.isConnected = true;
register(hostShadowRoots.get(root.host)!);
assert.equal(observed, 1, "reattachment must reuse protection, not accumulate observers");
assert.equal(safetyChecks, 2, "reattachment must still repair safety styles");
assert.equal(notifications, 2, "all subscribers must still receive reattached closed roots");
