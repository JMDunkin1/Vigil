import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverSuites, runNode, runSuites } from "../scripts/run-tests.mjs";

const fixtureRoot = await mkdtemp(join(tmpdir(), "sentinel-test-runner-"));
try {
  const failedMarker = join(fixtureRoot, "failed-ran.txt");
  const passedMarker = join(fixtureRoot, "passed-ran.txt");
  const failingSuite = join(fixtureRoot, "01-failing.mjs");
  const passingSuite = join(fixtureRoot, "02-passing.mjs");
  const signaledSuite = join(fixtureRoot, "03-signaled.mjs");

  await writeFile(failingSuite, `import { writeFile } from "node:fs/promises";\nawait writeFile(${JSON.stringify(failedMarker)}, "failed");\nprocess.exitCode = 7;\n`);
  await writeFile(passingSuite, `import { writeFile } from "node:fs/promises";\nawait writeFile(${JSON.stringify(passedMarker)}, "passed");\n`);
  await writeFile(signaledSuite, `process.kill(process.pid, "SIGTERM");\n`);

  const log: string[] = [];
  const mixed = await runSuites([failingSuite, passingSuite], {
    cwd: fixtureRoot,
    displayRoot: fixtureRoot,
    stdio: "ignore",
    log: (message) => log.push(message)
  });
  assert.equal(mixed.total, 2);
  assert.equal(mixed.failed, 1);
  assert.equal(mixed.exitCode, 1);
  assert.deepEqual(mixed.results.map((result) => result.code), [7, 0]);
  assert.equal(await readFile(failedMarker, "utf8"), "failed");
  assert.equal(await readFile(passedMarker, "utf8"), "passed", "a failure must not stop later suites");
  assert.equal(log.some((entry) => entry.includes("01-failing.mjs")), true);
  assert.equal(log.some((entry) => entry.includes("02-passing.mjs")), true);

  const signaled = await runSuites([signaledSuite], {
    cwd: fixtureRoot,
    displayRoot: fixtureRoot,
    stdio: "ignore",
    log: () => {}
  });
  assert.equal(signaled.exitCode, 1);
  assert.equal(signaled.results[0]?.code, 1);

  const spawnError = await runSuites([passingSuite], {
    cwd: fixtureRoot,
    displayRoot: fixtureRoot,
    executable: join(fixtureRoot, "missing-node"),
    stdio: "ignore",
    log: () => {}
  });
  assert.equal(spawnError.exitCode, 1);
  assert.equal(spawnError.results[0]?.code, 1);

  assert.equal(await runNode(passingSuite, { cwd: fixtureRoot, stdio: "ignore" }), 0);

  const isolatedDataRoot = join(fixtureRoot, "isolated-data");
  const isolatedEnvMarker = join(fixtureRoot, "isolated-env.txt");
  const isolatedSuite = join(fixtureRoot, "isolated-suite.mjs");
  await writeFile(
    isolatedSuite,
    `import { writeFile } from "node:fs/promises";\nawait writeFile(${JSON.stringify(isolatedEnvMarker)}, process.env.SENTINEL_DATA_DIR || "");\n`
  );
  const isolated = await runSuites([isolatedSuite], {
    cwd: fixtureRoot,
    dataRoot: isolatedDataRoot,
    displayRoot: fixtureRoot,
    stdio: "ignore",
    log: () => {}
  });
  assert.equal(isolated.exitCode, 0);
  assert.equal(await readFile(isolatedEnvMarker, "utf8"), join(isolatedDataRoot, "000"));

  const hangingSuite = join(fixtureRoot, "04-hanging.mjs");
  await writeFile(hangingSuite, "setInterval(() => {}, 1_000);\n");
  assert.equal(await runNode(hangingSuite, {
    cwd: fixtureRoot,
    stdio: "ignore",
    timeoutMs: 25,
    killGraceMs: 25,
    killWaitMs: 25
  }), 1);

  if (process.platform !== "win32") {
    const stubbornSuite = join(fixtureRoot, "05-stubborn-descendant.mjs");
    const stubbornPidMarker = join(fixtureRoot, "stubborn-descendant.pid");
    const stubbornChildCode = [
      'import { writeFileSync } from "node:fs";',
      'process.on("SIGTERM", () => {});',
      'writeFileSync(process.argv[1], String(process.pid));',
      'setInterval(() => {}, 1_000);'
    ].join("\n");
    await writeFile(
      stubbornSuite,
      `import { spawn } from "node:child_process";\nspawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(stubbornChildCode)}, ${JSON.stringify(stubbornPidMarker)}], { stdio: "ignore" });\nsetInterval(() => {}, 1_000);\n`
    );
    assert.equal(await runNode(stubbornSuite, {
      cwd: fixtureRoot,
      stdio: "ignore",
      timeoutMs: 500,
      killGraceMs: 50,
      killWaitMs: 150
    }), 1);
    const stubbornPid = Number(await readFile(stubbornPidMarker, "utf8"));
    try {
      assert.equal(processExists(stubbornPid), false, "timed-out suite descendants must not survive the process-group kill");
    } finally {
      if (processExists(stubbornPid)) process.kill(stubbornPid, "SIGKILL");
    }
  }
  await assert.rejects(runSuites([], { log: () => {} }), /No test suites/);

  const compiledProject = join(fixtureRoot, "compiled-project");
  await mkdir(join(compiledProject, "tests"), { recursive: true });
  await assert.rejects(discoverSuites(compiledProject), /No compiled test suites/);
  await writeFile(join(compiledProject, "tests", "example.test.mjs"), "");
  const discovered = await discoverSuites(compiledProject);
  assert.deepEqual(discovered, [join(compiledProject, "tests", "example.test.mjs")]);

  const directProject = join(fixtureRoot, "direct-project");
  const directPassedMarker = join(directProject, "passed-after-failure.txt");
  await mkdir(join(directProject, "scripts"), { recursive: true });
  await mkdir(join(directProject, "src"), { recursive: true });
  await mkdir(join(directProject, "tests"), { recursive: true });
  await cp(fileURLToPath(new URL("../scripts/run-tests.mjs", import.meta.url)), join(directProject, "scripts", "run-tests.mjs"));
  await cp(fileURLToPath(new URL("../src/directRun.js", import.meta.url)), join(directProject, "src", "directRun.js"));
  await writeFile(join(directProject, "tests", "01-failing.test.mjs"), "process.exitCode = 9;\n");
  await writeFile(
    join(directProject, "tests", "02-passing.test.mjs"),
    `import { writeFile } from "node:fs/promises";\nawait writeFile(${JSON.stringify(directPassedMarker)}, "passed");\n`
  );
  const directExit = await runNode(join(directProject, "scripts", "run-tests.mjs"), {
    cwd: directProject,
    stdio: "ignore"
  });
  assert.equal(directExit, 1, "the direct runner process must exit nonzero when any suite fails");
  assert.equal(await readFile(directPassedMarker, "utf8"), "passed", "the direct runner must continue after a failure");
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
