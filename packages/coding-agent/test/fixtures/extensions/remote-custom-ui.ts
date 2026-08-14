import type { OverlayHandle } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "../../../src/core/extensions/types.js";

export default function remoteCustomUiExtension(pi: ExtensionAPI): void {
	pi.registerCommand("remote-ui-smoke", {
		description: "Open a generic Pi custom component",
		handler: async (_args, ctx) => {
			let handle: OverlayHandle | undefined;
			const unsubscribe = ctx.ui.onTerminalInput((data) => {
				if (data !== "r") return undefined;
				handle?.focus();
				return { consume: true };
			});
			try {
				const result = await ctx.ui.custom<string>(
					(tui, _theme, _keybindings, done) => ({
						render: () => [
							"REMOTE CUSTOM UI",
							"h hide | r reopen | x complete",
							`size ${tui.terminal.columns}x${tui.terminal.rows}`,
						],
						handleInput: (data) => {
							if (data === "h") handle?.setHidden(true);
							if (data === "x") done("remote-custom-complete");
							tui.requestRender();
						},
						invalidate: () => {},
					}),
					{ overlay: true, overlayOptions: { width: 52 }, onHandle: (value) => (handle = value) },
				);
				ctx.ui.notify(`custom result: ${result}`, "info");
			} finally {
				unsubscribe();
			}
		},
	});
}
