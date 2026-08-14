import { existsSync, mkdirSync, rmSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import type { AgentCronJob } from "../src/core/cron-jobs.js";
import { SessionManager } from "../src/core/session-manager.js";
import type { ExtensionAPI, ExtensionFactory } from "../src/index.js";
import { createAgentConnectionState } from "../src/modes/agent-connection/snapshot.js";
import type { ActiveSessionState, DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { bindActiveSessionState } from "../src/modes/daemon/daemon-extension-binding.js";
import type { DaemonOutbound } from "../src/modes/daemon/daemon-protocol.js";

function getText(message: AgentSession["messages"][number]): string {
	if (!("content" in message)) {
		return "";
	}
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("");
}

describe("daemon extension binding", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeForTest(extensionFactory: ExtensionFactory, responses: string[]) {
		const tempDir = join(tmpdir(), `pi-daemon-extension-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [{ id: "faux-daemon", reasoning: false }],
		});
		faux.setResponses(responses.map((response) => fauxAssistantMessage(response)));

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: tempDir,
				authStorage,
				resourceLoaderOptions: {
					extensionFactories: [
						(pi: ExtensionAPI) => {
							pi.registerProvider(faux.getModel().provider, {
								baseUrl: faux.getModel().baseUrl,
								apiKey: "faux-key",
								api: faux.api,
								models: faux.models.map((registeredModel) => ({
									id: registeredModel.id,
									name: registeredModel.name,
									api: registeredModel.api,
									reasoning: registeredModel.reasoning,
									input: registeredModel.input,
									cost: registeredModel.cost,
									contextWindow: registeredModel.contextWindow,
									maxTokens: registeredModel.maxTokens,
								})),
							});
							extensionFactory(pi);
						},
					],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};

		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
		});

		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return runtime;
	}

	it("strips the duplicated partial message from broadcast message_update events", async () => {
		const runtime = await createRuntimeForTest(() => {}, ["streamed reply"]);

		const outbound: DaemonOutbound[] = [];
		const state: ActiveSessionState = {
			activeSessionId: "active-slim",
			runtime,
			clients: new Set(),
			pendingAttaches: 0,
			extensionUiRequests: new Map(),
			eventGeneration: "generation-slim",
			lastEventSequence: 0,
		};
		await bindActiveSessionState(state, {
			broadcast: (_state, message) => {
				outbound.push(message);
			},
			shutdown: () => {},
		});

		await runtime.session.prompt("hello");

		const updates = outbound.filter(
			(message): message is Extract<DaemonOutbound, { type: "session_event" }> =>
				message.type === "session_event" && message.event.type === "message_update",
		);
		expect(updates.length).toBeGreaterThan(0);
		for (const update of updates) {
			expect(update.event).toHaveProperty("message");
			expect(update.event).toHaveProperty("assistantMessageEvent");
			expect((update.event as { assistantMessageEvent: object }).assistantMessageEvent).not.toHaveProperty(
				"partial",
			);
		}
	});

	it("keeps extension replacement callbacks daemon-side and rebinds before withSession", async () => {
		const phases: string[] = [];
		let oldSessionFile: string | undefined;
		let replacementSessionFile: string | undefined;

		const runtime = await createRuntimeForTest(
			(pi) => {
				pi.registerCommand("daemon-replace", {
					description: "daemon replace",
					handler: async (_args, ctx) => {
						phases.push("command");
						oldSessionFile = ctx.sessionManager.getSessionFile();
						await ctx.newSession({
							parentSession: oldSessionFile,
							withSession: async (replacedCtx) => {
								phases.push("withSession");
								replacementSessionFile = replacedCtx.sessionManager.getSessionFile();
								await replacedCtx.sendUserMessage("daemon replacement message");
							},
						});
					},
				});
			},
			["replacement reply"],
		);

		const outbound: DaemonOutbound[] = [];
		const heartbeat: AgentCronJob = {
			id: "heartbeat-1",
			status: "active",
			source: "heartbeat",
			activeSessionId: "active-test",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			prompt: "check status",
			schedule: { kind: "interval", expression: "every 10s", intervalMs: 10_000 },
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			nextRunAt: "2026-01-01T00:00:10.000Z",
			runCount: 0,
		};
		const state: ActiveSessionState = {
			activeSessionId: "active-test",
			runtime,
			clients: new Set(),
			pendingAttaches: 0,
			extensionUiRequests: new Map(),
			eventGeneration: "generation-test",
			lastEventSequence: 0,
			summaryState: { summary: "old recap", taskState: "completed", basedOnMessageCount: 2 },
		};
		await bindActiveSessionState(state, {
			broadcast: (_state, message) => {
				outbound.push(message);
				if (message.type === "session_replaced") {
					phases.push("broadcast:session_replaced");
				}
			},
			createConnectionState: (targetState) => {
				const connectionState = createAgentConnectionState(targetState.runtime, targetState.activeSessionId);
				if (targetState.summaryState?.summary) {
					connectionState.recap = targetState.summaryState.summary;
				}
				connectionState.heartbeat = heartbeat;
				return connectionState;
			},
			sessionReplaced: (targetState) => {
				phases.push("sessionReplaced");
				targetState.summaryState = undefined;
			},
			shutdown: () => {
				phases.push("shutdown");
			},
		});

		await runtime.session.prompt("/daemon-replace");

		const replacementIndex = phases.indexOf("broadcast:session_replaced");
		const withSessionIndex = phases.indexOf("withSession");
		expect(replacementIndex).toBeGreaterThan(-1);
		expect(withSessionIndex).toBeGreaterThan(-1);
		expect(phases.indexOf("sessionReplaced")).toBeLessThan(replacementIndex);
		expect(replacementIndex).toBeLessThan(withSessionIndex);
		expect(replacementSessionFile).toBeDefined();
		expect(replacementSessionFile).not.toBe(oldSessionFile);
		expect(outbound).toContainEqual(
			expect.objectContaining({
				type: "session_replaced",
				activeSessionId: "active-test",
				state: expect.objectContaining({
					heartbeat: expect.objectContaining({ id: "heartbeat-1" }),
				}),
			}),
		);
		const replaced = outbound.find(
			(message): message is Extract<DaemonOutbound, { type: "session_replaced" }> =>
				message.type === "session_replaced",
		);
		expect(replaced?.state.recap).toBeUndefined();
		expect(runtime.session.messages.map((message) => `${message.role}:${getText(message)}`)).toEqual([
			"user:daemon replacement message",
			"assistant:replacement reply",
		]);
	});
	it("runs an unchanged worker-owned custom component for a capable client", async () => {
		let commandResult: string | undefined;
		const runtime = await createRuntimeForTest((pi) => {
			pi.registerCommand("daemon-custom", {
				description: "daemon custom",
				handler: async (_args, ctx) => {
					let handle: import("@earendil-works/pi-tui").OverlayHandle | undefined;
					const unsubscribe = ctx.ui.onTerminalInput((data) => {
						if (data !== "r") return undefined;
						handle?.setHidden(false);
						return { consume: true };
					});
					try {
						commandResult = await ctx.ui.custom<string>(
							(tui, _theme, _keybindings, done) => ({
								render: (width) => [`width:${width} terminal:${tui.terminal.columns}x${tui.terminal.rows}`],
								invalidate: () => {},
								handleInput: (data) => {
									if (data === "x") done("selected");
									else if (data === "h") handle?.setHidden(true);
									else tui.requestRender();
								},
							}),
							{ overlay: true, onHandle: (value) => (handle = value) },
						);
					} finally {
						unsubscribe();
					}
				},
			});
		}, []);
		const client: DaemonSocketClient = {
			id: "custom-owner",
			socket: {} as Socket,
			attachedActiveSessionIds: new Set(["active-custom"]),
			detachInput: () => {},
			supportsExtensionUi: true,
			capabilities: new Set(["extension_ui", "extension_custom_ui"]),
		};
		const outbound: DaemonOutbound[] = [];
		const state: ActiveSessionState = {
			activeSessionId: "active-custom",
			runtime,
			clients: new Set([client]),
			pendingAttaches: 0,
			extensionUiRequests: new Map(),
			extensionCustomUiRequests: new Map(),
			eventGeneration: "generation-custom",
			lastEventSequence: 0,
		};
		await bindActiveSessionState(state, {
			broadcast: (_state, message) => outbound.push(message),
			shutdown: () => {},
		});

		const prompt = runtime.session.prompt("/daemon-custom");
		await vi.waitFor(() =>
			expect(outbound.some((message) => message.type === "extension_custom_ui_open")).toBe(true),
		);
		const request = [...(state.extensionCustomUiRequests?.values() ?? [])][0];
		expect(request?.ownerClientId).toBe("custom-owner");
		request?.handleEvent({ type: "ready", columns: 120, rows: 31, width: 73 });
		await vi.waitFor(() =>
			expect(outbound).toContainEqual(
				expect.objectContaining({
					type: "extension_custom_ui_frame",
					lines: ["width:73 terminal:120x31"],
				}),
			),
		);
		request?.handleEvent({ type: "input", data: "h", columns: 120, rows: 31, width: 73 });
		await vi.waitFor(() =>
			expect(outbound).toContainEqual(expect.objectContaining({ type: "extension_custom_ui_frame", hidden: true })),
		);
		expect(request?.handleEvent({ type: "terminal_input", data: "r", columns: 120, rows: 31, width: 73 })).toEqual({
			consume: true,
		});
		await vi.waitFor(() =>
			expect(outbound.at(-1)).toEqual(
				expect.objectContaining({ type: "extension_custom_ui_frame", hidden: false, focused: true }),
			),
		);
		request?.handleEvent({ type: "input", data: "x", columns: 120, rows: 31, width: 73 });
		await prompt;

		expect(commandResult).toBe("selected");
		expect(state.extensionCustomUiRequests?.size).toBe(0);
		expect(outbound).toContainEqual(
			expect.objectContaining({ type: "extension_custom_ui_close", targetClientId: "custom-owner" }),
		);
	});

	it("cancels and disposes a worker-owned custom component", async () => {
		let commandResult: string | undefined = "pending";
		let disposeCount = 0;
		const runtime = await createRuntimeForTest((pi) => {
			pi.registerCommand("daemon-custom-cancel", {
				description: "daemon custom cancel",
				handler: async (_args, ctx) => {
					commandResult = await ctx.ui.custom<string>(() => ({
						render: () => ["cancel me"],
						invalidate: () => {},
						dispose: () => disposeCount++,
					}));
				},
			});
		}, []);
		const client: DaemonSocketClient = {
			id: "cancel-owner",
			socket: {} as Socket,
			attachedActiveSessionIds: new Set(["active-cancel"]),
			detachInput: () => {},
			supportsExtensionUi: true,
			capabilities: new Set(["extension_ui", "extension_custom_ui"]),
		};
		const outbound: DaemonOutbound[] = [];
		const state: ActiveSessionState = {
			activeSessionId: "active-cancel",
			runtime,
			clients: new Set([client]),
			pendingAttaches: 0,
			extensionUiRequests: new Map(),
			extensionCustomUiRequests: new Map(),
			eventGeneration: "generation-cancel",
			lastEventSequence: 0,
		};
		await bindActiveSessionState(state, {
			broadcast: (_state, message) => outbound.push(message),
			shutdown: () => {},
		});

		const prompt = runtime.session.prompt("/daemon-custom-cancel");
		await vi.waitFor(() => expect(state.extensionCustomUiRequests?.size).toBe(1));
		const request = [...(state.extensionCustomUiRequests?.values() ?? [])][0];
		request?.handleEvent({ type: "cancel" });
		await prompt;

		expect(commandResult).toBeUndefined();
		expect(disposeCount).toBe(1);
		expect(state.extensionCustomUiRequests?.size).toBe(0);
		expect(outbound).toContainEqual(
			expect.objectContaining({ type: "extension_custom_ui_close", targetClientId: "cancel-owner" }),
		);
	});

	it("closes and disposes a custom component that throws while handling input", async () => {
		let disposeCount = 0;
		const runtime = await createRuntimeForTest((pi) => {
			pi.registerCommand("daemon-custom-error", {
				description: "daemon custom error",
				handler: async (_args, ctx) => {
					await ctx.ui.custom(() => ({
						render: () => ["throw on input"],
						invalidate: () => {},
						handleInput: () => {
							throw new Error("custom input failed");
						},
						dispose: () => disposeCount++,
					}));
				},
			});
		}, []);
		const client: DaemonSocketClient = {
			id: "error-owner",
			socket: {} as Socket,
			attachedActiveSessionIds: new Set(["active-error"]),
			detachInput: () => {},
			supportsExtensionUi: true,
			capabilities: new Set(["extension_ui", "extension_custom_ui"]),
		};
		const outbound: DaemonOutbound[] = [];
		const state: ActiveSessionState = {
			activeSessionId: "active-error",
			runtime,
			clients: new Set([client]),
			pendingAttaches: 0,
			extensionUiRequests: new Map(),
			extensionCustomUiRequests: new Map(),
			eventGeneration: "generation-error",
			lastEventSequence: 0,
		};
		await bindActiveSessionState(state, {
			broadcast: (_state, message) => outbound.push(message),
			shutdown: () => {},
		});

		const prompt = runtime.session.prompt("/daemon-custom-error");
		await vi.waitFor(() => expect(state.extensionCustomUiRequests?.size).toBe(1));
		const request = [...(state.extensionCustomUiRequests?.values() ?? [])][0];
		request?.handleEvent({ type: "input", data: "x", columns: 100, rows: 30, width: 80 });
		await prompt;

		expect(disposeCount).toBe(1);
		expect(state.extensionCustomUiRequests?.size).toBe(0);
		expect(outbound).toContainEqual(
			expect.objectContaining({
				type: "extension_custom_ui_close",
				error: "custom input failed",
			}),
		);
	});

	it("keeps custom UI unsupported without a capable client", async () => {
		let commandResult: string | undefined = "not-run";
		const runtime = await createRuntimeForTest((pi) => {
			pi.registerCommand("daemon-custom-unsupported", {
				description: "daemon custom unsupported",
				handler: async (_args, ctx) => {
					commandResult = await ctx.ui.custom<string>(() => ({
						render: () => ["never mounted"],
						invalidate: () => {},
					}));
				},
			});
		}, []);
		const state: ActiveSessionState = {
			activeSessionId: "active-custom-unsupported",
			runtime,
			clients: new Set(),
			pendingAttaches: 0,
			extensionUiRequests: new Map(),
			extensionCustomUiRequests: new Map(),
			eventGeneration: "generation-custom-unsupported",
			lastEventSequence: 0,
		};
		await bindActiveSessionState(state, { broadcast: () => {}, shutdown: () => {} });
		await runtime.session.prompt("/daemon-custom-unsupported");
		expect(commandResult).toBeUndefined();
	});
});
