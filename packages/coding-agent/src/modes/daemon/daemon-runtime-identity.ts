import { resolve } from "node:path";
import { BUILD_ID_ENV, LAUNCHER_PATH_ENV, VERSION } from "../../config.js";
import type { DaemonRuntimeIdentity } from "./daemon-protocol.js";

declare const __PI_BUILD_ID__: string | undefined;

export const DAEMON_BUILD_ID_ENV = BUILD_ID_ENV;
export const DAEMON_LAUNCHER_PATH_ENV = LAUNCHER_PATH_ENV;

function bundledBuildId(): string | undefined {
	return typeof __PI_BUILD_ID__ === "undefined" ? undefined : __PI_BUILD_ID__;
}

export function getDaemonRuntimeIdentity(environment: NodeJS.ProcessEnv = process.env): DaemonRuntimeIdentity {
	const entrypoint = process.argv[1];
	const launcher = environment[DAEMON_LAUNCHER_PATH_ENV];
	return {
		buildId: environment[DAEMON_BUILD_ID_ENV] ?? bundledBuildId() ?? `release-${VERSION}`,
		executablePath: resolve(process.execPath),
		...(entrypoint ? { entrypointPath: resolve(entrypoint) } : {}),
		...(launcher ? { launcherPath: resolve(launcher) } : {}),
	};
}
