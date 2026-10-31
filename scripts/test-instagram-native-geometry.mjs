#!/usr/bin/env node
// Runs the production Swift geometry and parsing methods with CoreGraphics'
// CGPoint/CGRect/CGSize. This does not simulate UIKit touch delivery or a keyboard.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(process.argv[2] ? resolve(process.argv[2]) : join(root, 'ios/VigilSocial/VigilSocial/SocialWebViewStore.swift'), 'utf8');
const method = (name, required = true) => {
  const value = source.match(new RegExp(`^    (?:private |nonisolated static )?func ${name}\\([\\s\\S]*?^    }`, 'm'))?.[0];
  if (required) assert.ok(value, `Production method ${name} must be present`);
  return value?.replace('private func', 'func').replace('nonisolated static func', 'static func') || '';
};
const viewport = method('instagramGestureViewport', false);
const geometry = `
import Foundation
import CoreGraphics
struct GeometryView { var bounds: CGRect }
final class GuardGeometry {
  var view: GeometryView? = GeometryView(bounds: CGRect(x:0,y:0,width:390,height:844))
  var viewportSize: CGSize? = CGSize(width:390,height:844)
  var scrollingRegions: [CGRect] = [CGRect(x:0,y:300.0/844,width:1,height:60.0/844)]
  var carouselRegions: [CGRect] = []
  var isEnabled = true
${method('normalizedPoint')}
${method('blocksPan')}
}
enum Bridge {
${method('instagramGestureRegions')}
${viewport}
}
var checks = 0
func check(_ value: Bool, _ label: String) {
  guard value else { print("FAIL " + label); exit(1) }
  checks += 1
  print("PASS " + label)
}
let guardGeometry = GuardGeometry()
check(!guardGeometry.blocksPan(from:CGPoint(x:100,y:320),translation:CGPoint(x:0,y:-30)), "Input touch uses the original CSS coordinate space")
guardGeometry.view?.bounds.size.height = 500
check(!guardGeometry.blocksPan(from:CGPoint(x:100,y:320),translation:CGPoint(x:0,y:-30)), "New input touch remains allowed after native height shrinks")
check(guardGeometry.blocksPan(from:CGPoint(x:100,y:200),translation:CGPoint(x:0,y:-30)), "Height changes cannot shift the exception onto background Reels")
guardGeometry.view?.bounds.size.width = 195
check(!guardGeometry.blocksPan(from:CGPoint(x:50,y:160),translation:CGPoint(x:0,y:-30)), "Both axes use width-derived CSS scale")
check(guardGeometry.blocksPan(from:CGPoint(x:50,y:100),translation:CGPoint(x:0,y:-30)), "Width changes retain background containment")
guardGeometry.scrollingRegions = []
guardGeometry.carouselRegions = [CGRect(x:0,y:300.0/844,width:1,height:60.0/844)]
check(!guardGeometry.blocksPan(from:CGPoint(x:50,y:160),translation:CGPoint(x:-30,y:0)), "Selected post carousel keeps horizontal panning")
check(guardGeometry.blocksPan(from:CGPoint(x:50,y:160),translation:CGPoint(x:0,y:-30)), "Selected post carousel keeps vertical containment")
guardGeometry.isEnabled = false
check(!guardGeometry.blocksPan(from:CGPoint(x:50,y:100),translation:CGPoint(x:0,y:-30)), "Unlocked chat remains scrollable")
check(Bridge.instagramGestureRegions([[0.0,0.0,1.0,1.0]]).count == 1, "Valid normalized region survives bridge parsing")
for value in [[[0.0,Double.nan,1.0,1.0]],[[0.0,0.0,-1.0,1.0]],[[0.0,0.0,1.0]]] {
  check(Bridge.instagramGestureRegions(value).isEmpty, "Malformed region is rejected")
}
${viewport ? `
check(Bridge.instagramGestureViewport([390.0,844.0]) == CGSize(width:390,height:844), "Valid viewport survives bridge parsing")
for value in [[0.0,844.0],[390.0,Double.nan],[Double.infinity,844.0],[390.0],[390.0,20000.0]] {
  check(Bridge.instagramGestureViewport(value) == nil, "Malformed viewport is rejected")
}
let json = try JSONSerialization.jsonObject(with: Data("[390,844]".utf8))
check(Bridge.instagramGestureViewport(json) == CGSize(width:390,height:844), "WK-style JSON number bridge retains viewport dimensions")
` : ''}
print("VIGIL_INSTAGRAM_NATIVE_GEOMETRY_COMPLETE: \\(checks) checks")
`;
const directory = await mkdtemp(join(tmpdir(), 'vigil-instagram-geometry-'));
try {
  await writeFile(join(directory, 'main.swift'), geometry);
  await run('xcrun', ['swiftc', join(directory, 'main.swift'), '-o', join(directory, 'geometry')], {timeout: 60000});
  const result = await run(join(directory, 'geometry'), [], {timeout: 10000});
  process.stdout.write(result.stdout);
  assert.ok(result.stdout.includes('VIGIL_INSTAGRAM_NATIVE_GEOMETRY_COMPLETE:'));
  await rm(directory, {recursive: true, force: true});
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  process.stderr.write(`Geometry artifacts retained at ${directory}\n`);
  throw error;
}
