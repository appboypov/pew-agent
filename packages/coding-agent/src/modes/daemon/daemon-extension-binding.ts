import { randomUUID } from "node:crypto";
import type { Component, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import type {
	ExtensionCommandContextActions,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	TerminalInputHandler,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.js";
import { KeybindingsManager } from "../../core/keybindings.js";
import type { SubagentRuntimeHost } from "../../core/rlm-runtime.js";
import { createAgentConnectionState } from "../agent-connection/snapshot.js";
import type {
	AgentConnectionExtensionCustomUiOverlayOptions,
	AgentConnectionExtensionCustomUiPresentation,
	AgentConnectionState,
} from "../agent-connection/types.js";
import { initTheme, type Theme, theme } from "../interactive/theme/theme.js";
import type { ActiveSessionState } from "./active-session-state.js";
import { execEnvForSession, withClientEnv } from "./daemon-client-env.js";
import {
	type DaemonExtensionUIResponse,
	type DaemonOutbound,
	isDaemonDialogExtensionUiRequest,
} from "./daemon-protocol.js";

export interface ActiveSessionBindingCallbacks {
	broadcast: (state: ActiveSessionState, message: DaemonOutbound) => void;
	createConnectionState?: (state: ActiveSessionState) => AgentConnectionState;
	sessionReplaced?: (state: ActiveSessionState) => void;
	shutdown: () => void;
	subagentRuntimeHost?: SubagentRuntimeHost;
}

type BroadcastSessionEvent = Extract<DaemonOutbound, { type: "session_event" }>["event"];

/**
 * message_update events carry the full partial assistant message twice: once
 * as event.message and once nested as assistantMessageEvent.partial. Socket
 * clients read event.message (and assistantMessageEvent.type/toolCall), so the
 * nested copy is dropped before serialization, halving streaming wire bytes
 * per token. In-process consumers (extensions) still receive the full event.
 */
function slimSessionEventForWire(event: BroadcastSessionEvent): BroadcastSessionEvent {
	if (event.type !== "message_update") {
		return event;
	}
	const { partial: _partial, ...assistantMessageEvent } = event.assistantMessageEvent as { partial?: unknown };
	return {
		...event,
		assistantMessageEvent: assistantMessageEvent as typeof event.assistantMessageEvent,
	};
}

export async function bindActiveSessionState(
	state: ActiveSessionState,
	callbacks: ActiveSessionBindingCallbacks,
): Promise<void> {
	const session = state.runtime.session;
	initTheme(undefined, false);

	session.setExecEnvProvider(() => execEnvForSession(state.clientEnv));
	// Every runtime rebuild (new/switch/fork/import, subagent spawn) re-loads
	// extensions, which capture client env synchronously at that moment.
	state.runtime.setRuntimeEnvScope((fn) => withClientEnv(state.clientEnv, fn));

	state.unsubscribe?.();
	state.runtime.setSubagentRuntimeHost(callbacks.subagentRuntimeHost);
	state.unsubscribe = session.subscribe((event) => {
		callbacks.broadcast(state, {
			type: "session_event",
			activeSessionId: state.activeSessionId,
			event: slimSessionEventForWire(event),
		});
	});

	state.runtime.setRebindSession(async () => {
		await bindActiveSessionState(state, callbacks);
		callbacks.sessionReplaced?.(state);
		callbacks.broadcast(state, {
			type: "session_replaced",
			activeSessionId: state.activeSessionId,
			state:
				callbacks.createConnectionState?.(state) ??
				createAgentConnectionState(state.runtime, state.activeSessionId),
			messages: state.runtime.session.messages,
		});
	});

	await session.bindExtensions({
		uiContext: createExtensionUIContext(state, callbacks.broadcast),
		commandContextActions: createCommandContextActions(state),
		shutdownHandler: callbacks.shutdown,
		onError: (error) => {
			callbacks.broadcast(state, {
				type: "extension_error",
				activeSessionId: state.activeSessionId,
				extensionPath: error.extensionPath,
				event: error.event,
				error: error.error,
			});
		},
	});
}

function createCommandContextActions(state: ActiveSessionState): ExtensionCommandContextActions {
	return {
		waitForIdle: () => state.runtime.session.waitForIdle(),
		newSession: async (options) => state.runtime.newSession(options),
		fork: async (entryId, options) => {
			const result = await state.runtime.fork(entryId, options);
			return { cancelled: result.cancelled };
		},
		navigateTree: async (targetId, options) => {
			const result = await state.runtime.session.navigateTree(targetId, {
				summarize: options?.summarize,
				customInstructions: options?.customInstructions,
				replaceInstructions: options?.replaceInstructions,
				label: options?.label,
			});
			return { cancelled: result.cancelled };
		},
		switchSession: async (sessionPath, options) => state.runtime.switchSession(sessionPath, options),
		reload: async () => {
			// Reload re-evaluates extension modules, which capture client env
			// (e.g. herdr pane identity) synchronously at load.
			await withClientEnv(state.clientEnv, () => state.runtime.session.reload());
		},
	};
}

function createExtensionUIContext(
	state: ActiveSessionState,
	broadcast: ActiveSessionBindingCallbacks["broadcast"],
): ExtensionUIContext {
	const terminalInputHandlers = new Set<TerminalInputHandler>();
	const emitUiRequest = (method: string, payload: Record<string, unknown>): string => {
		const id = randomUUID();
		broadcast(state, {
			type: "extension_ui_request",
			activeSessionId: state.activeSessionId,
			id,
			method,
			payload,
		});
		return id;
	};

	const dialogRequest = <T>(
		method: string,
		payload: Record<string, unknown>,
		opts: ExtensionUIDialogOptions | undefined,
		fallback: T,
		resolveResponse: (response: DaemonExtensionUIResponse) => T,
	): Promise<T> => {
		if (opts?.signal?.aborted) {
			return Promise.resolve(fallback);
		}
		if (!hasExtensionUiClientForMethod(state, method)) {
			return Promise.resolve(fallback);
		}
		const requestId = emitUiRequest(method, payload);
		return new Promise((resolveDialog) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;
			const cleanup = () => {
				if (timeoutId) {
					clearTimeout(timeoutId);
				}
				opts?.signal?.removeEventListener("abort", onAbort);
				state.extensionUiRequests.delete(requestId);
			};
			const finish = (value: T) => {
				cleanup();
				resolveDialog(value);
			};
			const onAbort = () => finish(fallback);
			state.extensionUiRequests.set(requestId, {
				resolve: (response) => finish(resolveResponse(response)),
			});
			opts?.signal?.addEventListener("abort", onAbort, { once: true });
			if (opts?.timeout !== undefined) {
				timeoutId = setTimeout(() => finish(fallback), opts.timeout);
			}
		});
	};

	return {
		select: (title, values, opts) =>
			dialogRequest("select", { title, options: values, timeout: opts?.timeout }, opts, undefined, (response) =>
				"cancelled" in response && response.cancelled
					? undefined
					: "value" in response
						? response.value
						: undefined,
			),
		confirm: (title, message, opts) =>
			dialogRequest("confirm", { title, message, timeout: opts?.timeout }, opts, false, (response) =>
				"confirmed" in response ? response.confirmed : false,
			),
		input: (title, placeholder, opts) =>
			dialogRequest("input", { title, placeholder, timeout: opts?.timeout }, opts, undefined, (response) =>
				"cancelled" in response && response.cancelled
					? undefined
					: "value" in response
						? response.value
						: undefined,
			),
		notify: (message, notifyType) => emitUiRequest("notify", { message, notifyType }),
		onTerminalInput: (handler) => {
			terminalInputHandlers.add(handler);
			return () => terminalInputHandlers.delete(handler);
		},
		setStatus: (key, text) => emitUiRequest("setStatus", { statusKey: key, statusText: text }),
		setWorkingMessage: (message) => emitUiRequest("setWorkingMessage", { message }),
		setWorkingVisible: (visible) => emitUiRequest("setWorkingVisible", { visible }),
		setWorkingIndicator: (indicatorOptions?: WorkingIndicatorOptions) =>
			emitUiRequest("setWorkingIndicator", { options: indicatorOptions }),
		setHiddenThinkingLabel: (label) => emitUiRequest("setHiddenThinkingLabel", { label }),
		setWidget: (key: string, content: unknown, widgetOptions?: ExtensionWidgetOptions) => {
			if (content === undefined || Array.isArray(content)) {
				emitUiRequest("setWidget", {
					widgetKey: key,
					widgetLines: content,
					widgetPlacement: widgetOptions?.placement,
				});
			}
		},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: (title) => emitUiRequest("setTitle", { title }),
		custom: <T>(
			factory: (
				tui: TUI,
				theme: Theme,
				keybindings: KeybindingsManager,
				done: (result: T) => void,
			) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
			options?: {
				overlay?: boolean;
				overlayOptions?: OverlayOptions | (() => OverlayOptions);
				onHandle?: (handle: OverlayHandle) => void;
			},
		) => createRemoteExtensionCustomUi(state, broadcast, terminalInputHandlers, factory, options),
		pasteToEditor: (text) => emitUiRequest("setEditorText", { text }),
		setEditorText: (text) => emitUiRequest("setEditorText", { text }),
		getEditorText: () => "",
		editor: (title, prefill) => {
			return dialogRequest("editor", { title, prefill }, undefined, undefined, (response) =>
				"cancelled" in response && response.cancelled
					? undefined
					: "value" in response
						? response.value
						: undefined,
			);
		},
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme(): Theme {
			return theme;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "Theme switching is not supported in daemon mode" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

function createRemoteExtensionCustomUi<T>(
	state: ActiveSessionState,
	broadcast: ActiveSessionBindingCallbacks["broadcast"],
	terminalInputHandlers: ReadonlySet<TerminalInputHandler>,
	factory: (
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: (result: T) => void,
	) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
	options?: {
		overlay?: boolean;
		overlayOptions?: OverlayOptions | (() => OverlayOptions);
		onHandle?: (handle: OverlayHandle) => void;
	},
): Promise<T> {
	const owner = [...state.clients].find((client) =>
		(client.capabilitiesByActiveSessionId?.get(state.activeSessionId) ?? client.capabilities).has(
			"extension_custom_ui",
		),
	);
	if (!owner) {
		return Promise.resolve(undefined as T);
	}

	const id = randomUUID();
	const resolveOverlayOptions = (): OverlayOptions | undefined =>
		typeof options?.overlayOptions === "function" ? options.overlayOptions() : options?.overlayOptions;
	state.extensionCustomUiRequests ??= new Map();
	const requests = state.extensionCustomUiRequests;
	let component: (Component & { dispose?(): void }) | undefined;
	let columns = 80;
	let rows = 24;
	let renderWidth = 80;
	let hidden = false;
	let focused = !(options?.overlay && resolveOverlayOptions()?.nonCapturing === true);
	let closed = false;
	let renderQueued = false;
	let resolveResult!: (result: T) => void;
	let rejectResult!: (error: unknown) => void;

	const presentation = (): AgentConnectionExtensionCustomUiPresentation => {
		const resolved = resolveOverlayOptions();
		return {
			overlay: options?.overlay ?? false,
			overlayOptions: sanitizeOverlayOptions(resolved),
		};
	};

	const dispose = () => {
		try {
			component?.dispose?.();
		} catch {
			// Disposal must not replace the custom call's outcome.
		}
	};
	const close = (result: T, error?: unknown) => {
		if (closed) return;
		closed = true;
		requests.delete(id);
		broadcast(state, {
			type: "extension_custom_ui_close",
			activeSessionId: state.activeSessionId,
			targetClientId: owner.id,
			id,
			...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }),
		});
		dispose();
		if (error === undefined) resolveResult(result);
		else rejectResult(error);
	};
	const render = () => {
		if (closed || !component) return;
		try {
			const currentPresentation = presentation();
			const visible = resolveOverlayVisibility(options?.overlayOptions, columns, rows);
			broadcast(state, {
				type: "extension_custom_ui_frame",
				activeSessionId: state.activeSessionId,
				targetClientId: owner.id,
				id,
				lines: component.render(renderWidth),
				hidden: hidden || !visible,
				focused,
				presentation: currentPresentation,
			});
		} catch (error) {
			close(undefined as T, error);
		}
	};
	const requestRender = () => {
		if (renderQueued || closed) return;
		renderQueued = true;
		queueMicrotask(() => {
			renderQueued = false;
			render();
		});
	};
	const terminal = {
		get columns() {
			return columns;
		},
		get rows() {
			return rows;
		},
	};
	const remoteTui = {
		terminal,
		requestRender,
		setFocus: () => {
			focused = true;
			requestRender();
		},
	} as unknown as TUI;
	const overlayHandle: OverlayHandle = {
		hide: () => {
			hidden = true;
			focused = false;
			requestRender();
		},
		setHidden: (value) => {
			hidden = value;
			if (value) focused = false;
			else if (!options?.overlay || resolveOverlayOptions()?.nonCapturing !== true) focused = true;
			requestRender();
		},
		isHidden: () => hidden,
		focus: () => {
			hidden = false;
			focused = true;
			requestRender();
		},
		unfocus: () => {
			focused = false;
			requestRender();
		},
		isFocused: () => focused && !hidden,
	};

	const result = new Promise<T>((resolve, reject) => {
		resolveResult = resolve;
		rejectResult = reject;
	});
	requests.set(id, {
		ownerClientId: owner.id,
		handleEvent: (event) => {
			if (closed) return undefined;
			if (event.type === "cancel") {
				close(undefined as T);
				return undefined;
			}
			columns = Math.max(1, event.columns);
			rows = Math.max(1, event.rows);
			renderWidth = Math.max(1, event.width);
			if (event.type === "terminal_input" || event.type === "input") {
				let data = event.data;
				for (const handler of terminalInputHandlers) {
					const result = handler(data);
					if (result?.consume) return result;
					if (result?.data !== undefined) data = result.data;
					if (data.length === 0) return { consume: true };
				}
				if (event.type === "terminal_input") {
					return data === event.data ? undefined : { data };
				}
				try {
					component?.handleInput?.(data);
				} catch (error) {
					close(undefined as T, error);
					return undefined;
				}
			}
			requestRender();
			return undefined;
		},
		cancel: () => close(undefined as T),
	});
	broadcast(state, {
		type: "extension_custom_ui_open",
		activeSessionId: state.activeSessionId,
		targetClientId: owner.id,
		id,
		presentation: presentation(),
	});

	Promise.resolve(factory(remoteTui, theme, KeybindingsManager.create(), (value) => close(value)))
		.then((created) => {
			if (closed) {
				created.dispose?.();
				return;
			}
			component = created;
			if (options?.overlay) options.onHandle?.(overlayHandle);
			requestRender();
		})
		.catch((error) => close(undefined as T, error));

	return result;
}

function sanitizeOverlayOptions(
	options: OverlayOptions | undefined,
): AgentConnectionExtensionCustomUiOverlayOptions | undefined {
	if (!options) return undefined;
	const { visible: _visible, ...serializable } = options;
	return serializable as AgentConnectionExtensionCustomUiOverlayOptions;
}

function resolveOverlayVisibility(
	options: OverlayOptions | (() => OverlayOptions) | undefined,
	columns: number,
	rows: number,
): boolean {
	const resolved = typeof options === "function" ? options() : options;
	return resolved?.visible?.(columns, rows) ?? true;
}

function hasExtensionUiClientForMethod(state: ActiveSessionState, method: string): boolean {
	if (!isDaemonDialogExtensionUiRequest(method)) {
		return state.clients.size > 0;
	}
	return [...state.clients].some((client) => client.supportsExtensionUi);
}
