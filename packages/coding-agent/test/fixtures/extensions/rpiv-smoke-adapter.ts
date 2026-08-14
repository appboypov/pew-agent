import { writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition } from "../../../src/core/extensions/types.js";

const rpivPath = process.env.RPIV_PACKAGE_PATH;
if (!rpivPath) throw new Error("RPIV_PACKAGE_PATH must point to the unchanged RPIV extension entry point");
const { default: rpiv } = (await import(rpivPath)) as { default: (pi: ExtensionAPI) => void };

export default function rpivSmokeAdapter(pi: ExtensionAPI): void {
	let askTool: ToolDefinition | undefined;
	const proxy = new Proxy(pi, {
		get(target, property, receiver) {
			if (property !== "registerTool") return Reflect.get(target, property, receiver);
			return (tool: ToolDefinition) => {
				if (tool.name === "ask_user_question") askTool = tool;
				target.registerTool(tool);
			};
		},
	});
	rpiv(proxy);
	pi.registerCommand("rpiv-smoke", {
		description: "Invoke the unchanged RPIV tool without a model call",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!askTool) throw new Error("RPIV did not register ask_user_question");
			if (process.env.RPIV_SMOKE_RESULT_FILE) {
				writeFileSync(process.env.RPIV_SMOKE_RESULT_FILE, JSON.stringify({ stage: "started" }));
			}
			const result = await askTool.execute(
				"rpiv-smoke",
				{
					questions: [
						{
							header: "Test",
							question: "Which option?",
							options: [
								{ label: "Alpha", description: "Choose the first option", preview: "ALPHA PREVIEW" },
								{ label: "Beta", description: "Choose the second option", preview: "BETA PREVIEW" },
							],
						},
					],
				},
				ctx.signal,
				undefined,
				ctx,
			);
			const text = result.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			ctx.ui.notify(`rpiv result: ${text}`, "info");
			if (process.env.RPIV_SMOKE_RESULT_FILE) {
				writeFileSync(process.env.RPIV_SMOKE_RESULT_FILE, JSON.stringify(result));
			}
		},
	});
}
