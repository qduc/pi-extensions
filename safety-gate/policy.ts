import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type Outcome = "safe" | "risky" | "prohibited";
export type GitOperation =
	| "forcePush"
	| "hardReset"
	| "deleteBranch"
	| "rewriteHistory"
	| "clean"
	| "discardChanges";

export interface SafetyGateConfig {
	protectedPaths?: string[];
	allowedExternalPaths?: string[];
	confirmCommands?: string[];
	blockedCommands?: string[];
	git?: Partial<Record<GitOperation, "confirm" | "block">>;
}

export interface Decision {
	outcome: Outcome;
	rule: string;
	action: string;
	affected?: string;
	reason: string;
	alternative?: string;
}

export interface EvaluationInput {
	toolName: string;
	input: Record<string, unknown>;
	cwd: string;
	workspace?: string;
	home?: string;
	env?: NodeJS.ProcessEnv;
	config?: SafetyGateConfig;
}

const DEFAULT_GIT_POLICY: Record<GitOperation, "confirm" | "block"> = {
	forcePush: "confirm",
	hardReset: "confirm",
	deleteBranch: "confirm",
	rewriteHistory: "confirm",
	clean: "confirm",
	discardChanges: "confirm",
};

const SYSTEM_ROOTS = [
	"/bin",
	"/boot",
	"/dev",
	"/etc",
	"/Library",
	"/proc",
	"/root",
	"/sbin",
	"/System",
	"/usr",
];

const GIT_OPERATIONS: Array<{ operation: GitOperation; test: (words: string[]) => boolean; reason: string; alternative: string }> = [
	{
		operation: "forcePush",
		test: (w) =>
			w[1] === "push" &&
			w.some((x) => x === "-f" || x === "--force" || x.startsWith("--force=") || x.startsWith("--force-with-lease") || x.startsWith("+")),
		reason: "force-push can overwrite remote history used by other people",
		alternative: "push normally; only relax the project policy after reviewing and coordinating the rewrite",
	},
	{
		operation: "hardReset",
		test: (w) => w[1] === "reset" && w.includes("--hard"),
		reason: "hard reset discards tracked working-tree and index changes",
		alternative: "inspect git status/diff and stash or commit wanted changes first",
	},
	{
		operation: "deleteBranch",
		test: (w) =>
			(w[1] === "branch" && w.some((x) => x === "-d" || x === "-D" || x === "--delete")) ||
			(w[1] === "tag" && w.some((x) => x === "-d" || x === "--delete")) ||
			(w[1] === "push" && w.some((x) => x === "-d" || x === "--delete")),
		reason: "deleting a branch can make unmerged work difficult to recover",
		alternative: "verify the branch is merged with git branch --merged before deleting it",
	},
	{
		operation: "rewriteHistory",
		test: (w) => w[1] === "rebase" || w[1] === "filter-branch" || (w[1] === "commit" && w.includes("--amend")),
		reason: "this operation rewrites commit history",
		alternative: "create a new commit, or work on a temporary branch first",
	},
	{
		operation: "clean",
		test: (w) => w[1] === "clean" && !w.some((x) => x === "--dry-run" || /^-[^-]*n/.test(x)),
		reason: "git clean permanently removes untracked files",
		alternative: "run git clean -ndx (or a narrower dry run) first",
	},
	{
		operation: "discardChanges",
		test: (w) =>
			(w[1] === "checkout" && w.slice(2).some((x) => x === "." || x === ":/" || /[*?\[]/.test(x))) ||
			(w[1] === "restore" && (w.includes(".") || w.includes(":/") || w.some((x) => /[*?\[]/.test(x)))) ||
			(w[1] === "stash" && (w[2] === "drop" || w[2] === "clear")),
		reason: "this broadly discards working-tree changes",
		alternative: "restore named files only after reviewing git diff, or stash the changes",
	},
];

function decision(
	outcome: Outcome,
	rule: string,
	action: string,
	reason: string,
	affected?: string,
	alternative?: string,
): Decision {
	return { outcome, rule, action, affected, reason, alternative };
}

function inside(path: string, root: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function canonicalize(path: string): string {
	let existing = path;
	const missing: string[] = [];
	while (!existsSync(existing)) {
		const parent = dirname(existing);
		if (parent === existing) break;
		missing.unshift(existing.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
		existing = parent;
	}
	try {
		return join(realpathSync.native(existing), ...missing);
	} catch {
		return path;
	}
}

function expandPath(raw: string, cwd: string, home: string, env: NodeJS.ProcessEnv): { path?: string; dynamic?: string } {
	let value = raw.trim();
	if (!value || value === "-" || value === "/dev/null") return {};
	if (value.startsWith("~")) {
		if (value === "~" || value.startsWith("~/")) value = home + value.slice(1);
		else return { dynamic: raw };
	}
	let unknown: string | undefined;
	value = value.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (_match, braced, plain) => {
		const name = braced ?? plain;
		const replacement = env[name];
		if (replacement === undefined) {
			unknown = name;
			return _match;
		}
		return replacement;
	});
	if (unknown || value.includes("$(") || value.includes("`")) return { dynamic: unknown ? `$${unknown}` : raw };
	return { path: canonicalize(isAbsolute(value) ? resolve(value) : resolve(cwd, value)) };
}

function tokenize(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	const push = () => {
		if (current) tokens.push(current);
		current = "";
	};
	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			push();
			if (char === "\n") tokens.push(";");
			continue;
		}
		if (";&|<>".includes(char)) {
			push();
			let operator = char;
			while (i + 1 < command.length && ";&|<>".includes(command[i + 1]) && operator.length < 3) operator += command[++i];
			tokens.push(operator);
			continue;
		}
		current += char;
	}
	push();
	return tokens;
}

function segments(tokens: string[]): string[][] {
	const result: string[][] = [];
	let segment: string[] = [];
	for (const token of tokens) {
		if ([";", "&&", "||", "|", "&"].includes(token)) {
			if (segment.length) result.push(segment);
			segment = [];
		} else segment.push(token);
	}
	if (segment.length) result.push(segment);
	return result;
}

function unwrap(words: string[]): string[] {
	let result = [...words];
	while (["command", "builtin", "nohup", "nice"].includes(result[0])) result = result.slice(1);
	if (result[0] === "env") {
		result = result.slice(1);
		while (result[0]?.includes("=") && !result[0].startsWith("=")) result = result.slice(1);
	}
	return result;
}

function sensitivePath(path: string, home: string): string | undefined {
	const lower = path.toLowerCase();
	const base = lower.split(sep).at(-1) ?? "";
	if (/^\.env(?:\..+)?$/.test(base) && !/\.(?:example|sample|template)$/.test(base)) return "environment/secrets file";
	if ([".npmrc", ".pypirc", ".netrc", ".git-credentials", "credentials.json", "secrets.json"].includes(base)) return "credentials file";
	if (/\.(?:pem|p12|pfx|key)$/.test(base) || /^id_(?:rsa|dsa|ecdsa|ed25519)$/.test(base)) return "private key or certificate";
	const sensitiveHomes = [".ssh", join(".aws", "credentials"), join(".config", "gcloud"), join(".docker", "config.json")];
	for (const item of sensitiveHomes) if (inside(path, canonicalize(join(home, item)))) return "user credentials or security configuration";
	return undefined;
}

function compilePatterns(patterns: string[] | undefined): RegExp[] {
	return (patterns ?? []).map((pattern) => new RegExp(pattern, "i"));
}

function gitCommandMutates(words: string[]): boolean {
	const subcommand = words[1];
	if (!subcommand) return false;
	if (["status", "diff", "log", "show", "grep", "ls-files", "ls-tree", "rev-parse", "describe", "blame", "shortlog"].includes(subcommand)) return false;
	if (subcommand === "branch" && words.length === 2) return false;
	if (subcommand === "tag" && words.length === 2) return false;
	if (subcommand === "remote" && (words.length === 2 || words[2] === "show" || words[2] === "get-url")) return false;
	if (subcommand === "config" && words.some((word) => word === "--get" || word === "--get-all" || word === "--list")) return false;
	return true;
}

function configuredPath(raw: string, cwd: string, home: string, env: NodeJS.ProcessEnv): string {
	const expanded = expandPath(raw, cwd, home, env);
	if (!expanded.path) throw new Error(`Configured path cannot be resolved safely: ${raw}`);
	return expanded.path;
}

function evaluateMutationPath(
	rawPath: string,
	input: EvaluationInput,
	action: string,
	kind: "write" | "delete" | "permission",
): Decision | undefined {
	const env = input.env ?? process.env;
	const home = input.home ?? env.HOME ?? "";
	const workingDirectory = canonicalize(resolve(input.cwd));
	const workspace = canonicalize(resolve(input.workspace ?? input.cwd));
	const expanded = expandPath(rawPath, workingDirectory, home, env);
	if (expanded.dynamic) {
		return decision("prohibited", "dynamic-path", action, `the affected path depends on unresolved expansion ${expanded.dynamic}`, rawPath, "use a literal or fully expanded path");
	}
	if (!expanded.path) return undefined;
	const path = expanded.path;
	const config = input.config ?? {};
	if (path === canonicalize(join(workspace, ".pi", "safety-gate.json"))) {
		return decision("prohibited", "policy-self-protection", action, "the action would modify the safety gate's own project policy", path, "ask the user to edit the policy outside the agent run");
	}
	if (path.split(sep).includes(".git")) {
		return decision("prohibited", "repository-metadata", action, "direct mutation of .git can corrupt the repository or bypass Git safeguards", path, "use a specific non-destructive Git command instead");
	}
	const protectedPaths = (config.protectedPaths ?? []).map((p) => configuredPath(p, workspace, home, env));
	if (protectedPaths.some((root) => inside(path, root))) {
		return decision("prohibited", "configured-protected-path", action, "the path is protected by .pi/safety-gate.json", path, "work on an unprotected copy or change the project policy explicitly");
	}
	if (SYSTEM_ROOTS.some((root) => inside(path, canonicalize(root)))) {
		return decision("risky", "system-path", action, "the action would modify host system configuration or files", path, "make the change in a project-local file or isolated container");
	}
	const allowedExternal = (config.allowedExternalPaths ?? []).map((p) => configuredPath(p, workspace, home, env));
	if (!inside(path, workspace) && !allowedExternal.some((root) => inside(path, root))) {
		return decision("risky", "outside-workspace", action, `the action would ${kind} outside the active workspace`, path, "copy the file into the workspace, or explicitly allow its parent path in project configuration");
	}
	const sensitive = sensitivePath(path, home);
	if (sensitive) {
		return decision("risky", "sensitive-path", action, `the target is a ${sensitive}`, path, "edit a checked-in example/template instead and inject secrets at runtime");
	}
	return undefined;
}

function pathOperands(words: string[]): Array<{ path: string; kind: "write" | "delete" | "permission" }> {
	const command = words[0]?.split("/").at(-1);
	if (!command) return [];
	const targetDirectory = words.find((word) => word.startsWith("--target-directory="))?.split("=", 2)[1] ??
		(words.includes("-t") ? words[words.indexOf("-t") + 1] : undefined);
	const args = words.slice(1).filter((word, index) =>
		!word.startsWith("-") && !/^\d+$/.test(word) && words[index] !== "-t",
	);
	switch (command) {
		case "rm":
		case "unlink":
		case "rmdir":
		case "shred":
		case "srm":
		case "wipe":
			return args.map((path) => ({ path, kind: "delete" }));
		case "mv":
			if (targetDirectory) return [...args.filter((path) => path !== targetDirectory).map((path) => ({ path, kind: "delete" as const })), { path: targetDirectory, kind: "write" }];
			return args.map((path, index) => ({ path, kind: index === args.length - 1 ? "write" : "delete" }));
		case "cp":
		case "install":
		case "rsync":
			return targetDirectory ? [{ path: targetDirectory, kind: "write" }] : args.length ? [{ path: args.at(-1)!, kind: "write" }] : [];
		case "mkdir":
		case "touch":
		case "truncate":
			return args.map((path) => ({ path, kind: "write" }));
		case "chmod":
		case "chown":
		case "chgrp":
			return args.slice(1).map((path) => ({ path, kind: "permission" }));
		case "tee":
			return args.map((path) => ({ path, kind: "write" }));
		case "sed":
			return words.some((word) => word === "-i" || word.startsWith("-i")) ? args.slice(1).map((path) => ({ path, kind: "write" })) : [];
		case "perl":
			return words.some((word) => /^-[^\s]*i/.test(word)) ? args.map((path) => ({ path, kind: "write" })) : [];
		default:
			return [];
	}
}

function redirectionPaths(words: string[]): string[] {
	const result: string[] = [];
	for (let i = 0; i < words.length - 1; i++) if (/^(?:\d*|&)>>?$/.test(words[i])) result.push(words[i + 1]);
	return result;
}

function strongest(decisions: Decision[]): Decision | undefined {
	return decisions.find((d) => d.outcome === "prohibited") ?? decisions.find((d) => d.outcome === "risky");
}

function evaluateBash(input: EvaluationInput): Decision {
	const command = String(input.input.command ?? "");
	const action = command;
	const config = input.config ?? {};
	try {
		if (compilePatterns(config.blockedCommands).some((pattern) => pattern.test(command))) {
			return decision("prohibited", "configured-blocked-command", action, "the command matches blockedCommands in .pi/safety-gate.json");
		}
	} catch (error) {
		return decision("prohibited", "invalid-config", action, error instanceof Error ? error.message : "invalid blockedCommands pattern");
	}

	if (/`[^`]*`|\$\([^)]*\)/.test(command) && /\b(?:rm|mv|cp|chmod|chown|tee|truncate|dd|install|rsync)\b|(?:^|[^<])>>?/.test(command)) {
		return decision("prohibited", "dynamic-destructive-command", action, "command substitution obscures a mutation target", undefined, "resolve the value first and use a literal path");
	}
	if (/(?:^|[;&|]\s*)(?:eval|source)\b/.test(command) || /(?:^|[;&|]\s*)(?:ba|z|da|k)?sh\s+(?:-[a-z]*c|--command)\b/i.test(command)) {
		return decision("prohibited", "opaque-shell", action, "nested or dynamically evaluated shell code can bypass command and path inspection", undefined, "run the intended command directly with literal arguments");
	}
	if (/\b(?:curl|wget)\b[^|;\n]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i.test(command) || /\bbase64\s+(?:-[dD]|--decode)\b[^|;\n]*\|/.test(command)) {
		return decision("prohibited", "download-or-decode-execute", action, "downloaded or decoded content is being executed without an auditable intermediate file", undefined, "save the content, inspect it, then run a specific reviewed script");
	}

	const allTokens = tokenize(command);
	const commandSegments = segments(allTokens);
	let currentCwd = input.cwd;
	const findings: Decision[] = [];
	for (const rawWords of commandSegments) {
		const words = unwrap(rawWords);
		if (!words.length) continue;
		const executable = words[0].split("/").at(-1)?.toLowerCase();
		if (words[0].includes("$") || words[0].includes("`")) {
			findings.push(decision("prohibited", "dynamic-executable", action, "the executable name is assembled dynamically and cannot be inspected reliably", words[0], "invoke a literal command name"));
			continue;
		}
		if (executable === "cd" && words[1]) {
			const changed = expandPath(words[1], currentCwd, input.home ?? process.env.HOME ?? "", input.env ?? process.env);
			if (changed.path) currentCwd = changed.path;
			else findings.push(decision("prohibited", "dynamic-working-directory", action, "the command changes to a working directory that cannot be resolved safely", words[1]));
			continue;
		}
		if (["sudo", "doas", "su"].includes(executable ?? "")) {
			findings.push(decision("risky", "privilege-escalation", action, "the command requests elevated host privileges", executable, "perform the task with workspace-local permissions"));
		}
		if (["systemctl", "service", "launchctl", "reboot", "shutdown", "mount", "umount"].includes(executable ?? "")) {
			findings.push(decision("risky", "host-system-control", action, "the command can alter services or host system state", executable, "use a project-local container or development process"));
		}
		if (["kill", "killall", "pkill"].includes(executable ?? "")) {
			findings.push(decision("risky", "process-control", action, "the command terminates running processes and may affect unrelated work", words.slice(1).join(" "), "stop the specific project process through its task runner"));
		}
		if ((executable === "npm" || executable === "pnpm" || executable === "yarn") && words.some((w) => w === "-g" || w === "--global")) {
			findings.push(decision("risky", "global-package-change", action, "the command modifies global package-manager state", executable, "install the dependency in the project instead"));
		}
		if (["brew", "apt", "apt-get", "dnf", "yum", "pacman"].includes(executable ?? "") && words.some((word) => /^(?:install|remove|uninstall|upgrade|update)$/.test(word))) {
			findings.push(decision("risky", "host-package-change", action, "the command changes host package-manager state", executable, "use a project-local dependency or isolated container"));
		}
		if (["docker", "podman"].includes(executable ?? "") && words.includes("system") && words.includes("prune")) {
			findings.push(decision("risky", "container-system-prune", action, "system prune can remove unrelated images, containers, networks, and cached data", executable, "remove a specifically named project resource"));
		} else if (["docker", "podman"].includes(executable ?? "") && words.some((word) => /^(?:rm|rmi|prune|stop|kill|down)$/.test(word))) {
			findings.push(decision("risky", "container-state-change", action, "the command removes or stops container resources and may affect other work", words.slice(1).join(" "), "target a specifically named project resource after listing it"));
		}
		if (executable === "kubectl" && words.some((word) => /^(?:delete|drain)$/.test(word))) {
			findings.push(decision("risky", "cluster-state-change", action, "the command deletes or drains cluster resources", words.slice(1).join(" "), "inspect the active context and target resource first"));
		}
		if (executable === "terraform" && words.includes("destroy")) {
			findings.push(decision("risky", "infrastructure-destroy", action, "terraform destroy can irreversibly remove shared infrastructure", currentCwd, "create and review a destroy plan before applying it"));
		} else if (executable === "terraform" && words.includes("apply")) {
			findings.push(decision("risky", "infrastructure-apply", action, "terraform apply changes external infrastructure", currentCwd, "review a saved terraform plan before applying it"));
		}
		if (executable === "git") {
			const gitWords = words[1] === "-C" ? ["git", ...words.slice(3)] : words;
			if (gitWords[1] === "config" && gitCommandMutates(gitWords) && gitWords.some((word) => word === "--global" || word === "--system")) {
				findings.push(decision("risky", "global-git-config", action, "the command changes Git configuration outside the repository", gitWords.join(" "), "set repository-local configuration without --global or --system"));
			}
			if (words[1] === "-C" && words[2] && gitCommandMutates(gitWords)) {
				const pathFinding = evaluateMutationPath(words[2], { ...input, cwd: currentCwd, workspace: input.workspace ?? input.cwd }, action, "write");
				if (pathFinding?.rule === "outside-workspace") findings.push(pathFinding);
			}
			for (const candidate of GIT_OPERATIONS) {
				if (!candidate.test(gitWords)) continue;
				const policy = config.git?.[candidate.operation] ?? DEFAULT_GIT_POLICY[candidate.operation];
				findings.push(decision(policy === "block" ? "prohibited" : "risky", `git-${candidate.operation}`, action, candidate.reason, currentCwd, candidate.alternative));
			}
		}
		if (executable === "xargs" && words.some((w) => /^(?:rm|unlink|rmdir)$/.test(w))) {
			findings.push(decision("risky", "indirect-recursive-delete", action, "xargs hides the full set of deletion targets from pre-execution inspection", undefined, "enumerate and review the exact paths before deleting them"));
		}
		if (executable === "find" && words.some((word, index) => (word === "-exec" || word === "-execdir") && /^(?:rm|unlink|rmdir|shred)$/.test(words[index + 1] ?? ""))) {
			findings.push(decision("risky", "indirect-recursive-delete", action, "find -exec hides the full set of deletion targets from pre-execution inspection", undefined, "print and review the exact matches before deleting them"));
		}
		if (executable === "find" && words.includes("-delete")) {
			const root = words.slice(1).find((w) => !w.startsWith("-")) ?? ".";
			const pathFinding = evaluateMutationPath(root, { ...input, cwd: currentCwd, workspace: input.workspace ?? input.cwd }, action, "delete");
			if (pathFinding) findings.push(pathFinding);
			else findings.push(decision("risky", "recursive-delete", action, "find -delete recursively removes every matching path", root, "run find without -delete first to review the matches"));
		}
		for (const operand of pathOperands(words)) {
			const pathFinding = evaluateMutationPath(operand.path, { ...input, cwd: currentCwd, workspace: input.workspace ?? input.cwd }, action, operand.kind);
			if (pathFinding) findings.push(pathFinding);
		}
		for (const path of redirectionPaths(rawWords)) {
			const pathFinding = evaluateMutationPath(path, { ...input, cwd: currentCwd, workspace: input.workspace ?? input.cwd }, action, "write");
			if (pathFinding) findings.push(pathFinding);
		}
		if (["shred", "srm", "wipe"].includes(executable ?? "")) {
			findings.push(decision("risky", "irreversible-delete", action, "secure deletion is intentionally difficult or impossible to recover", pathOperands(words).map((x) => x.path).join(", "), "use ordinary deletion or move files to a temporary backup first"));
		}
		if ((executable === "rm" || executable === "rmdir") && words.some((w) => /^-[^-]*r/i.test(w) || w === "--recursive")) {
			const targets = pathOperands(words).map((x) => x.path);
			if (targets.some((target) => target === "." || target === "./" || target === "*" || target === "./*" || target === ":/")) {
				findings.push(decision("prohibited", "workspace-root-delete", action, "recursive deletion targets the workspace root or an unrestricted top-level glob", targets.join(", "), "delete a specifically named generated directory after reviewing it"));
			} else {
				findings.push(decision("risky", "recursive-delete", action, "recursive deletion can irreversibly remove a directory tree", targets.join(", "), "delete named files or an empty directory, or move the directory to a temporary backup first"));
			}
		}
		if (executable === "dd") {
			const target = words.find((w) => w.startsWith("of="))?.slice(3);
			if (target) {
				const pathFinding = evaluateMutationPath(target, { ...input, cwd: currentCwd, workspace: input.workspace ?? input.cwd }, action, "write");
				if (pathFinding) findings.push(pathFinding);
				else findings.push(decision("risky", "raw-overwrite", action, "dd overwrites its destination without normal file safeguards", target, "use a normal file copy when possible"));
			}
		}
	}
	const strongestFinding = strongest(findings);
	if (strongestFinding) return strongestFinding;
	try {
		if (compilePatterns(config.confirmCommands).some((pattern) => pattern.test(command))) {
			return decision("risky", "configured-confirm-command", action, "the command matches confirmCommands in .pi/safety-gate.json");
		}
	} catch (error) {
		return decision("prohibited", "invalid-config", action, error instanceof Error ? error.message : "invalid confirmCommands pattern");
	}
	return decision("safe", "ordinary-command", action, "no risky mutation, protected path, or destructive operation was detected");
}

export function evaluateToolAction(input: EvaluationInput): Decision {
	const action = input.toolName === "bash" ? String(input.input.command ?? "") : `${input.toolName} ${String(input.input.path ?? "")}`.trim();
	try {
		const env = input.env ?? process.env;
		const home = input.home ?? env.HOME ?? "";
		for (const path of [...(input.config?.protectedPaths ?? []), ...(input.config?.allowedExternalPaths ?? [])]) configuredPath(path, input.cwd, home, env);
	} catch (error) {
		return decision("prohibited", "invalid-config", action, error instanceof Error ? error.message : "invalid path configuration");
	}
	if (input.toolName === "bash") return evaluateBash(input);
	if (input.toolName === "write" || input.toolName === "edit") {
		const rawPath = String(input.input.path ?? "");
		try {
			return evaluateMutationPath(rawPath, input, action, "write") ?? decision("safe", "workspace-edit", action, "routine edit inside the active workspace", canonicalize(resolve(input.cwd, rawPath)));
		} catch (error) {
			return decision("prohibited", "invalid-config", action, error instanceof Error ? error.message : "invalid path configuration");
		}
	}
	return decision("safe", "non-mutating-tool", action, "the tool is not a built-in mutation surface covered by this gate");
}
