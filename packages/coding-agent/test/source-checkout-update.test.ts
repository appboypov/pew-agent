import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildPtyCommand,
	detectSourceCheckoutSelfUpdate,
	promoteDirectoriesAtomically,
	recoverPromotionJournal,
	runSourceCheckoutSelfUpdate,
	type SourceCheckoutSelfUpdate,
	type SourceCheckoutUpdateRuntime,
	SourceUpdateCrashInjection,
} from "../src/cli/source-checkout-update.js";

interface Invocation {
	command: string;
	args: readonly string[];
}

function makeCheckout(): { root: string; checkout: SourceCheckoutSelfUpdate } {
	const root = join(tmpdir(), `source-update-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(root, ".git"), { recursive: true });
	mkdirSync(join(root, "node_modules"), { recursive: true });
	mkdirSync(join(root, "packages", "coding-agent", "dist", "bundle"), { recursive: true });
	mkdirSync(join(root, "packages", "coding-agent", "src"), { recursive: true });
	writeFileSync(join(root, "package.json"), "{}\n");
	writeFileSync(join(root, "package-lock.json"), "{}\n");
	writeFileSync(join(root, "node_modules", ".package-lock.json"), "{}\n");
	const launcherPath = join(root, "prime-agent.sh");
	const oldBundlePath = join(root, "packages", "coding-agent", "dist", "bundle", "cli.js");
	writeFileSync(launcherPath, "#!/bin/sh\n");
	writeFileSync(oldBundlePath, "console.log('old')\n");
	const oldBundleProvenancePath = join(root, "packages", "coding-agent", "dist", "bundle", "build-id");
	writeFileSync(oldBundleProvenancePath, "old-head\n");
	return { root, checkout: { repoRoot: root, launcherPath, oldBundlePath, oldBundleProvenancePath } };
}

function scriptedRuntime(options: { conflict?: boolean; dirty?: boolean } = {}): {
	runtime: SourceCheckoutUpdateRuntime;
	runs: Invocation[];
	logs: string[];
} {
	const runs: Invocation[] = [];
	const logs: string[] = [];
	let unresolvedReads = 0;
	return {
		runs,
		logs,
		runtime: {
			async capture(command, args, cwd) {
				const key = `${command} ${args.join(" ")}`;
				if (key === "git status --porcelain=v1 --untracked-files=all") return options.dirty ? " M local.ts\n" : "";
				if (key === "git branch --show-current") return "main\n";
				if (key === "git rev-parse HEAD") return cwd.includes("pew-update-") ? "new-head\n" : "old-head\n";
				if (key === "git describe --tags --always") return "old-head\n";
				if (key === "git diff --name-only --diff-filter=U") {
					return unresolvedReads++ === 0 ? "packages/coding-agent/src/conflict.ts\n" : "";
				}
				if (key === "git diff --cached --name-only") return "packages/coding-agent/src/conflict.ts\n";
				if (key === "git ls-files --stage") return "100644 abc 0\tstable.ts\n";
				if (key === "git diff --raw") return "";
				if (key === "git ls-files --others --exclude-standard") return "";
				throw new Error(`Unexpected capture: ${key}`);
			},
			async run(command, args) {
				runs.push({ command, args: [...args] });
				if (options.conflict && command === "git" && args[0] === "merge" && args[1] === "--no-edit") {
					throw new Error("merge conflict");
				}
			},
			log(message) {
				logs.push(message);
			},
			async promote() {
				return {
					commit() {
						return { retainedBackups: [], cleanupFailures: [] };
					},
					rollback() {},
				};
			},
		},
	};
}

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("source checkout self update", () => {
	it("detects only a launcher and entrypoint inside the same source checkout", () => {
		const { root, checkout } = makeCheckout();
		roots.push(root);
		const entrypoint = join(root, "packages", "coding-agent", "src", "cli.ts");
		writeFileSync(entrypoint, "");
		const detected = detectSourceCheckoutSelfUpdate({ PEW_AGENT_LAUNCHER_PATH: checkout.launcherPath }, entrypoint);
		expect(detected).toEqual({
			repoRoot: realpathSync(root),
			launcherPath: realpathSync(checkout.launcherPath),
			oldBundlePath: join(realpathSync(root), "packages", "coding-agent", "dist", "bundle", "cli.js"),
			oldBundleProvenancePath: join(realpathSync(root), "packages", "coding-agent", "dist", "bundle", "build-id"),
		});
		expect(
			detectSourceCheckoutSelfUpdate({ PEW_AGENT_LAUNCHER_PATH: checkout.launcherPath }, __filename),
		).toBeUndefined();
	});

	it("fetches origin/main, checks, builds workspaces in dependency order, and verifies the dist launcher", async () => {
		const { root, checkout } = makeCheckout();
		roots.push(root);
		const { runtime, runs, logs } = scriptedRuntime();
		const result = await runSourceCheckoutSelfUpdate(checkout, { runtime });
		expect(result).toMatchObject({ changed: true, previousHead: "old-head", currentHead: "new-head" });
		expect(result.logPath).toContain(join(root, ".git", "pew-update-logs"));
		expect(runs).toContainEqual({
			command: "git",
			args: ["fetch", "--prune", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main"],
		});
		expect(runs).toContainEqual({
			command: "git",
			args: ["worktree", "add", "--detach", expect.any(String), "old-head"],
		});
		expect(runs).toContainEqual({ command: "git", args: ["merge", "--ff-only", "new-head"] });
		expect(runs.filter((run) => run.command === "npm" && run.args.join(" ") === "run check")).toHaveLength(1);
		expect(logs).toContain("[source update] Fetching origin/main");
		expect(logs.some((line) => line.includes("Debug log:"))).toBe(true);
		expect(runs.some((run) => run.command === "npm" && run.args.join(" ") === "run build")).toBe(false);
	});

	it("uses the old dist in the foreground for exact conflicts and completes only after they are staged", async () => {
		const { root, checkout } = makeCheckout();
		roots.push(root);
		const { runtime, runs } = scriptedRuntime({ conflict: true });
		await runSourceCheckoutSelfUpdate(checkout, { runtime });
		const resolver = runs.find((run) => run.command === "script" && run.args.includes(checkout.launcherPath));
		expect(resolver?.args.slice(0, 3)).toEqual(["-q", "/dev/null", checkout.launcherPath]);
		expect(resolver?.args).toContain("--dist");
		expect(resolver?.args).toContain("--cwd");
		expect(resolver?.args.at(-1)).toContain("packages/coding-agent/src/conflict.ts");
		expect(runs).toContainEqual({ command: "git", args: ["diff", "--check"] });
		expect(runs).toContainEqual({
			command: "git",
			args: ["-c", "core.editor=true", "merge", "--continue"],
		});
	});

	it("constructs safe Darwin and Linux PTY commands", () => {
		expect(buildPtyCommand("/tmp/Prime Agent", ["say 'hello'"], "darwin")).toEqual({
			command: "script",
			args: ["-q", "/dev/null", "/tmp/Prime Agent", "say 'hello'"],
		});
		const linux = buildPtyCommand("/tmp/Prime Agent", ["say 'hello'"], "linux");
		expect(linux.command).toBe("script");
		expect(linux.args).toEqual(["-q", "-c", "'/tmp/Prime Agent' 'say '\"'\"'hello'\"'\"''", "/dev/null"]);
	});

	for (const crashState of [
		"backup-intent",
		"after-backup-rename",
		"backed-up",
		"install-intent",
		"after-install-rename",
		"installed",
	] as const) {
		it(`recovers real filesystem after crash at ${crashState}`, async () => {
			const root = join(tmpdir(), `transition-${crashState}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
			roots.push(root);
			const source = join(root, "source");
			const destination = join(root, "packages", "tui", "dist");
			mkdirSync(source, { recursive: true });
			mkdirSync(destination, { recursive: true });
			writeFileSync(join(source, "new.txt"), "new");
			writeFileSync(join(destination, "old.txt"), "old");
			const journalPath = join(root, "journal.json");
			const logPath = join(root, "log");
			writeFileSync(logPath, "");
			await expect(
				promoteDirectoriesAtomically(
					[{ source, destination }],
					{
						async capture() {
							return "";
						},
						async run() {},
						log() {},
					},
					logPath,
					journalPath,
					{ repoRoot: root, previousHead: "old", candidateHead: "new" },
					(state) => {
						if (state === crashState) throw new SourceUpdateCrashInjection(state);
					},
				),
			).rejects.toThrow(SourceUpdateCrashInjection);
			expect(existsSync(journalPath)).toBe(true);
			recoverPromotionJournal(journalPath, logPath, root, "old");
			expect(readFileSync(join(destination, "old.txt"), "utf8")).toBe("old");
			expect(existsSync(join(destination, "new.txt"))).toBe(false);
		});
	}

	for (const crashState of [
		"rollback-remove-intent",
		"after-rollback-remove",
		"rollback-removed",
		"rollback-restore-intent",
		"after-rollback-restore",
		"restored",
	] as const) {
		it(`retries recovery after crash at ${crashState}`, async () => {
			const root = join(tmpdir(), `recovery-${crashState}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
			roots.push(root);
			const source = join(root, "source");
			const destination = join(root, "packages", "tui", "dist");
			mkdirSync(source, { recursive: true });
			mkdirSync(destination, { recursive: true });
			writeFileSync(join(source, "new.txt"), "new");
			writeFileSync(join(destination, "old.txt"), "old");
			const journalPath = join(root, "journal.json");
			const logPath = join(root, "log");
			writeFileSync(logPath, "");
			await expect(
				promoteDirectoriesAtomically(
					[{ source, destination }],
					{
						async capture() {
							return "";
						},
						async run() {},
						log() {},
					},
					logPath,
					journalPath,
					{ repoRoot: root, previousHead: "old", candidateHead: "new" },
					(state) => {
						if (state === "installed") throw new SourceUpdateCrashInjection(state);
					},
				),
			).rejects.toThrow();
			expect(() =>
				recoverPromotionJournal(journalPath, logPath, root, "old", (state) => {
					if (state === crashState) throw new SourceUpdateCrashInjection(state);
				}),
			).toThrow(SourceUpdateCrashInjection);
			recoverPromotionJournal(journalPath, logPath, root, "old");
			expect(readFileSync(join(destination, "old.txt"), "utf8")).toBe("old");
			expect(existsSync(journalPath)).toBe(false);
		});
	}

	it("completes candidate HEAD cleanup and refuses third HEAD", async () => {
		const root = join(tmpdir(), `head-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		roots.push(root);
		const source = join(root, "source");
		const destination = join(root, "packages", "tui", "dist");
		mkdirSync(source, { recursive: true });
		mkdirSync(destination, { recursive: true });
		writeFileSync(join(source, "new"), "new");
		writeFileSync(join(destination, "old"), "old");
		const journalPath = join(root, "journal.json");
		const logPath = join(root, "log");
		writeFileSync(logPath, "");
		await promoteDirectoriesAtomically(
			[{ source, destination }],
			{
				async capture() {
					return "";
				},
				async run() {},
				log() {},
			},
			logPath,
			journalPath,
			{ repoRoot: root, previousHead: "old", candidateHead: "new" },
		);
		expect(() => recoverPromotionJournal(journalPath, logPath, root, "third")).toThrow("neither journal head");
		recoverPromotionJournal(journalPath, logPath, root, "new");
		expect(readFileSync(join(destination, "new"), "utf8")).toBe("new");
		expect(existsSync(journalPath)).toBe(false);
	});

	it("refuses duplicate and exact in-repository nonallowlisted journal destinations", () => {
		const root = join(tmpdir(), `journal-path-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		roots.push(root);
		mkdirSync(root);
		const logPath = join(root, "log");
		const journalPath = join(root, "journal");
		writeFileSync(logPath, "");
		const makeEntry = (destination: string) => ({
			destination,
			next: `${destination}.pew-update-next-00000000-0000-4000-8000-000000000000`,
			backup: `${destination}.pew-update-backup-00000000-0000-4000-8000-000000000000`,
			hadOriginal: true,
			state: "installed",
		});
		const base = { version: 2, repoRoot: root, previousHead: "old", candidateHead: "new", state: "preparing" };
		writeFileSync(journalPath, JSON.stringify({ ...base, entries: [makeEntry(join(root, "other"))] }));
		expect(() => recoverPromotionJournal(journalPath, logPath, root, "old")).toThrow("invalid, duplicate");
		const allowed = makeEntry(join(root, "packages", "tui", "dist"));
		writeFileSync(journalPath, JSON.stringify({ ...base, entries: [allowed, allowed] }));
		expect(() => recoverPromotionJournal(journalPath, logPath, root, "old")).toThrow("invalid, duplicate");
	});

	it("replays install-intent recovery idempotently without deleting a restored destination", () => {
		const root = join(tmpdir(), `intent-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		roots.push(root);
		const destination = join(root, "packages", "tui", "dist");
		const next = `${destination}.pew-update-next-00000000-0000-4000-8000-000000000000`;
		const backup = `${destination}.pew-update-backup-00000000-0000-4000-8000-000000000000`;
		mkdirSync(destination, { recursive: true });
		writeFileSync(join(destination, "new.txt"), "new");
		mkdirSync(backup, { recursive: true });
		writeFileSync(join(backup, "old.txt"), "old");
		const journalPath = join(root, "journal.json");
		const logPath = join(root, "log.txt");
		writeFileSync(logPath, "");
		const journal = {
			version: 2,
			repoRoot: root,
			previousHead: "old",
			candidateHead: "new",
			state: "preparing",
			entries: [{ destination, next, backup, hadOriginal: true, state: "install-intent" }],
		};
		writeFileSync(journalPath, JSON.stringify(journal));
		recoverPromotionJournal(journalPath, logPath, root, "old");
		expect(readFileSync(join(destination, "old.txt"), "utf8")).toBe("old");
		writeFileSync(
			journalPath,
			JSON.stringify({ ...journal, entries: [{ ...journal.entries[0], state: "restored" }] }),
		);
		expect(() => recoverPromotionJournal(journalPath, logPath, root, "old")).not.toThrow();
		expect(readFileSync(join(destination, "old.txt"), "utf8")).toBe("old");
	});

	it("recovers a journaled interrupted swap and refuses corrupted or escaping journals", async () => {
		const root = join(tmpdir(), `journal-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		roots.push(root);
		const source = join(root, "source");
		const destination = join(root, "packages", "tui", "dist");
		mkdirSync(source, { recursive: true });
		mkdirSync(destination, { recursive: true });
		writeFileSync(join(source, "new.txt"), "new");
		writeFileSync(join(destination, "old.txt"), "old");
		const journalPath = join(root, "journal.json");
		const logPath = join(root, "log.txt");
		writeFileSync(logPath, "");
		await promoteDirectoriesAtomically(
			[{ source, destination }],
			{
				async capture() {
					return "";
				},
				async run() {},
				log() {},
			},
			logPath,
			journalPath,
			{ repoRoot: root, previousHead: "old", candidateHead: "new" },
		);
		expect(JSON.parse(readFileSync(journalPath, "utf8")).state).toBe("artifacts-installed");
		recoverPromotionJournal(journalPath, logPath, root, "old");
		expect(existsSync(join(destination, "old.txt"))).toBe(true);
		expect(existsSync(join(destination, "new.txt"))).toBe(false);
		expect(existsSync(journalPath)).toBe(false);
		writeFileSync(journalPath, "not-json");
		expect(() => recoverPromotionJournal(journalPath, logPath, root, "old")).toThrow("corrupt");
		writeFileSync(
			journalPath,
			JSON.stringify({
				version: 2,
				repoRoot: root,
				previousHead: "old",
				candidateHead: "new",
				state: "preparing",
				entries: [
					{
						destination: "/tmp/escape",
						next: "/tmp/escape.pew-update-next-x",
						backup: "/tmp/escape.pew-update-backup-x",
						hadOriginal: true,
						state: "installed",
					},
				],
			}),
		);
		expect(() => recoverPromotionJournal(journalPath, logPath, root, "old")).toThrow("out-of-repository");
	});

	it("atomically replaces directories, removes stale artifacts, and rolls back until committed", async () => {
		const root = join(tmpdir(), `promotion-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		roots.push(root);
		const source = join(root, "source");
		const destination = join(root, "destination");
		mkdirSync(source, { recursive: true });
		mkdirSync(destination, { recursive: true });
		writeFileSync(join(source, "new.txt"), "new");
		writeFileSync(join(destination, "stale.txt"), "stale");
		const logPath = join(root, "update.log");
		writeFileSync(logPath, "");
		const transaction = await promoteDirectoriesAtomically(
			[{ source, destination }],
			{
				async capture() {
					return "";
				},
				async run() {},
				log() {},
			},
			logPath,
		);
		expect(existsSync(join(destination, "new.txt"))).toBe(true);
		expect(existsSync(join(destination, "stale.txt"))).toBe(false);
		transaction.rollback();
		expect(existsSync(join(destination, "stale.txt"))).toBe(true);
		expect(existsSync(join(destination, "new.txt"))).toBe(false);
	});

	it("refuses a competing repo lock and immediately releases dirty wrong-branch and provenance preflight failures", async () => {
		for (const failure of ["dirty", "wrong-branch", "provenance"] as const) {
			const { root, checkout } = makeCheckout();
			roots.push(root);
			const lockPath = join(root, ".git", "pew-update.lock");
			writeFileSync(lockPath, "");
			const release = await lockfile.lock(lockPath, { realpath: false });
			const contention = scriptedRuntime();
			await expect(runSourceCheckoutSelfUpdate(checkout, { runtime: contention.runtime })).rejects.toThrow(
				"already running",
			);
			await release();
			const failing = scriptedRuntime({ dirty: failure === "dirty" });
			if (failure === "wrong-branch") {
				const capture = failing.runtime.capture;
				failing.runtime.capture = async (command, args, cwd) =>
					command === "git" && args[0] === "branch" ? "feature\n" : capture(command, args, cwd);
			}
			if (failure === "provenance") writeFileSync(checkout.oldBundleProvenancePath, "another-head\n");
			await expect(runSourceCheckoutSelfUpdate(checkout, { runtime: failing.runtime })).rejects.toThrow();
			const releaseAgain = await lockfile.lock(lockPath, { realpath: false, retries: 0 });
			await releaseAgain();
		}
	});

	it("rolls artifact transaction back when final ff-only promotion fails", async () => {
		const { root, checkout } = makeCheckout();
		roots.push(root);
		const scripted = scriptedRuntime();
		let rolledBack = false;
		let committed = false;
		const originalRun = scripted.runtime.run;
		scripted.runtime.run = async (command, args, cwd, logPath) => {
			if (command === "git" && args[0] === "merge" && args[1] === "--ff-only") throw new Error("ff failed");
			await originalRun(command, args, cwd, logPath);
		};
		scripted.runtime.promote = async () => ({
			commit() {
				committed = true;
				return { retainedBackups: [], cleanupFailures: [] };
			},
			rollback() {
				rolledBack = true;
			},
		});
		await expect(runSourceCheckoutSelfUpdate(checkout, { runtime: scripted.runtime })).rejects.toThrow("ff failed");
		expect(rolledBack).toBe(true);
		expect(committed).toBe(false);
	});

	it("succeeds and reports retained recovery paths when backup cleanup fails", async () => {
		const { root, checkout } = makeCheckout();
		roots.push(root);
		const scripted = scriptedRuntime();
		let rolledBack = false;
		scripted.runtime.promote = async () => ({
			commit() {
				return { retainedBackups: ["/recovery/backup"], cleanupFailures: ["permission denied"] };
			},
			rollback() {
				rolledBack = true;
			},
		});
		const result = await runSourceCheckoutSelfUpdate(checkout, { runtime: scripted.runtime });
		expect(result.changed).toBe(true);
		expect(rolledBack).toBe(false);
		expect(scripted.logs.join("\n")).toContain("Retained recovery paths");
		expect(readFileSync(result.logPath, "utf8")).toContain("/recovery/backup");
	});

	it("refuses to fetch when the checkout is dirty", async () => {
		const { root, checkout } = makeCheckout();
		roots.push(root);
		const { runtime, runs } = scriptedRuntime({ dirty: true });
		await expect(runSourceCheckoutSelfUpdate(checkout, { runtime })).rejects.toThrow("Source checkout is not clean");
		expect(runs).toEqual([]);
	});
});

describe("source checkout updater integration", () => {
	function git(cwd: string, args: string[]): string {
		const result = spawnSync("git", args, { cwd, encoding: "utf8" });
		if (result.status !== 0) throw new Error(result.stderr);
		return result.stdout.trim();
	}

	it("keeps live HEAD and status unchanged when staged validation fails and writes command output to the debug log", async () => {
		const root = join(tmpdir(), `source-update-integration-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const remote = join(root, "remote.git");
		const seed = join(root, "seed");
		const live = join(root, "live");
		roots.push(root);
		mkdirSync(root, { recursive: true });
		git(root, ["init", "--bare", remote]);
		mkdirSync(seed);
		git(seed, ["init", "--initial-branch=main"]);
		git(seed, ["config", "user.email", "test@example.com"]);
		git(seed, ["config", "user.name", "Test"]);
		writeFileSync(
			join(seed, "package.json"),
			`${JSON.stringify({ scripts: { check: "node -e 'console.log(\"validation output\");process.exit(7)'" } })}\n`,
		);
		writeFileSync(join(seed, "package-lock.json"), '{"name":"fixture","lockfileVersion":3,"packages":{}}\n');
		mkdirSync(join(seed, "packages", "coding-agent", "dist", "bundle"), { recursive: true });
		writeFileSync(join(seed, "packages", "coding-agent", "dist", "bundle", "cli.js"), 'console.log("old bundle")\n');
		writeFileSync(join(seed, "packages", "coding-agent", "dist", "bundle", "build-id"), "fixture\n");
		writeFileSync(
			join(seed, "prime-agent.sh"),
			'#!/bin/sh\nexec node "$(dirname "$0")/packages/coding-agent/dist/bundle/cli.js" "$@"\n',
			{ mode: 0o755 },
		);
		git(seed, [
			"add",
			"package.json",
			"package-lock.json",
			"packages/coding-agent/dist/bundle/cli.js",
			"packages/coding-agent/dist/bundle/build-id",
			"prime-agent.sh",
		]);
		git(seed, ["commit", "-m", "initial"]);
		git(seed, ["remote", "add", "origin", remote]);
		git(seed, ["push", "-u", "origin", "main"]);
		git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
		git(root, ["clone", remote, live]);
		git(live, ["config", "user.email", "test@example.com"]);
		git(live, ["config", "user.name", "Test"]);
		const initialBuildId = git(live, ["describe", "--tags", "--always"]);
		writeFileSync(join(live, "packages", "coding-agent", "dist", "bundle", "build-id"), `${initialBuildId}\n`);
		git(live, ["update-index", "--assume-unchanged", "packages/coding-agent/dist/bundle/build-id"]);
		writeFileSync(join(seed, "upstream.txt"), "new\n");
		git(seed, ["add", "upstream.txt"]);
		git(seed, ["commit", "-m", "upstream"]);
		git(seed, ["push"]);
		const beforeHead = git(live, ["rev-parse", "HEAD"]);
		const checkout = {
			repoRoot: live,
			launcherPath: join(live, "prime-agent.sh"),
			oldBundlePath: join(live, "packages", "coding-agent", "dist", "bundle", "cli.js"),
			oldBundleProvenancePath: join(live, "packages", "coding-agent", "dist", "bundle", "build-id"),
		};
		expect(git(live, ["status", "--porcelain"])).toBe("");
		let error: Error | undefined;
		try {
			await runSourceCheckoutSelfUpdate(checkout);
		} catch (caught) {
			error = caught as Error;
		}
		expect(error?.message).toContain("debug log:");
		expect(git(live, ["rev-parse", "HEAD"])).toBe(beforeHead);
		expect(git(live, ["status", "--porcelain"])).toBe("");
		const logPath = error?.message.match(/debug log: (.+)\)$/)?.[1];
		expect(logPath).toBeTruthy();
		expect(readFileSync(logPath!, "utf8")).toContain("validation output");
		expect(readFileSync(logPath!, "utf8")).toContain("npm run check");
	});
});
