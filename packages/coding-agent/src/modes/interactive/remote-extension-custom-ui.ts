import type { Component } from "@earendil-works/pi-tui";

export interface RemoteExtensionCustomUiFrame {
	lines: string[];
	hidden: boolean;
	focused: boolean;
}

export class RemoteExtensionCustomUiComponent implements Component {
	private lines: string[] = [];
	constructor(
		private readonly onInput: (data: string) => void,
		private readonly onWidth: (width: number) => void,
	) {}

	render(width: number): string[] {
		this.onWidth(width);
		return this.lines;
	}

	handleInput(data: string): void {
		this.onInput(data);
	}

	setLines(lines: readonly string[]): void {
		this.lines = [...lines];
	}

	invalidate(): void {
		// Frames are complete rendered replacements, so no local cache needs invalidation.
	}
}
