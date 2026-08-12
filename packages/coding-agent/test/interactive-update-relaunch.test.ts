import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDaemonUpdateRestartReport } from "../src/cli/daemon-update-restart.js";
import {
	buildUpdateChildArgs,
	buildUpdateRelaunchArgs,
	recordInteractiveDaemonRestartStatus,
	resolveInteractiveUpdateDaemonSocketPath,
	updateArgsIncludeSelf,
} from "../src/modes/interactive/interactive-mode.js";

describe("buildUpdateRelaunchArgs", () => {
	it("relaunches the current session with the supported resume flag", () => {
		expect(buildUpdateRelaunchArgs(["--model", "gpt-5"], "/tmp/session.jsonl")).toEqual([
			"--model",
			"gpt-5",
			"--resume",
			"/tmp/session.jsonl",
		]);
	});

	it("keeps an existing resume selection", () => {
		expect(buildUpdateRelaunchArgs(["--resume", "/tmp/other.jsonl"], "/tmp/session.jsonl")).toEqual([
			"--resume",
			"/tmp/other.jsonl",
		]);
	});

	it("does not treat the unsupported session flag as an existing selection", () => {
		expect(buildUpdateRelaunchArgs(["--session", "/tmp/old.jsonl"], "/tmp/session.jsonl")).toEqual([
			"--session",
			"/tmp/old.jsonl",
			"--resume",
			"/tmp/session.jsonl",
		]);
	});
});

describe("buildUpdateChildArgs", () => {
	it("passes the active custom socket to the deferred self-update child", () => {
		expect(buildUpdateChildArgs(["--self", "--force"], "/tmp/custom-daemon.sock")).toEqual([
			"--self",
			"--force",
			"--daemon-socket",
			"/tmp/custom-daemon.sock",
		]);
	});

	it("keeps an explicitly selected update socket", () => {
		expect(buildUpdateChildArgs(["--self", "--daemon-socket", "/tmp/explicit.sock"], "/tmp/active.sock")).toEqual([
			"--self",
			"--daemon-socket",
			"/tmp/explicit.sock",
		]);
		expect(
			resolveInteractiveUpdateDaemonSocketPath(
				["--self", "--daemon-socket", "/tmp/explicit.sock"],
				"/tmp/active.sock",
			),
		).toBe("/tmp/explicit.sock");
		expect(updateArgsIncludeSelf(["--daemon-socket", "/tmp/explicit.sock"])).toBe(true);
	});
});

describe("buildDaemonUpdateRestartReport", () => {
	it("reports recovery results when the daemon restart fails", () => {
		const report = buildDaemonUpdateRestartReport({
			version: 1,
			requestId: "test-request",
			socketPath: "/tmp/custom-daemon.sock",
			phase: "failed",
			coordinator: { pid: process.pid },
			counts: { total: 3, restored: 2, resumed: 1, failed: 1 },
			failures: [{ sessionFile: "/tmp/failed.jsonl", message: "create failed" }],
			message: "could not stop predecessor",
			startedAt: "2026-07-14T00:00:00.000Z",
			updatedAt: "2026-07-14T00:00:01.000Z",
		});

		expect(report.info).toEqual(["Restored 2 daemon sessions", "Resumed 1 interrupted session"]);
		expect(report.warnings).toEqual([
			"Updated, but could not restart the daemon (could not stop predecessor).",
			"1 daemon session could not be restored.",
			"Could not restore /tmp/failed.jsonl: create failed",
		]);
	});
	it("returns failure for a failed parent restart phase and appends it to the shared source log", () => {
		const logPath = join(mkdtempSync(join(tmpdir(), "interactive-update-")), "shared.log");
		writeFileSync(logPath, "[source update] Promoting the validated source\n");
		const result = recordInteractiveDaemonRestartStatus(
			{
				version: 1,
				requestId: "request",
				socketPath: "/tmp/daemon.sock",
				phase: "failed",
				coordinator: { pid: process.pid },
				counts: { total: 0, restored: 0, resumed: 0, failed: 0 },
				failures: [],
				message: "restart failed",
				startedAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-01T00:00:01Z",
			},
			logPath,
		);
		expect(result.failed).toBe(true);
		expect(readFileSync(logPath, "utf8")).toContain("[source update] Promoting the validated source");
		expect(readFileSync(logPath, "utf8")).toContain("Daemon restart result: failed (restart failed)");
	});
});
