const BUILT_INS = [
	/(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
	/\b(?:sk|ghp)_[A-Za-z0-9_-]{16,}\b/g,
	/-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g,
];

export function redactText(text: string, extra: RegExp[] = []): string {
	return [...BUILT_INS, ...extra].reduce((result, pattern) => result.replace(pattern, "[REDACTED]"), text);
}

export function redact<T>(value: T, extra: RegExp[] = []): T {
	if (typeof value === "string") return redactText(value, extra) as T;
	if (Array.isArray(value)) return value.map((item) => redact(item, extra)) as T;
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redact(item, extra)])) as T;
	return value;
}

