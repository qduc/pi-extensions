import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "./config.ts";
import { FileArtifactWriter, truncateToolOutput } from "./core.ts";
import { inspectToolOutput, type InspectionRequest } from "./inspection.ts";

const INSPECTION_TOOL = "inspect_tool_output";

export default function toolOutputTruncation(pi: ExtensionAPI) {
	pi.registerTool({
		name: INSPECTION_TOOL,
		label: "Inspect tool output",
		description: "Read or search a saved tool-output artifact. Every response is bounded.",
		parameters: Type.Object({
			path: Type.String({ description: "Artifact filename shown in a truncation notice" }),
			operation: Type.Union([Type.Literal("head"), Type.Literal("tail"), Type.Literal("characters"), Type.Literal("lines"), Type.Literal("literal"), Type.Literal("regex")]),
			start: Type.Optional(Type.Integer({ minimum: 1 })), end: Type.Optional(Type.Integer({ minimum: 1 })),
			query: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const config = await loadConfig(ctx.cwd, ctx.isProjectTrusted());
			const text = await inspectToolOutput(resolve(ctx.cwd, config.artifactDirectory), config, params as InspectionRequest, ctx.cwd);
			return { content: [{ type: "text", text }] };
		},
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName === INSPECTION_TOOL || !Array.isArray(event.content)) return undefined;
		const config = await loadConfig(ctx.cwd, ctx.isProjectTrusted());
		const directory = resolve(ctx.cwd, config.artifactDirectory);
		const upstream = Boolean((event.details as { truncation?: { truncated?: boolean } } | undefined)?.truncation?.truncated);
		let changed = false;
		const content = await Promise.all(event.content.map(async (block: any) => {
			if (block?.type !== "text" || typeof block.text !== "string") return block;
			const result = await truncateToolOutput(block.text, config, { label: event.toolName, observedUpstreamTruncated: upstream, writer: new FileArtifactWriter(directory, ctx.cwd) });
			if (!result.truncated) return block;
			changed = true;
			return { ...block, text: result.text };
		}));
		return changed ? { content } : undefined;
	});
}

