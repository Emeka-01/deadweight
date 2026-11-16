
// process.env.KEY / import.meta.env.KEY (also ?.KEY), plus the ["KEY"] and ['KEY'] forms
const ENV_USAGE = /(?:process\.env|import\.meta\.env)(?:\??\.([A-Za-z_][A-Za-z0-9_]*)|(?:\?\.)?\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\])/g;

// `const { A, B: renamed, C = 'x' } = process.env` (or import.meta.env)
const ENV_DESTRUCTURE = /\{([^{}]*)\}\s*=\s*(?:process\.env|import\.meta\.env)\b/g;

// process.env[someVariable] - a key that can't be known by reading the code.
const ENV_COMPUTED = /(?:process\.env|import\.meta\.env)\s*(?:\?\.)?\[\s*(?!["'][A-Za-z_][A-Za-z0-9_]*["']\s*\])/;
// process.env used as a whole object: passed to a function, spread, Object.keys(...), ...
// Destructuring (`} = process.env`) and property reads (`process.env.X`) are excluded.
const ENV_WHOLE_OBJECT = /(?<!\}\s*=\s*)(?:process\.env|import\.meta\.env)(?!\s*(?:\?\.|\.|\[)|\w)/;

// `from 'x'`, `import 'x'`, `import('x')`, `require('x')` and `require.resolve('x')`
const IMPORT_USAGE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire(?:\.resolve)?\s*\(\s*)["']([^"'\s]+)["']/g;

// Every env key the text reads by name, directly or by destructuring.
export function envKeysRead(text: string): string[] {
	return [...[...text.matchAll(ENV_USAGE)].map((m) => m[1] ?? m[2]), ...destructuredEnvKeys(text)];
}

// True if the text reads env vars in a way that hides which keys: computed keys or the whole object.
export function hasDynamicEnvAccess(text: string): boolean {
	return ENV_COMPUTED.test(text) || ENV_WHOLE_OBJECT.test(text);
}

export function importSpecifiers(text: string): string[] {
	return [...text.matchAll(IMPORT_USAGE)].map((m) => m[1]);
}

// "lodash/fp" -> "lodash", "@scope/pkg/sub" -> "@scope/pkg"; relative paths and node:/virtual: imports -> undefined.
export function packageName(specifier: string): string | undefined {
	if (/^[./#]/.test(specifier) || specifier.includes(':')) {
		return undefined;
	}
	const parts = specifier.split('/');
	if (specifier.startsWith('@')) {
		return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined;
	}
	return parts[0];
}

// True if `name` appears as a whole package name: "tailwindcss" matches `tailwindcss: {}` and "tailwindcss/plugin", but not "prettier-plugin-tailwindcss".
export function mentions(text: string, name: string): boolean {
	return new RegExp(`(^|[^\\w@/.-])${escapeRegExp(name)}($|[^\\w.-])`).test(text);
}

// The short names ESLint configs use for plugins and shared configs: eslint-plugin-react -> react, @scope/eslint-plugin -> @scope, @scope/eslint-config-x -> @scope/x.
export function eslintShortNames(name: string): string[] {
	const scoped = /^(@[^/]+)\/eslint-(?:plugin|config)(?:-(.+))?$/.exec(name);
	if (scoped) {
		return [scoped[2] ? `${scoped[1]}/${scoped[2]}` : scoped[1]];
	}
	const plain = /^eslint-(?:plugin|config)-(.+)$/.exec(name);
	return plain ? [plain[1]] : [];
}

// "@/*" matches any import starting with "@/"; an alias without "*" must match exactly.
export function isAliasUsed(alias: string, specifiers: Iterable<string>): boolean {
	const star = alias.indexOf('*');
	if (star === -1) {
		for (const s of specifiers) {
			if (s === alias) {
				return true;
			}
		}
		return false;
	}
	const prefix = alias.slice(0, star);
	const suffix = alias.slice(star + 1);
	if (!prefix && !suffix) {
		return true;
	}
	for (const s of specifiers) {
		if (s.length >= prefix.length + suffix.length && s.startsWith(prefix) && s.endsWith(suffix)) {
			return true;
		}
	}
	return false;
}

// The deepest folder in `dirs` that contains `path`, or undefined. Paths use "/" separators.
export function deepestContaining(path: string, dirs: readonly string[]): string | undefined {
	let best: string | undefined;
	for (const dir of dirs) {
		if (isInside(path, dir) && (best === undefined || dir.length > best.length)) {
			best = dir;
		}
	}
	return best;
}

export function isInside(path: string, dir: string): boolean {
	const prefix = dir.endsWith('/') ? dir : `${dir}/`;
	return path.toLowerCase().startsWith(prefix.toLowerCase());
}

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
