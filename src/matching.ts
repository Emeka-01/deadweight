
// `const { A, B: renamed, C = 'x' } = process.env` (or import.meta.env)
const ENV_DESTRUCTURE = /\{([^{}]*)\}\s*=\s*(?:process\.env|import\.meta\.env)\b/g;

// $KEY or ${KEY} (also ${KEY:-default}), not escaped as \$KEY.
const ENV_VALUE_REF = /(?<!\\)\$\{?([A-Za-z_][A-Za-z0-9_]*)/g;

// `# deadweight-ignore` (.env) or `// deadweight-ignore` (tsconfig), at the end of the line or on the line above.
const IGNORE_SAME_LINE = /(?:#|\/\/)\s*deadweight-ignore\b/;
const IGNORE_LINE_ABOVE = /^\s*(?:#|\/\/)\s*deadweight-ignore\b/;

// Keys pulled out of process.env / import.meta.env by destructuring. `...rest` is skipped.
export function destructuredEnvKeys(text: string): string[] {
	const keys: string[] = [];
	for (const match of text.matchAll(ENV_DESTRUCTURE)) {
		for (const part of match[1].split(',')) {
			const trimmed = part.trim();
			if (trimmed.startsWith('...')) {
				continue;
			}
			const name = /^["']?([A-Za-z_][A-Za-z0-9_]*)/.exec(trimmed)?.[1];
			if (name) {
				keys.push(name);
			}
		}
	}
	return keys;
}

// Other keys referenced in a .env value, e.g. `URL=http://${HOST}:$PORT` -> [HOST, PORT].
// Single-quoted values are literal (not expanded), so they reference nothing.
export function envValueRefs(lineText: string): string[] {
	const eq = lineText.indexOf('=');
	if (eq === -1) {
		return [];
	}
	const value = lineText.slice(eq + 1).trim();
	if (value.startsWith("'")) {
		return [];
	}
	return [...value.matchAll(ENV_VALUE_REF)].map((m) => m[1]);
}

export function hasIgnoreComment(line: string, lineAbove: string | undefined): boolean {
	return IGNORE_SAME_LINE.test(line) || (lineAbove !== undefined && IGNORE_LINE_ABOVE.test(lineAbove));
}

// Builds a matcher from the `deadweight.ignore` setting. `*` matches any characters (NEXT_PUBLIC_*).
export function ignoreMatcher(patterns: readonly string[]): (name: string) => boolean {
	const regexes = patterns.map((p) => new RegExp(`^${p.split('*').map(escapeRegExp).join('.*')}$`));
	return (name) => regexes.some((r) => r.test(name));
}

export function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
