import { describe, expect, it, vi } from "vitest";
import { RemoteExtensionCustomUiComponent } from "../src/modes/interactive/remote-extension-custom-ui.js";

describe("RemoteExtensionCustomUiComponent", () => {
	it("renders complete worker frames and reports width changes", () => {
		const onInput = vi.fn();
		const onWidth = vi.fn();
		const component = new RemoteExtensionCustomUiComponent(onInput, onWidth);
		component.setLines(["first", "second"]);

		expect(component.render(80)).toEqual(["first", "second"]);
		expect(component.render(80)).toEqual(["first", "second"]);
		expect(component.render(120)).toEqual(["first", "second"]);
		expect(onWidth.mock.calls).toEqual([[80], [80], [120]]);
	});

	it("forwards raw terminal input without interpreting package keys", () => {
		const onInput = vi.fn();
		const component = new RemoteExtensionCustomUiComponent(onInput, () => {});
		component.handleInput("\u001b[A");
		expect(onInput).toHaveBeenCalledWith("\u001b[A");
	});
});
