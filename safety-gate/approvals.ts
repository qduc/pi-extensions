import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Decision } from "./policy.ts";

export type ApprovalScope = "session" | "project";

export interface ApprovalContext {
	toolName: string;
	workspace: string;
	trusted: boolean;
}

export interface StoredApproval {
	id: string;
	scope: ApprovalScope;
	toolName: string;
	rule: string;
	workspace: string;
	action: string;
	affected?: string;
	createdAt: string;
	lastUsedAt: string;
}

interface ApprovalFile {
	version: 1;
	projects: Record<string, StoredApproval[]>;
}

function normalizeAction(action: string): string {
	return action.trim();
}

function fingerprint(decision: Pick<Decision, "rule" | "action" | "affected">, context: ApprovalContext): string {
	return JSON.stringify({
		toolName: context.toolName,
		rule: decision.rule,
		workspace: resolve(context.workspace),
		action: normalizeAction(decision.action),
		affected: decision.affected ? resolve(context.workspace, decision.affected) : undefined,
	});
}

function validateFile(value: unknown): ApprovalFile {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("approval store must be an object");
	const raw = value as Record<string, unknown>;
	if (raw.version !== 1 || !raw.projects || typeof raw.projects !== "object" || Array.isArray(raw.projects)) throw new Error("unsupported approval store format");
	for (const entries of Object.values(raw.projects as Record<string, unknown>)) {
		if (!Array.isArray(entries)) throw new Error("project approvals must be arrays");
		for (const entry of entries) {
			if (!entry || typeof entry !== "object") throw new Error("invalid approval entry");
			const item = entry as Record<string, unknown>;
			for (const field of ["id", "scope", "toolName", "rule", "workspace", "action", "createdAt", "lastUsedAt"]) {
				if (typeof item[field] !== "string") throw new Error(`invalid approval field: ${field}`);
			}
			if (item.scope !== "project") throw new Error("persistent approvals must have project scope");
			if (item.affected !== undefined && typeof item.affected !== "string") throw new Error("invalid approval affected path");
		}
	}
	return raw as unknown as ApprovalFile;
}

export class ApprovalStore {
	private readonly session = new Map<string, StoredApproval>();
	private readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	private async load(): Promise<ApprovalFile> {
		try {
			return validateFile(JSON.parse(await readFile(this.path, "utf8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, projects: {} };
			throw new Error(`Invalid safety-gate approval store: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async save(file: ApprovalFile): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
		await rename(temporary, this.path);
	}

	async isApproved(decision: Decision, context: ApprovalContext): Promise<boolean> {
		const key = fingerprint(decision, context);
		if (this.session.has(key)) return true;
		if (!context.trusted) return false;
		const file = await this.load();
		const entries = file.projects[resolve(context.workspace)] ?? [];
		const found = entries.find((entry) => fingerprint(entry, context) === key);
		if (!found) return false;
		found.lastUsedAt = new Date().toISOString();
		await this.save(file);
		return true;
	}

	async remember(decision: Decision, context: ApprovalContext, scope: ApprovalScope): Promise<void> {
		if (decision.outcome !== "risky") throw new Error("only risky decisions can be approved");
		if (scope === "project" && !context.trusted) throw new Error("project approvals require a trusted project");
		const now = new Date().toISOString();
		const entry: StoredApproval = {
			id: randomUUID(), scope, toolName: context.toolName, rule: decision.rule,
			workspace: resolve(context.workspace), action: normalizeAction(decision.action),
			affected: decision.affected ? resolve(context.workspace, decision.affected) : undefined, createdAt: now, lastUsedAt: now,
		};
		const key = fingerprint(decision, context);
		if (scope === "session") {
			this.session.set(key, entry);
			return;
		}
		const file = await this.load();
		const entries = file.projects[entry.workspace] ??= [];
		if (!entries.some((candidate) => fingerprint(candidate, context) === key)) entries.push(entry);
		await this.save(file);
	}

	async list(context: ApprovalContext): Promise<StoredApproval[]> {
		const session = [...this.session.values()].filter((entry) => entry.workspace === resolve(context.workspace));
		if (!context.trusted) return session;
		const file = await this.load();
		return [...session, ...(file.projects[resolve(context.workspace)] ?? [])];
	}

	async revoke(id: string, context: ApprovalContext): Promise<void> {
		for (const [key, entry] of this.session) if (entry.id === id) this.session.delete(key);
		if (!context.trusted) return;
		const file = await this.load();
		const workspace = resolve(context.workspace);
		file.projects[workspace] = (file.projects[workspace] ?? []).filter((entry) => entry.id !== id);
		await this.save(file);
	}

	async clear(scope: ApprovalScope | "all", context: ApprovalContext): Promise<void> {
		if (scope !== "project") {
			for (const [key, entry] of this.session) if (entry.workspace === resolve(context.workspace)) this.session.delete(key);
		}
		if (scope !== "session" && context.trusted) {
			const file = await this.load();
			delete file.projects[resolve(context.workspace)];
			if (Object.keys(file.projects).length) await this.save(file);
			else await rm(this.path, { force: true });
		}
	}
}
