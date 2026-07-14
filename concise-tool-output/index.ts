import type { BashToolDetails, EditToolDetails, ExtensionAPI, ReadToolDetails } from "@earendil-works/pi-coding-agent";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const MAX_PREVIEW_LINES = 20;

function oneLine(value: unknown, maxLength = 100): string {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((item) => item.type === "text")?.text ?? "";
}

function expandedOutput(summary: string, output: string, expanded: boolean, theme: any): Text {
	if (!expanded || !output) return new Text(summary, 0, 0);
	const lines = output.split("\n");
	const preview = lines.slice(0, MAX_PREVIEW_LINES).map((line) => theme.fg("dim", line));
	if (lines.length > MAX_PREVIEW_LINES) preview.push(theme.fg("muted", `… ${lines.length - MAX_PREVIEW_LINES} more lines`));
	return new Text([summary, ...preview].join("\n"), 0, 0);
}

export default function conciseToolOutput(pi: ExtensionAPI) {
	const cwd = process.cwd();

	const read = createReadTool(cwd);
	pi.registerTool({
		name: "read", label: "read", description: read.description, parameters: read.parameters,
		execute: (id, params, signal, onUpdate) => read.execute(id, params, signal, onUpdate),
		renderCall(args, theme) {
			const range = args.offset || args.limit ? theme.fg("dim", ` · ${args.offset ?? 1}${args.limit ? `+${args.limit}` : ""}`) : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("read "))}${theme.fg("accent", oneLine(args.path))}${range}`, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "reading…"), 0, 0);
			const content = result.content[0];
			if (content?.type === "image") return new Text(theme.fg("success", "image loaded"), 0, 0);
			const output = textContent(result as any);
			const lines = output ? output.split("\n").length : 0;
			const details = result.details as ReadToolDetails | undefined;
			let summary = theme.fg("success", `${lines} lines`);
			if (details?.truncation?.truncated) summary += theme.fg("warning", " · truncated");
			return expandedOutput(summary, output, expanded, theme);
		},
	});

	const bash = createBashTool(cwd);
	pi.registerTool({
		name: "bash", label: "bash", description: bash.description, parameters: bash.parameters,
		execute: (id, params, signal, onUpdate) => bash.execute(id, params, signal, onUpdate),
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("$ "))}${theme.fg("accent", oneLine(args.command))}`, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "running…"), 0, 0);
			const output = textContent(result as any);
			const details = result.details as BashToolDetails | undefined;
			const exitCode = (details as any)?.exitCode;
			const failed = typeof exitCode === "number" ? exitCode !== 0 : result.isError;
			const lines = output.split("\n").filter((line) => line.trim()).length;
			let summary = theme.fg(failed ? "error" : "success", failed ? `exit ${exitCode ?? 1}` : "done");
			if (lines) summary += theme.fg("dim", ` · ${lines} lines`);
			if (details?.truncation?.truncated) summary += theme.fg("warning", " · truncated");
			return expandedOutput(summary, output, expanded, theme);
		},
	});

	const edit = createEditTool(cwd);
	pi.registerTool({
		name: "edit", label: "edit", description: edit.description, parameters: edit.parameters, renderShell: "self",
		execute: (id, params, signal, onUpdate) => edit.execute(id, params, signal, onUpdate),
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("edit "))}${theme.fg("accent", oneLine(args.path))}`, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "editing…"), 0, 0);
			const output = textContent(result as any);
			if (result.isError) return new Text(theme.fg("error", oneLine(output || "edit failed")), 0, 0);
			const diff = (result.details as EditToolDetails | undefined)?.diff ?? "";
			const lines = diff.split("\n");
			const added = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
			const removed = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
			const summary = `${theme.fg("success", `+${added}`)} ${theme.fg("error", `-${removed}`)}`;
			return expandedOutput(summary, diff, expanded, theme);
		},
	});

	const write = createWriteTool(cwd);
	pi.registerTool({
		name: "write", label: "write", description: write.description, parameters: write.parameters,
		execute: (id, params, signal, onUpdate) => write.execute(id, params, signal, onUpdate),
		renderCall(args, theme) {
			const lines = args.content.split("\n").length;
			return new Text(`${theme.fg("toolTitle", theme.bold("write "))}${theme.fg("accent", oneLine(args.path))}${theme.fg("dim", ` · ${lines} lines`)}`, 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "writing…"), 0, 0);
			const output = textContent(result as any);
			return new Text(theme.fg(result.isError ? "error" : "success", result.isError ? oneLine(output || "write failed") : "written"), 0, 0);
		},
	});
}
