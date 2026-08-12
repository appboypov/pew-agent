import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	cpSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import lockfile from "proper-lockfile";

export interface SourceCheckoutSelfUpdate {
	repoRoot: string;
	launcherPath: string;
	oldBundlePath: string;
	oldBundleProvenancePath: string;
}

export interface SourceCheckoutUpdateResult {
	changed: boolean;
	previousHead: string;
	currentHead: string;
	logPath: string;
}

export interface SourceCheckoutUpdateRuntime {
	capture(command: string, args: readonly string[], cwd: string): Promise<string>;
	run(command: string, args: readonly string[], cwd: string, logPath: string): Promise<void>;
	log(message: string): void;
	promote?(
		targets: Array<{ source: string; destination: string }>,
		logPath: string,
	): Promise<DirectoryPromotionTransaction>;
}

function isWithin(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function detectSourceCheckoutSelfUpdate(
	environment: NodeJS.ProcessEnv = process.env,
	entrypoint = process.argv[1],
): SourceCheckoutSelfUpdate | undefined {
	const configuredLauncher = environment.PRIME_AGENT_LAUNCHER_PATH;
	if (!configuredLauncher || !entrypoint) return undefined;
	let launcherPath: string;
	let resolvedEntrypoint: string;
	try {
		launcherPath = realpathSync(resolve(configuredLauncher));
		resolvedEntrypoint = realpathSync(resolve(entrypoint));
	} catch {
		return undefined;
	}
	if (basename(launcherPath) !== "prime-agent.sh") return undefined;
	const repoRoot = dirname(launcherPath);
	if (!existsSync(join(repoRoot, ".git")) || !existsSync(join(repoRoot, "package.json"))) return undefined;
	if (!isWithin(repoRoot, resolvedEntrypoint)) return undefined;
	return {
		repoRoot,
		launcherPath,
		oldBundlePath: join(repoRoot, "packages", "coding-agent", "dist", "bundle", "cli.js"),
		oldBundleProvenancePath: join(repoRoot, "packages", "coding-agent", "dist", "bundle", "build-id"),
	};
}

function quote(value: string): string {
	return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : JSON.stringify(value);
}

export function buildPtyCommand(
	command: string,
	args: readonly string[],
	platform = process.platform,
): { command: string; args: string[] } {
	if (platform === "darwin") return { command: "script", args: ["-q", "/dev/null", command, ...args] };
	if (platform === "linux") {
		const shellCommand = [command, ...args].map((value) => `'${value.replaceAll("'", `'"'"'`)}'`).join(" ");
		return { command: "script", args: ["-q", "-c", shellCommand, "/dev/null"] };
	}
	throw new Error(`Interactive conflict resolution requires a PTY-capable Unix host (unsupported ${platform}).`);
}

export async function runForegroundLoggedCommand(
	command: string,
	args: readonly string[],
	cwd: string,
	logPath: string,
): Promise<void> {
	appendFileSync(logPath, `$ ${[command, ...args].map(quote).join(" ")}\n`);
	await new Promise<void>((resolveRun, reject) => {
		const child = spawn(command, [...args], {
			cwd,
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			stdio: ["inherit", "pipe", "pipe"],
		});
		const forward = (stream: NodeJS.WriteStream, chunk: Buffer | string) => {
			stream.write(chunk);
			appendFileSync(logPath, chunk);
		};
		child.stdout.on("data", (chunk: Buffer) => forward(process.stdout, chunk));
		child.stderr.on("data", (chunk: Buffer) => forward(process.stderr, chunk));
		child.once("error", reject);
		child.once("close", (code, signal) => {
			if (code === 0) resolveRun();
			else if (signal) reject(new Error(`${command} terminated by signal ${signal}`));
			else reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
		});
	});
}

function defaultRuntime(): SourceCheckoutUpdateRuntime {
	return {
		async capture(command, args, cwd) {
			return await new Promise<string>((resolveCapture, reject) => {
				const child = spawn(command, [...args], {
					cwd,
					env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
					stdio: ["ignore", "pipe", "pipe"],
				});
				let stdout = "";
				let stderr = "";
				child.stdout.setEncoding("utf8");
				child.stderr.setEncoding("utf8");
				child.stdout.on("data", (chunk: string) => (stdout += chunk));
				child.stderr.on("data", (chunk: string) => (stderr += chunk));
				child.once("error", reject);
				child.once("close", (code, signal) => {
					if (code === 0) resolveCapture(stdout);
					else if (signal) reject(new Error(`${command} terminated by signal ${signal}`));
					else reject(new Error(stderr.trim() || `${command} exited with code ${code ?? "unknown"}`));
				});
			});
		},
		run: runForegroundLoggedCommand,
		log(message) {
			console.log(message);
		},
	};
}

function lockfileDigest(root: string): string | undefined {
	const path = join(root, "package-lock.json");
	if (!existsSync(path)) return undefined;
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function createLogPath(repoRoot: string): string {
	const requested = process.env.PRIME_SOURCE_UPDATE_LOG_PATH;
	if (requested) {
		mkdirSync(dirname(requested), { recursive: true });
		return requested;
	}
	const directory = join(repoRoot, ".git", "pew-update-logs");
	mkdirSync(directory, { recursive: true });
	return join(directory, `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.log`);
}

async function phase(
	runtime: SourceCheckoutUpdateRuntime,
	logPath: string,
	label: string,
	command: string,
	args: readonly string[],
	cwd: string,
): Promise<void> {
	const message = `[source update] ${label}`;
	runtime.log(message);
	appendFileSync(logPath, `${message}\n`);
	await runtime.run(command, args, cwd, logPath);
}

function conflictResolutionPrompt(stagingRoot: string, conflicts: string[]): string {
	return `The source updater staged a merge in the temporary Prime Agent worktree at ${stagingRoot} and stopped on conflicts. Resolve only these exact conflicted paths:
${conflicts.map((path) => `- ${path}`).join("\n")}
Inspect both sides, preserve intended local and upstream behavior, remove every conflict marker, run git diff --check, and stage only these exact resolved paths with git add. Do not commit, stash, reset, clean, switch branches, update dependencies, build, or modify unrelated files. Finish only when git diff --name-only --diff-filter=U is empty.`;
}

type PromotionState = "preparing" | "artifacts-installed" | "source-promotion-intent" | "source-promoted";
type EntryState =
	| "copy-intent"
	| "copied"
	| "backup-intent"
	| "backed-up"
	| "install-intent"
	| "installed"
	| "rollback-remove-intent"
	| "rollback-removed"
	| "rollback-restore-intent"
	| "restored";
interface PromotionJournal {
	version: 2;
	repoRoot: string;
	previousHead: string;
	candidateHead: string;
	state: PromotionState;
	entries: Array<{ destination: string; next: string; backup: string; hadOriginal: boolean; state: EntryState }>;
}

function writePromotionJournal(path: string, journal: PromotionJournal): void {
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(journal, null, 2)}\n`);
	const fileDescriptor = openSync(temp, "r");
	try {
		fsyncSync(fileDescriptor);
	} finally {
		closeSync(fileDescriptor);
	}
	renameSync(temp, path);
	const directoryDescriptor = openSync(dirname(path), "r");
	try {
		fsyncSync(directoryDescriptor);
	} finally {
		closeSync(directoryDescriptor);
	}
}

function fsyncDirectory(path: string): void {
	const descriptor = openSync(path, "r");
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

function durableRename(from: string, to: string): void {
	renameSync(from, to);
	fsyncDirectory(dirname(from));
	if (dirname(to) !== dirname(from)) fsyncDirectory(dirname(to));
}

function durableRemove(path: string): void {
	rmSync(path, { recursive: true, force: true });
	fsyncDirectory(dirname(path));
}

function readValidatedJournal(path: string, expectedRepoRoot: string): PromotionJournal {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`Promotion journal is corrupt: ${String(error)}`);
	}
	if (!value || typeof value !== "object") throw new Error("Promotion journal is invalid");
	const journal = value as PromotionJournal;
	const states: PromotionState[] = ["preparing", "artifacts-installed", "source-promotion-intent", "source-promoted"];
	const entryStates: EntryState[] = [
		"copy-intent",
		"copied",
		"backup-intent",
		"backed-up",
		"install-intent",
		"installed",
		"rollback-remove-intent",
		"rollback-removed",
		"rollback-restore-intent",
		"restored",
	];
	if (
		journal.version !== 2 ||
		journal.repoRoot !== expectedRepoRoot ||
		!states.includes(journal.state) ||
		typeof journal.previousHead !== "string" ||
		typeof journal.candidateHead !== "string" ||
		!Array.isArray(journal.entries)
	) {
		throw new Error("Promotion journal has an unsupported or invalid schema");
	}
	const allowedDestinations = new Set([
		join(expectedRepoRoot, "node_modules"),
		...(["tui", "ai", "agent", "coding-agent"] as const).map((name) =>
			join(expectedRepoRoot, "packages", name, "dist"),
		),
	]);
	const seenDestinations = new Set<string>();
	for (const entry of journal.entries) {
		if (
			!entry ||
			typeof entry.destination !== "string" ||
			typeof entry.next !== "string" ||
			typeof entry.backup !== "string" ||
			typeof entry.hadOriginal !== "boolean" ||
			!entryStates.includes(entry.state) ||
			!isWithin(expectedRepoRoot, entry.destination) ||
			!allowedDestinations.has(entry.destination) ||
			seenDestinations.has(entry.destination) ||
			!/^.+\.pew-update-next-[0-9a-f-]{36}$/.test(entry.next) ||
			dirname(entry.next) !== dirname(entry.destination) ||
			!entry.next.startsWith(`${entry.destination}.pew-update-next-`) ||
			!/^.+\.pew-update-backup-[0-9a-f-]{36}$/.test(entry.backup) ||
			dirname(entry.backup) !== dirname(entry.destination) ||
			!entry.backup.startsWith(`${entry.destination}.pew-update-backup-`)
		) {
			throw new Error("Promotion journal contains an invalid, duplicate, or out-of-repository path");
		}
		seenDestinations.add(entry.destination);
	}
	return journal;
}

export function recoverPromotionJournal(
	path: string,
	logPath: string,
	repoRoot: string,
	observedHead: string,
	onTransition?: PromotionTransitionHook,
): void {
	if (!existsSync(path)) return;
	const journal = readValidatedJournal(path, repoRoot);
	const sourcePromoted = observedHead === journal.candidateHead;
	if (!sourcePromoted && observedHead !== journal.previousHead)
		throw new Error(`Cannot recover promotion: live HEAD ${observedHead} matches neither journal head`);
	const persist = () => writePromotionJournal(path, journal);
	const failures: string[] = [];
	for (const entry of [...journal.entries].reverse()) {
		try {
			if (sourcePromoted) {
				if (existsSync(entry.backup)) durableRemove(entry.backup);
				if (existsSync(entry.next)) durableRemove(entry.next);
				continue;
			}
			const mayHaveInstalledNew =
				["installed", "rollback-remove-intent"].includes(entry.state) ||
				(entry.state === "install-intent" && !existsSync(entry.next) && existsSync(entry.destination));
			if (mayHaveInstalledNew && entry.state !== "rollback-removed") {
				entry.state = "rollback-remove-intent";
				persist();
				onTransition?.(entry.state, entry);
				if (existsSync(entry.destination)) {
					durableRemove(entry.destination);
					onTransition?.("after-rollback-remove", entry);
				}
				entry.state = "rollback-removed";
				persist();
				onTransition?.(entry.state, entry);
			}
			if (entry.hadOriginal && entry.state !== "restored") {
				entry.state = "rollback-restore-intent";
				persist();
				onTransition?.(entry.state, entry);
				if (existsSync(entry.backup)) {
					if (existsSync(entry.destination)) durableRemove(entry.destination);
					durableRename(entry.backup, entry.destination);
					onTransition?.("after-rollback-restore", entry);
				} else if (!existsSync(entry.destination)) {
					throw new Error("neither backup nor restored destination exists");
				}
				entry.state = "restored";
				persist();
				onTransition?.(entry.state, entry);
			}
			if (existsSync(entry.next)) durableRemove(entry.next);
		} catch (error) {
			if (error instanceof SourceUpdateCrashInjection) throw error;
			failures.push(`${entry.destination}: ${String(error)} (backup: ${entry.backup})`);
		}
	}
	if (failures.length)
		throw new Error(`Interrupted promotion recovery incomplete:\n${failures.join("\n")} (debug log: ${logPath})`);
	durableRemove(path);
	appendFileSync(
		logPath,
		`[source update] Recovered interrupted ${sourcePromoted ? "cleanup" : "artifact promotion"}.\n`,
	);
}

export class SourceUpdateCrashInjection extends Error {}
export type PromotionTransition =
	| EntryState
	| "after-backup-rename"
	| "after-install-rename"
	| "after-rollback-remove"
	| "after-rollback-restore";
export type PromotionTransitionHook = (
	state: PromotionTransition,
	entry: Readonly<PromotionJournal["entries"][number]>,
) => void;

export interface DirectoryPromotionTransaction {
	commit(): { retainedBackups: string[]; cleanupFailures: string[] };
	rollback(): void;
}

export async function promoteDirectoriesAtomically(
	targets: Array<{ source: string; destination: string }>,
	_runtime: SourceCheckoutUpdateRuntime,
	_logPath: string,
	journalPath?: string,
	journalContext?: { repoRoot: string; previousHead: string; candidateHead: string },
	onTransition?: PromotionTransitionHook,
): Promise<DirectoryPromotionTransaction> {
	const entries: PromotionJournal["entries"] = [];
	const journal: PromotionJournal | undefined =
		journalPath && journalContext ? { version: 2, ...journalContext, state: "preparing", entries } : undefined;
	const persist = () => {
		if (journalPath && journal) writePromotionJournal(journalPath, journal);
	};
	const rollback = () => {
		const failures: string[] = [];
		for (const entry of [...entries].reverse()) {
			if (entry.state === "restored") continue;
			try {
				const mayHaveInstalled =
					["installed", "rollback-remove-intent"].includes(entry.state) ||
					(entry.state === "install-intent" && !existsSync(entry.next) && existsSync(entry.destination));
				if (mayHaveInstalled && entry.state !== "rollback-removed") {
					entry.state = "rollback-remove-intent";
					persist();
					if (existsSync(entry.destination)) {
						durableRemove(entry.destination);
						onTransition?.("after-rollback-remove", entry);
					}
					entry.state = "rollback-removed";
					persist();
				}
				if (entry.hadOriginal) {
					entry.state = "rollback-restore-intent";
					persist();
					if (existsSync(entry.backup)) {
						durableRename(entry.backup, entry.destination);
						onTransition?.("after-rollback-restore", entry);
					}
				}
				if (existsSync(entry.next)) durableRemove(entry.next);
				entry.state = "restored";
				persist();
			} catch (error) {
				failures.push(`${entry.destination}: ${String(error)} (backup: ${entry.backup})`);
			}
		}
		if (failures.length) throw new Error(`Artifact rollback incomplete:\n${failures.join("\n")}`);
		if (journalPath) durableRemove(journalPath);
	};
	try {
		for (const target of targets) {
			const token = randomUUID();
			const next = `${target.destination}.pew-update-next-${token}`;
			const backup = `${target.destination}.pew-update-backup-${token}`;
			const entry: PromotionJournal["entries"][number] = {
				destination: target.destination,
				next,
				backup,
				hadOriginal: existsSync(target.destination),
				state: "copy-intent",
			};
			entries.push(entry);
			persist();
			onTransition?.(entry.state, entry);
			cpSync(target.source, next, { recursive: true });
			entry.state = "copied";
			persist();
			onTransition?.(entry.state, entry);
			entry.state = "backup-intent";
			persist();
			onTransition?.(entry.state, entry);
			if (entry.hadOriginal) {
				durableRename(entry.destination, backup);
				onTransition?.("after-backup-rename", entry);
			}
			entry.state = "backed-up";
			persist();
			onTransition?.(entry.state, entry);
			entry.state = "install-intent";
			persist();
			onTransition?.(entry.state, entry);
			durableRename(next, entry.destination);
			onTransition?.("after-install-rename", entry);
			entry.state = "installed";
			persist();
			onTransition?.(entry.state, entry);
		}
		if (journal) {
			journal.state = "artifacts-installed";
			persist();
		}
	} catch (error) {
		if (error instanceof SourceUpdateCrashInjection) throw error;
		try {
			rollback();
		} catch (rollbackError) {
			throw new Error(`${String(error)}; ${String(rollbackError)}`);
		}
		throw error;
	}
	return {
		commit() {
			if (journal) {
				journal.state = "source-promoted";
				persist();
			}
			const cleanupFailures: string[] = [];
			const retainedBackups: string[] = [];
			for (const entry of entries)
				if (entry.hadOriginal && existsSync(entry.backup))
					try {
						durableRemove(entry.backup);
					} catch (error) {
						cleanupFailures.push(`${entry.backup}: ${String(error)}`);
						retainedBackups.push(entry.backup);
					}
			if (journalPath && cleanupFailures.length === 0) durableRemove(journalPath);
			return { retainedBackups, cleanupFailures };
		},
		rollback,
	};
}

export async function runSourceCheckoutSelfUpdate(
	checkout: SourceCheckoutSelfUpdate,
	options: { force?: boolean; runtime?: SourceCheckoutUpdateRuntime } = {},
): Promise<SourceCheckoutUpdateResult> {
	const runtime = options.runtime ?? defaultRuntime();
	const { repoRoot, launcherPath, oldBundlePath } = checkout;
	const logPath = createLogPath(repoRoot);
	runtime.log(`[source update] Debug log: ${logPath}`);
	appendFileSync(
		logPath,
		`[source update] Debug log: ${logPath}\n[source update] Preflight: checking live status and branch\n`,
	);
	const lockPath = join(repoRoot, ".git", "pew-update.lock");
	writeFileSync(lockPath, "");
	let releaseLock: (() => Promise<void>) | undefined;
	try {
		releaseLock = await lockfile.lock(lockPath, { realpath: false, stale: 60 * 60_000, retries: 0 });
	} catch {
		throw new Error(
			`Another source update is already running for ${repoRoot}. Wait for it to finish. (debug log: ${logPath})`,
		);
	}
	const journalPath = join(repoRoot, ".git", "pew-update-promotion.json");
	try {
		const recoveryHead = (await runtime.capture("git", ["rev-parse", "HEAD"], repoRoot)).trim();
		recoverPromotionJournal(journalPath, logPath, repoRoot, recoveryHead);
		const status = await runtime.capture("git", ["status", "--porcelain=v1", "--untracked-files=all"], repoRoot);
		appendFileSync(logPath, `[source update] Preflight status: ${status.trim() || "clean"}\n`);
		if (status.trim())
			throw new Error(
				`Source checkout is not clean. Commit or remove local changes before updating. (debug log: ${logPath})`,
			);
		const branch = (await runtime.capture("git", ["branch", "--show-current"], repoRoot)).trim();
		if (branch !== "main") {
			throw new Error(
				`Source checkout must be on main to update from origin/main (currently ${branch || "detached"}).`,
			);
		}
		if (!existsSync(oldBundlePath)) {
			throw new Error(
				`Validated source build is missing at ${oldBundlePath}. Run the package builds before updating.`,
			);
		}

		const previousHead = (await runtime.capture("git", ["rev-parse", "HEAD"], repoRoot)).trim();
		if (!existsSync(checkout.oldBundleProvenancePath)) {
			throw new Error(
				`Validated source build provenance is missing at ${checkout.oldBundleProvenancePath}. Rebuild before updating.`,
			);
		}
		const checkoutBuildId = (await runtime.capture("git", ["describe", "--tags", "--always"], repoRoot)).trim();
		const bundleBuildId = readFileSync(checkout.oldBundleProvenancePath, "utf8").trim();
		if (bundleBuildId !== checkoutBuildId) {
			throw new Error(
				`The validated bundle is from ${bundleBuildId}, but the clean checkout is ${checkoutBuildId}. Rebuild before updating.`,
			);
		}
		const previousLockfileDigest = lockfileDigest(repoRoot);
		const stagingRoot = join(tmpdir(), `pew-update-${randomUUID()}`);
		let stagingAdded = false;
		let promoted = false;

		try {
			await phase(
				runtime,
				logPath,
				"Validating the current bundled CLI",
				process.execPath,
				[oldBundlePath, "--version"],
				repoRoot,
			);
			await phase(
				runtime,
				logPath,
				"Fetching origin/main",
				"git",
				["fetch", "--prune", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main"],
				repoRoot,
			);
			await phase(
				runtime,
				logPath,
				"Creating a detached staging worktree",
				"git",
				["worktree", "add", "--detach", stagingRoot, previousHead],
				repoRoot,
			);
			stagingAdded = true;
			try {
				await phase(
					runtime,
					logPath,
					"Merging origin/main in staging",
					"git",
					["merge", "--no-edit", "origin/main"],
					stagingRoot,
				);
			} catch (mergeError) {
				const unresolved = (await runtime.capture("git", ["diff", "--name-only", "--diff-filter=U"], stagingRoot))
					.split(/\r?\n/)
					.filter(Boolean);
				if (unresolved.length === 0) throw mergeError;
				const preResolverStagedPaths = (
					await runtime.capture("git", ["diff", "--cached", "--name-only"], stagingRoot)
				)
					.split(/\r?\n/)
					.filter(Boolean);
				const preResolverIndex = await runtime.capture("git", ["ls-files", "--stage"], stagingRoot);
				const preResolverTrackedWorktree = await runtime.capture("git", ["diff", "--raw"], stagingRoot);
				const pty = buildPtyCommand(launcherPath, [
					"--dist",
					"--cwd",
					stagingRoot,
					conflictResolutionPrompt(stagingRoot, unresolved),
				]);
				await phase(
					runtime,
					logPath,
					"Launching the validated pre-update CLI in a foreground PTY to resolve staged merge conflicts",
					pty.command,
					pty.args,
					stagingRoot,
				);
				const postResolverIndex = await runtime.capture("git", ["ls-files", "--stage"], stagingRoot);
				const postResolverTrackedWorktree = await runtime.capture("git", ["diff", "--raw"], stagingRoot);
				const withoutConflicts = (snapshot: string) =>
					snapshot
						.split(/\r?\n/)
						.filter(
							(line) =>
								line && !unresolved.some((path) => line.endsWith(`\t${path}`) || line.endsWith(` ${path}`)),
						)
						.sort()
						.join("\n");
				if (
					withoutConflicts(preResolverIndex) !== withoutConflicts(postResolverIndex) ||
					withoutConflicts(preResolverTrackedWorktree) !== withoutConflicts(postResolverTrackedWorktree)
				) {
					throw new Error("Conflict resolver modified non-conflict index blobs or tracked worktree state.");
				}
				const remaining = (
					await runtime.capture("git", ["diff", "--name-only", "--diff-filter=U"], stagingRoot)
				).trim();
				if (remaining)
					throw new Error(`Merge conflicts remain unresolved:
${remaining}`);
				const stagedPaths = (await runtime.capture("git", ["diff", "--cached", "--name-only"], stagingRoot))
					.split(/\r?\n/)
					.filter(Boolean);
				const allowedPaths = new Set([...preResolverStagedPaths, ...unresolved]);
				const unexpectedPaths = stagedPaths.filter((path) => !allowedPaths.has(path));
				const missingPaths = unresolved.filter((path) => !stagedPaths.includes(path));
				const untracked = (
					await runtime.capture("git", ["ls-files", "--others", "--exclude-standard"], stagingRoot)
				).trim();
				if (unexpectedPaths.length || missingPaths.length || untracked) {
					throw new Error(
						`Conflict resolver changed paths outside the exact conflict set:${unexpectedPaths.length ? `\nunexpected: ${unexpectedPaths.join(", ")}` : ""}${missingPaths.length ? `\nnot staged: ${missingPaths.join(", ")}` : ""}${untracked ? `\nuntracked: ${untracked}` : ""}`,
					);
				}
				await phase(runtime, logPath, "Checking resolved conflicts", "git", ["diff", "--check"], stagingRoot);
				await phase(
					runtime,
					logPath,
					"Completing the staged merge",
					"git",
					["-c", "core.editor=true", "merge", "--continue"],
					stagingRoot,
				);
			}

			const stagedHead = (await runtime.capture("git", ["rev-parse", "HEAD"], stagingRoot)).trim();
			if (stagedHead === previousHead && !options.force) {
				runtime.log("[source update] Source checkout is already up to date");
				appendFileSync(logPath, "[source update] Source checkout is already up to date\n");
				return { changed: false, previousHead, currentHead: previousHead, logPath };
			}

			await phase(runtime, logPath, "Installing staged dependencies", "npm", ["install"], stagingRoot);
			await phase(runtime, logPath, "Checking the staged source", "npm", ["run", "check"], stagingRoot);
			await phase(
				runtime,
				logPath,
				"Building staged TUI",
				"npm",
				["--prefix", "packages/tui", "run", "build"],
				stagingRoot,
			);
			await phase(
				runtime,
				logPath,
				"Building staged AI",
				"npm",
				["--prefix", "packages/ai", "run", "build"],
				stagingRoot,
			);
			await phase(
				runtime,
				logPath,
				"Building staged agent core",
				"npm",
				["--prefix", "packages/agent", "run", "build"],
				stagingRoot,
			);
			await phase(
				runtime,
				logPath,
				"Building the staged coding agent",
				"npm",
				["--prefix", "packages/coding-agent", "run", "build"],
				stagingRoot,
			);
			await phase(
				runtime,
				logPath,
				"Verifying the staged bundled CLI",
				process.execPath,
				[join(stagingRoot, "packages", "coding-agent", "dist", "bundle", "cli.js"), "--version"],
				stagingRoot,
			);
			const stagedStatus = (
				await runtime.capture("git", ["status", "--porcelain=v1", "--untracked-files=all"], stagingRoot)
			).trim();
			if (stagedStatus)
				throw new Error(`Validation changed tracked staging files:
${stagedStatus}`);

			const liveHeadBeforePromotion = (await runtime.capture("git", ["rev-parse", "HEAD"], repoRoot)).trim();
			const liveStatusBeforePromotion = (
				await runtime.capture("git", ["status", "--porcelain=v1", "--untracked-files=all"], repoRoot)
			).trim();
			if (liveHeadBeforePromotion !== previousHead || liveStatusBeforePromotion) {
				throw new Error("Live checkout changed concurrently while the update was validating; refusing promotion.");
			}
			const promotionTargets: Array<{ source: string; destination: string }> = [];
			if (
				lockfileDigest(stagingRoot) !== previousLockfileDigest ||
				!existsSync(join(repoRoot, "node_modules", ".package-lock.json"))
			) {
				promotionTargets.push({
					source: join(stagingRoot, "node_modules"),
					destination: join(repoRoot, "node_modules"),
				});
			}
			for (const packageName of ["tui", "ai", "agent", "coding-agent"]) {
				promotionTargets.push({
					source: join(stagingRoot, "packages", packageName, "dist"),
					destination: join(repoRoot, "packages", packageName, "dist"),
				});
			}
			const promotion = runtime.promote
				? await runtime.promote(promotionTargets, logPath)
				: await promoteDirectoriesAtomically(promotionTargets, runtime, logPath, journalPath, {
						repoRoot,
						previousHead,
						candidateHead: stagedHead,
					});
			try {
				await phase(
					runtime,
					logPath,
					"Verifying the promoted bundled CLI before source promotion",
					launcherPath,
					["--dist", "--version"],
					repoRoot,
				);
				if (existsSync(journalPath)) {
					const journal = readValidatedJournal(journalPath, repoRoot);
					journal.state = "source-promotion-intent";
					writePromotionJournal(journalPath, journal);
				}
				await phase(
					runtime,
					logPath,
					"Promoting the validated source",
					"git",
					["merge", "--ff-only", stagedHead],
					repoRoot,
				);
				promoted = true;
				const cleanup = promotion.commit();
				if (cleanup.cleanupFailures.length) {
					const warning = `[source update] Update succeeded, but backup cleanup was incomplete. Retained recovery paths:\n${cleanup.retainedBackups.join("\n")}`;
					runtime.log(warning);
					appendFileSync(logPath, `${warning}\n${cleanup.cleanupFailures.join("\n")}\n`);
				}
			} catch (error) {
				try {
					promotion.rollback();
				} catch (rollbackError) {
					appendFileSync(logPath, `[source update] ARTIFACT ROLLBACK FAILED: ${String(rollbackError)}\n`);
					throw new Error(`${String(error)}; artifact rollback also failed: ${String(rollbackError)}`);
				}
				throw error;
			}
			return { changed: true, previousHead, currentHead: stagedHead, logPath };
		} catch (error) {
			appendFileSync(
				logPath,
				`[source update] FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
			);
			if (!promoted) {
				const finalHead = await runtime.capture("git", ["rev-parse", "HEAD"], repoRoot).catch(() => "unknown");
				appendFileSync(logPath, `[source update] Final live HEAD: ${finalHead.trim()}\n`);
				if (finalHead.trim() === previousHead)
					appendFileSync(logPath, "[source update] Live tracked HEAD was not changed.\n");
			}
			throw new Error(`${error instanceof Error ? error.message : String(error)} (debug log: ${logPath})`);
		} finally {
			if (stagingAdded) {
				const stagingStatus = await runtime
					.capture("git", ["status", "--porcelain=v1", "--untracked-files=all"], stagingRoot)
					.catch(() => "unknown");
				if (!stagingStatus.trim()) {
					await runtime.run("git", ["worktree", "remove", stagingRoot], repoRoot, logPath).catch(() => {});
				} else {
					appendFileSync(logPath, `[source update] Staging worktree retained for diagnosis: ${stagingRoot}\n`);
				}
			}
		}
	} finally {
		if (releaseLock) await releaseLock();
	}
}
