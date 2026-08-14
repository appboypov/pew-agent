import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const codingAgent = path.join(repoRoot, "packages/coding-agent");
const reportPath = path.join(repoRoot, "acceptance-tests/reports/remote-custom-ui-probes.json");

const probesByScenario = {
  "Installed extension opens a custom component": [
    "daemon extension binding runs an unchanged worker-owned custom component for a capable client",
  ],
  "Person interacts with the remote component": [
    "daemon extension binding runs an unchanged worker-owned custom component for a capable client",
    "RemoteExtensionCustomUiComponent renders complete worker frames and reports width changes",
    "RemoteExtensionCustomUiComponent forwards raw terminal input without interpreting package keys",
  ],
  "Person cancels the remote component": [
    "daemon extension binding cancels and disposes a worker-owned custom component",
  ],
  "New client attaches to an old daemon": [
    "daemon protocol helpers capability-gates remote extension custom UI for mixed-version peers",
    "DaemonAgentConnection forwards extension UI requests and responses",
  ],
  "Extension requests custom UI without a capable client": [
    "daemon extension binding keeps custom UI unsupported without a capable client",
  ],
  "Observer is attached beside the owning client": [
    "daemon supervisor side-question routing routes a custom component only to its selected owner and cancels it on owner detach",
  ],
  "Owning client disconnects": [
    "daemon supervisor side-question routing routes a custom component only to its selected owner and cancels it on owner detach",
  ],
};

let probeRun;

async function runProbes() {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await rm(reportPath, { force: true });
  const args = [
    "vitest",
    "--run",
    "test/daemon-protocol.test.ts",
    "test/daemon-extension-binding.test.ts",
    "test/agent-connection-daemon.test.ts",
    "test/remote-extension-custom-ui.test.ts",
    "test/daemon-supervisor-side-question.test.ts",
    "--reporter=json",
    `--outputFile=${reportPath}`,
  ];
  const result = await new Promise((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn("npx", args, { cwd: codingAgent, stdio: ["ignore", "pipe", "pipe"], detached });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let forceTimer;
    const signalTree = (signal, includeExitedLeader = false) => {
      if (!child.pid || (!includeExitedLeader && child.exitCode !== null)) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      signalTree("SIGTERM");
      forceTimer = setTimeout(() => signalTree("SIGKILL", true), 5_000);
    }, 120_000);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (forceTimer && !timedOut) clearTimeout(forceTimer);
      resolve({ code: timedOut ? 124 : code, stdout, stderr });
    });
  });
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  if (result.code !== 0 || !report.success) {
    const failures = report.testResults
      .flatMap((suite) => suite.assertionResults)
      .filter((test) => test.status !== "passed")
      .map((test) => `${test.fullName}: ${test.failureMessages.join("\n")}`)
      .join("\n");
    throw new Error(`Remote custom UI probes failed.\n${failures || result.stderr || result.stdout}`);
  }
  return new Map(
    report.testResults
      .flatMap((suite) => suite.assertionResults)
      .map((test) => [test.fullName, test.status]),
  );
}

export class RemoteCustomUiPage {
  async verifyScenario(scenarioName) {
    const required = probesByScenario[scenarioName];
    if (!required) throw new Error(`No remote custom UI probe is mapped for scenario: ${scenarioName}`);
    probeRun ??= runProbes();
    const results = await probeRun;
    for (const probe of required) {
      if (results.get(probe) !== "passed") {
        throw new Error(`Required probe did not pass or was not discovered: ${probe}`);
      }
    }
  }
}
