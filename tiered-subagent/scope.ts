import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function canonicalize(input: string): string {
	let current = resolve(input);
	const missing: string[] = [];
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) break;
		missing.unshift(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
		current = parent;
	}
	try { return join(realpathSync.native(current), ...missing); }
	catch { return resolve(input); }
}

export function isInside(path: string, root: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function resolveScopes(cwd: string, requested: string[], configuredAllowed: string[], protectedPaths: string[]): string[] {
	const allowedRoots = configuredAllowed.map((path) => canonicalize(resolve(cwd, path)));
	const protectedRoots = protectedPaths.map((path) => canonicalize(resolve(cwd, path)));
	const scopes = (requested.length ? requested : configuredAllowed).map((path) => canonicalize(resolve(cwd, path)));
	for (const scope of scopes) {
		if (!allowedRoots.some((root) => isInside(scope, root))) throw new Error(`Requested scope is not allowed: ${scope}`);
		if (protectedRoots.some((root) => isInside(scope, root))) throw new Error(`Requested scope is protected: ${scope}`);
	}
	return [...new Set(scopes)];
}

export function scopesOverlap(left: string[], right: string[]): boolean {
	return left.some((a) => right.some((b) => isInside(a, b) || isInside(b, a)));
}
