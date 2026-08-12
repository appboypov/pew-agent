import { describe, expect, it } from "vitest";
import { BUILD_ID_ENV, INTERNAL_ENV_PREFIX, LAUNCHER_PATH_ENV } from "../src/config.js";
import { isDaemonCatalogProcess } from "../src/modes/daemon/daemon-catalog-process.js";
import { collectDaemonLaunchEnv, DAEMON_PROTOCOL_NAME } from "../src/modes/daemon/daemon-protocol.js";
import { getDaemonRuntimeIdentity } from "../src/modes/daemon/daemon-runtime-identity.js";
import {
	DAEMON_WORKER_ROLE_ENV,
	DAEMON_WORKER_SUPERVISOR_SOCKET_ENV,
	isDaemonWorkerProcess,
} from "../src/modes/daemon/daemon-worker-protocol.js";

describe("Pew cross-runtime isolation", () => {
	it("ignores official Prime Agent internal role and relaunch controls", () => {
		const official = {
			PRIME_AGENT_INTERNAL_DAEMON_WORKER: "1",
			PRIME_AGENT_INTERNAL_DAEMON_CATALOG: "1",
			PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET: "/tmp/prime-agent-501/daemon.sock",
			PRIME_AGENT_LAUNCHER_PATH: "/official/prime-agent",
			PRIME_AGENT_BUILD_ID: "official-build",
		};
		expect(isDaemonWorkerProcess(official)).toBe(false);
		expect(isDaemonCatalogProcess(official)).toBe(false);
		expect(getDaemonRuntimeIdentity(official).launcherPath).toBeUndefined();
		expect(getDaemonRuntimeIdentity(official).buildId).not.toBe("official-build");
	});

	it("uses only Pew control keys and strips both runtime internal prefixes from child launch env", () => {
		expect(INTERNAL_ENV_PREFIX).toBe("PEW_AGENT_INTERNAL_");
		expect(DAEMON_WORKER_ROLE_ENV).toBe("PEW_AGENT_INTERNAL_DAEMON_WORKER");
		expect(DAEMON_WORKER_SUPERVISOR_SOCKET_ENV).toBe("PEW_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET");
		expect(BUILD_ID_ENV).toBe("PEW_AGENT_BUILD_ID");
		expect(LAUNCHER_PATH_ENV).toBe("PEW_AGENT_LAUNCHER_PATH");
		expect(DAEMON_PROTOCOL_NAME).toBe("pew-agent.daemon");
		expect(
			collectDaemonLaunchEnv({
				PATH: "/bin",
				PEW_AGENT_INTERNAL_DAEMON_WORKER: "1",
				PRIME_AGENT_INTERNAL_DAEMON_WORKER: "1",
				PRIME_AGENT_API_KEY: "public-provider-compatibility",
			}),
		).toEqual({ PATH: "/bin", PRIME_AGENT_API_KEY: "public-provider-compatibility" });
	});
});
