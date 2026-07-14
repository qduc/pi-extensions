import { existsSync, lstatSync, readdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";

const MANAGER_NAME = "extension-manager";
const extensionDir = join(process.env.HOME ?? "", ".pi", "agent", "extensions");

interface ExtensionItem { name: string; source: string; enabled: boolean; mutable: boolean; }

function isExtensionDirectory(path: string): boolean {
	return existsSync(join(path, "index.ts")) || existsSync(join(path, "package.json"));
}

function discover(): ExtensionItem[] {
	const enabled = new Map<string, string>();
	const sourceRoots = new Set<string>();

	for (const entry of readdirSync(extensionDir, { withFileTypes: true })) {
		const installed = join(extensionDir, entry.name);
		if (entry.isSymbolicLink()) {
			const source = resolve(extensionDir, readlinkSync(installed));
			enabled.set(entry.name, source);
			sourceRoots.add(dirname(source));
		} else if (entry.isDirectory() || entry.isFile()) {
			enabled.set(entry.name.replace(/\.ts$/, ""), installed);
		}
	}

	// Installing this manager beside a source checkout makes sibling extensions
	// available automatically, including extensions that have never been enabled.
	const ownInstall = join(extensionDir, MANAGER_NAME);
	if (existsSync(ownInstall) && lstatSync(ownInstall).isSymbolicLink()) {
		sourceRoots.add(dirname(resolve(extensionDir, readlinkSync(ownInstall))));
	}

	const candidates = new Map(enabled);
	for (const root of sourceRoots) {
		if (!existsSync(root)) continue;
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const source = join(root, entry.name);
			if (isExtensionDirectory(source)) candidates.set(entry.name, source);
		}
	}

	return [...candidates]
		.map(([name, source]) => ({
			name,
			source,
			enabled: enabled.has(name),
			mutable: name !== MANAGER_NAME && (!enabled.has(name) || lstatSync(join(extensionDir, name)).isSymbolicLink()),
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}

export default function extensionManager(pi: ExtensionAPI) {
	pi.registerCommand("extensions-ui", {
		description: "Enable or disable global extensions",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/extensions-ui requires TUI mode", "error");
				return;
			}

			const extensions = discover();
			let changed = false;
			await ctx.ui.custom((_tui, theme, _keybindings, done) => {
				const items: SettingItem[] = extensions.map((extension) => ({
					id: extension.name,
					label: extension.name,
					description: extension.mutable ? basename(extension.source) : "managed externally",
					currentValue: extension.enabled ? "enabled" : "disabled",
					values: extension.mutable ? ["enabled", "disabled"] : ["enabled"],
				}));
				const container = new Container();
				container.addChild(new Text(theme.fg("accent", theme.bold("Extensions")), 1, 0));
				container.addChild(new Text(theme.fg("dim", "Toggle with ←/→ or Enter. Changes reload when closed."), 1, 0));
				const list = new SettingsList(
					items,
					Math.min(items.length + 2, 18),
					getSettingsListTheme(),
					(id, value) => {
						const extension = extensions.find((item) => item.name === id);
						if (!extension?.mutable) return;
						const installed = join(extensionDir, extension.name);
						try {
							if (value === "enabled" && !existsSync(installed)) symlinkSync(extension.source, installed, "dir");
							if (value === "disabled" && existsSync(installed) && lstatSync(installed).isSymbolicLink()) unlinkSync(installed);
							extension.enabled = value === "enabled";
							changed = true;
						} catch (error) {
							ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
						}
					},
					() => done(undefined),
					{ enableSearch: true },
				);
				container.addChild(list);
				return {
					render: (width: number) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => list.handleInput?.(data),
				};
			});

			if (changed) {
				await ctx.reload();
				return;
			}
		},
	});
}
