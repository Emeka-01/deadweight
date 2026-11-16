import * as vscode from 'vscode';
import { findNodeAtLocation, findNodeAtOffset, getNodePath, getNodeValue, parseTree } from 'jsonc-parser';
import type { Node as JsonNode } from 'jsonc-parser';
import { removeJsonNode } from './jsonEdit';
import {
	deepestContaining,
	envKeysRead,
	envValueRefs,
	eslintShortNames,
	hasDynamicEnvAccess,
	hasIgnoreComment,
	ignoreMatcher,
	importSpecifiers,
	isAliasUsed,
	isInside,
	mentions,
	packageName,
} from './matching';

const SOURCE_EXTS = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte', 'astro'];
const SOURCE_GLOB = `**/*.{${SOURCE_EXTS.join(',')}}`;
const SOURCE_RE = new RegExp(`\\.(${SOURCE_EXTS.join('|')})$`);
// Tool config files (vite.config.ts, .babelrc, tsconfig.json, ...) often name packages without importing them.
const CONFIG_GLOB = '**/{*.config.*,.*rc,.*rc.*,tsconfig*.json,jsconfig*.json}';
const CONFIG_RE = /(\.config\.[^./]+|\/\.[^/]*rc(\.[^./]+)?|\/[tj]sconfig[^/]*\.json)$/;
const TSCONFIG_GLOB = '**/{tsconfig,jsconfig}*.json';
const TSCONFIG_RE = /\/[tj]sconfig[^/]*\.json$/;
const EXCLUDE_GLOB = '**/{node_modules,dist,out,build,coverage,.git,.next,.svelte-kit}/**';

// Matches a KEY=value line, optionally prefixed with "export"
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

// Runtime dependencies are always checked; devDependencies only with `deadweight.checkDevDependencies`, since they're mostly CLI tools and type packages that are harder to detect.
const DEP_SECTIONS = ['dependencies', 'optionalDependencies'];

// Extensions TypeScript tries when a path target has no wildcard ("@utils": ["src/utils"]).
const TARGET_EXTENSIONS = ['', '.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.json'];

const UNUSED_ENV_KEY = 'unused-env-key';
const UNUSED_DEPENDENCY = 'unused-dependency';
const UNUSED_PATH_ALIAS = 'unused-path-alias';
const DEAD_PATH_ALIAS = 'dead-path-alias';
const MISSING_PATH_TARGET = 'missing-path-target';

const FIX_LABELS: Record<string, string> = {
	[UNUSED_ENV_KEY]: 'Remove unused key',
	[UNUSED_DEPENDENCY]: 'Remove unused dependency',
	[UNUSED_PATH_ALIAS]: 'Remove unused path alias',
	[DEAD_PATH_ALIAS]: 'Remove dead path alias',
	[MISSING_PATH_TARGET]: 'Remove missing path target',
};

let diagnostics: vscode.DiagnosticCollection;

export function activate(context: vscode.ExtensionContext) {
	diagnostics = vscode.languages.createDiagnosticCollection('deadweight');
	context.subscriptions.push(diagnostics);

	context.subscriptions.push(
		vscode.commands.registerCommand('deadweight.scan', async () => {
			const { envKeys, dependencies, paths } = await scanWorkspace();
			const parts = [
				plural(envKeys, 'unused .env key', 'unused .env keys'),
				plural(dependencies, 'unused dependency', 'unused dependencies'),
				plural(paths, 'dead tsconfig path', 'dead tsconfig paths'),
			];
			vscode.window.showInformationMessage(
				envKeys + dependencies + paths === 0
					? 'Deadweight: nothing unused found.'
					: `Deadweight: found ${parts.join(', ')}.`
			);
		})
	);

	// Rescan whenever a relevant file is saved (debounced so "Save All" triggers a single scan instead of one per file).
	let timer: ReturnType<typeof setTimeout> | undefined;
	const scheduleScan = () => {
		clearTimeout(timer);
		timer = setTimeout(() => void scanWorkspace(), 300);
	};
	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument((doc) => {
			if (isRelevant(doc.uri)) {
				scheduleScan();
			}
		}),
		// Rescan while a flagged file is being edited, so warnings move with the lines after a Quick Fix (or manual edit) instead of pointing at stale lines.
		vscode.workspace.onDidChangeTextDocument((e) => {
			if (isEnvFile(e.document.uri) || isPackageJson(e.document.uri) || isTsconfig(e.document.uri)) {
				scheduleScan();
			}
		}),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('deadweight')) {
				scheduleScan();
			}
		}),
		{ dispose: () => clearTimeout(timer) }
	);

	// Used by the "Always ignore" Quick Fix; hidden from the Command Palette.
	context.subscriptions.push(
		vscode.commands.registerCommand('deadweight.ignoreName', async (name: string, scope: vscode.Uri) => {
			const config = vscode.workspace.getConfiguration('deadweight', scope);
			const current = config.get<string[]>('ignore', []);
			if (!current.includes(name)) {
				const target = vscode.workspace.workspaceFolders
					? vscode.ConfigurationTarget.Workspace
					: vscode.ConfigurationTarget.Global;
				await config.update('ignore', [...current, name], target);
			}
		})
	);

	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider(
			[{ pattern: '**/.env*' }, { pattern: '**/package.json' }, { pattern: TSCONFIG_GLOB }],
			new RemoveUnusedProvider(),
			{ providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
		)
	);

	// Initial scan so warnings appear without running the command.
	void scanWorkspace();
}

function plural(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

// Templates list keys on purpose without using them, so they are never flagged.
const ENV_TEMPLATE_SUFFIXES = ['.example', '.sample', '.template', '.dist'];

function fileName(uri: vscode.Uri): string {
	return uri.path.split('/').pop() ?? '';
}

// .env, .env.local, .env.production, ... but not .env.example and friends.
function isEnvFile(uri: vscode.Uri): boolean {
	const name = fileName(uri);
	if (name === '.env') {
		return true;
	}
	return name.startsWith('.env.') && !ENV_TEMPLATE_SUFFIXES.some((s) => name.endsWith(s));
}

function isPackageJson(uri: vscode.Uri): boolean {
	return fileName(uri) === 'package.json';
}

function isTsconfig(uri: vscode.Uri): boolean {
	return TSCONFIG_RE.test(uri.path);
}

function isConfigFile(uri: vscode.Uri): boolean {
	return CONFIG_RE.test(uri.path);
}

function isRelevant(uri: vscode.Uri): boolean {
	return isEnvFile(uri) || isPackageJson(uri) || isConfigFile(uri) || SOURCE_RE.test(uri.path);
}

class RemoveUnusedProvider implements vscode.CodeActionProvider {
	provideCodeActions(
		document: vscode.TextDocument,
		_range: vscode.Range,
		context: vscode.CodeActionContext
	): vscode.CodeAction[] {
		const ours = context.diagnostics.filter((d) => d.source === 'deadweight');
		if (ours.length === 0) {
			return [];
		}
		const all = (diagnostics.get(document.uri) ?? []).filter((d) => d.source === 'deadweight');
		const isEnv = isEnvFile(document.uri);
		const removeEdit = isEnv ? removeEnvLines : removeJsonEntries;
		const actions: vscode.CodeAction[] = [];

		for (const diagnostic of ours) {
			const label = FIX_LABELS[String(diagnostic.code)] ?? 'Remove';
			const action = new vscode.CodeAction(`${label} '${document.getText(diagnostic.range)}'`, vscode.CodeActionKind.QuickFix);
			action.edit = removeEdit(document, [diagnostic]);
			action.diagnostics = [diagnostic];
			action.isPreferred = diagnostic.severity === vscode.DiagnosticSeverity.Warning;
			actions.push(action);
		}

		if (all.length > 1) {
			const what = isEnv ? 'unused keys' : isPackageJson(document.uri) ? 'unused dependencies' : 'dead path entries';
			const action = new vscode.CodeAction(`Remove all ${all.length} ${what} in this file`, vscode.CodeActionKind.QuickFix);
			action.edit = removeEdit(document, all);
			action.diagnostics = [...all];
			actions.push(action);
		}

		for (const diagnostic of ours) {
			const name = document.getText(diagnostic.range);

			// package.json can't hold comments, so it only gets the setting-based option.
			if (!isPackageJson(document.uri)) {
				const action = new vscode.CodeAction(`Ignore '${name}' with a comment`, vscode.CodeActionKind.QuickFix);
				action.edit = insertIgnoreComment(document, diagnostic.range.start.line, isEnv ? '#' : '//');
				action.diagnostics = [diagnostic];
				actions.push(action);
			}

			const action = new vscode.CodeAction(`Always ignore '${name}' in this workspace`, vscode.CodeActionKind.QuickFix);
			action.command = { title: action.title, command: 'deadweight.ignoreName', arguments: [name, document.uri] };
			action.diagnostics = [diagnostic];
			actions.push(action);
		}

		return actions;
	}
}

// Adds "# deadweight-ignore" (or "//") on its own line above, matching the line's indentation.
function insertIgnoreComment(document: vscode.TextDocument, line: number, marker: string): vscode.WorkspaceEdit {
	const indent = /^\s*/.exec(document.lineAt(line).text)?.[0] ?? '';
	const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
	const edit = new vscode.WorkspaceEdit();
	edit.insert(document.uri, new vscode.Position(line, 0), `${indent}${marker} deadweight-ignore${eol}`);
	return edit;
}

function removeEnvLines(document: vscode.TextDocument, diags: readonly vscode.Diagnostic[]): vscode.WorkspaceEdit {
	const edit = new vscode.WorkspaceEdit();
	for (const d of diags) {
		edit.delete(document.uri, fullLine(document, d.range.start.line));
	}
	return edit;
}

// Removes the flagged JSON entries (object properties or array items), fixing up commas so the JSON stays valid.
function removeJsonEntries(document: vscode.TextDocument, diags: readonly vscode.Diagnostic[]): vscode.WorkspaceEdit {
	const original = document.getText();
	const root = parseTree(original, [], { allowTrailingComma: true });
	const sorted = [...diags].sort((a, b) => b.range.start.compareTo(a.range.start));
	const paths = root
		? sorted.map((d) => {
				const node = findNodeAtOffset(root, document.offsetAt(d.range.start), true);
				return node ? getNodePath(node) : undefined;
			})
		: [];

	let text = original;
	for (const path of paths) {
		if (path) {
			text = removeJsonNode(text, path);
		}
	}

	const edit = new vscode.WorkspaceEdit();
	edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(original.length)), text);
	return edit;
}

// The whole line including its line break, so no blank line is left behind.
function fullLine(document: vscode.TextDocument, line: number): vscode.Range {
	return line + 1 < document.lineCount
		? new vscode.Range(line, 0, line + 1, 0)
		: document.lineAt(line).rangeIncludingLineBreak;
}

// What one source or config file uses.
interface FileUsage {
	uri: vscode.Uri;
	envKeys: string[];
	specifiers: string[];
	configText?: string;
	dynamicEnv: boolean;
	// Every word in the file, kept only for files with dynamic env access (see scanEnvFiles).
	words?: Set<string>;
}

// What a group of files uses, merged.
interface Usage {
	envKeys: Set<string>;
	packages: Set<string>;
	specifiers: Set<string>;
	configs: { uri: vscode.Uri; text: string }[];
	dynamicEnvFiles: vscode.Uri[];
	words: Set<string>;
}

async function scanWorkspace(): Promise<{ envKeys: number; dependencies: number; paths: number }> {
	const [envFiles, packageFiles, tsconfigFiles, fileUsages] = await Promise.all([
		vscode.workspace.findFiles('**/.env*', EXCLUDE_GLOB).then((uris) => uris.filter(isEnvFile)),
		vscode.workspace.findFiles('**/package.json', EXCLUDE_GLOB),
		vscode.workspace.findFiles(TSCONFIG_GLOB, EXCLUDE_GLOB),
		collectFileUsages(),
	]);

	// Monorepo support: each config file only counts usage from the package it belongs to (the deepest folder with a package.json above it), including any packages nested inside that one. A root package therefore sees the whole repo, while packages/api/.env only sees code under packages/api.
	const packageRoots = packageFiles.map((uri) => vscode.Uri.joinPath(uri, '..').path);
	const scopeOf = (uri: vscode.Uri): string =>
		deepestContaining(uri.path, packageRoots) ?? vscode.workspace.getWorkspaceFolder(uri)?.uri.path ?? '/';
	const usageCache = new Map<string, Usage>();
	const usageFor = (uri: vscode.Uri): Usage => {
		const scope = scopeOf(uri);
		let usage = usageCache.get(scope);
		if (!usage) {
			usage = mergeUsage(fileUsages.filter((f) => isInside(f.uri.path, scope)));
			usageCache.set(scope, usage);
		}
		return usage;
	};

	const isIgnoredName = ignoreMatcher(vscode.workspace.getConfiguration('deadweight').get<string[]>('ignore', []));
	const results = new Map<string, { uri: vscode.Uri; found: vscode.Diagnostic[] }>();
	const counts = { envKeys: 0, dependencies: 0, paths: 0 };

	// .env files are checked per package, so a ${KEY} reference only counts within the same package.
	const envByScope = new Map<string, vscode.Uri[]>();
	for (const uri of envFiles) {
		const scope = scopeOf(uri);
		envByScope.set(scope, [...(envByScope.get(scope) ?? []), uri]);
	}
	for (const uris of envByScope.values()) {
		for (const [key, found] of await scanEnvFiles(uris, usageFor(uris[0]), isIgnoredName)) {
			results.set(key, { uri: found.uri, found: found.diagnostics });
			counts.envKeys += found.diagnostics.length;
		}
	}
	for (const uri of packageFiles) {
		const found = await withoutIgnored(uri, await scanPackageJson(uri, usageFor(uri)), isIgnoredName);
		results.set(uri.toString(), { uri, found });
		counts.dependencies += found.length;
	}
	for (const uri of tsconfigFiles) {
		const found = await withoutIgnored(uri, await scanTsconfig(uri, usageFor(uri)), isIgnoredName);
		results.set(uri.toString(), { uri, found });
		counts.paths += found.length;
	}

	diagnostics.clear();
	for (const { uri, found } of results.values()) {
		diagnostics.set(uri, found);
	}
	return counts;
}

function mergeUsage(files: FileUsage[]): Usage {
	const usage: Usage = {
		envKeys: new Set(),
		packages: new Set(),
		specifiers: new Set(),
		configs: [],
		dynamicEnvFiles: [],
		words: new Set(),
	};
	for (const file of files) {
		file.envKeys.forEach((k) => usage.envKeys.add(k));
		for (const specifier of file.specifiers) {
			usage.specifiers.add(specifier);
			const pkg = packageName(specifier);
			if (pkg) {
				usage.packages.add(pkg);
			}
		}
		if (file.configText !== undefined) {
			usage.configs.push({ uri: file.uri, text: file.configText });
		}
		if (file.dynamicEnv) {
			usage.dynamicEnvFiles.push(file.uri);
			file.words?.forEach((w) => usage.words.add(w));
		}
	}
	return usage;
}

// Drops findings silenced by the `deadweight.ignore` setting or a `deadweight-ignore` comment.
async function withoutIgnored(
	uri: vscode.Uri,
	found: vscode.Diagnostic[],
	isIgnoredName: (name: string) => boolean
): Promise<vscode.Diagnostic[]> {
	if (found.length === 0) {
		return found;
	}
	const doc = await vscode.workspace.openTextDocument(uri);
	return found.filter((d) => {
		const line = d.range.start.line;
		const above = line > 0 ? doc.lineAt(line - 1).text : undefined;
		return !isIgnoredName(doc.getText(d.range)) && !hasIgnoreComment(doc.lineAt(line).text, above);
	});
}

interface EnvEntry {
	uri: vscode.Uri;
	key: string;
	range: vscode.Range;
	refs: string[];
	ignored: boolean;
}

async function scanEnvFiles(
	uris: vscode.Uri[],
	usage: Usage,
	isIgnoredName: (name: string) => boolean
): Promise<Map<string, { uri: vscode.Uri; diagnostics: vscode.Diagnostic[] }>> {
	const entries: EnvEntry[] = [];
	for (const uri of uris) {
		const doc = await vscode.workspace.openTextDocument(uri);
		for (let i = 0; i < doc.lineCount; i++) {
			const text = doc.lineAt(i).text;
			const match = ENV_LINE.exec(text);
			if (!match) {
				continue;
			}
			const key = match[1];
			const start = text.indexOf(key);
			entries.push({
				uri,
				key,
				range: new vscode.Range(i, start, i, start + key.length),
				refs: envValueRefs(text),
				ignored: isIgnoredName(key) || hasIgnoreComment(text, i > 0 ? doc.lineAt(i - 1).text : undefined),
			});
		}
	}

	// Code that reads env vars dynamically (process.env[name], cleanEnv(process.env, {...})) can use any key. Keys named anywhere in those files count as used (validation schemas list them as object keys); the rest are still reported, but as information instead of warnings.
	const dynamic = usage.dynamicEnvFiles.length > 0;

	// A key is used if code reads it, if it's ignored, or if a used key's value references it (URL=http://${HOST}:3000 keeps HOST alive as long as URL is used).
	const used = new Set(usage.envKeys);
	for (const entry of entries) {
		if (entry.ignored || (dynamic && usage.words.has(entry.key))) {
			used.add(entry.key);
		}
	}
	const queue = [...used];
	while (queue.length > 0) {
		const key = queue.pop()!;
		for (const entry of entries) {
			if (entry.key !== key) {
				continue;
			}
			for (const ref of entry.refs) {
				if (!used.has(ref)) {
					used.add(ref);
					queue.push(ref);
				}
			}
		}
	}

	const dynamicNote = dynamic
		? ` It may still be used: ${vscode.workspace.asRelativePath(usage.dynamicEnvFiles[0])}${
				usage.dynamicEnvFiles.length > 1 ? ` (and ${usage.dynamicEnvFiles.length - 1} more)` : ''
			} reads env vars dynamically.`
		: '';

	const results = new Map<string, { uri: vscode.Uri; diagnostics: vscode.Diagnostic[] }>();
	for (const uri of uris) {
		results.set(uri.toString(), { uri, diagnostics: [] });
	}
	for (const entry of entries) {
		if (used.has(entry.key)) {
			continue;
		}
		results.get(entry.uri.toString())?.diagnostics.push(
			makeDiagnostic(
				entry.range,
				`"${entry.key}" is never read via process.env or import.meta.env, directly or through another key's \${...} reference.${dynamicNote}`,
				UNUSED_ENV_KEY,
				dynamic ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Warning
			)
		);
	}
	return results;
}

async function scanPackageJson(uri: vscode.Uri, usage: Usage): Promise<vscode.Diagnostic[]> {
	const doc = await vscode.workspace.openTextDocument(uri);
	const root = parseTree(doc.getText());
	if (!root) {
		return [];
	}

	const scriptsNode = findNodeAtLocation(root, ['scripts']);
	const scripts = (scriptsNode?.children ?? []).map((prop) => String(prop.children?.[1]?.value ?? '')).join('\n');
	const checkDev = vscode.workspace.getConfiguration('deadweight', uri).get<boolean>('checkDevDependencies', false);
	const sections = checkDev ? [...DEP_SECTIONS, 'devDependencies'] : DEP_SECTIONS;

	const candidates: { name: string; section: string; keyNode: JsonNode }[] = [];
	for (const section of sections) {
		for (const prop of findNodeAtLocation(root, [section])?.children ?? []) {
			const keyNode = prop.children?.[0];
			const name = keyNode?.value;
			if (keyNode && typeof name === 'string' && !name.startsWith('@types/')) {
				candidates.push({ name, section, keyNode });
			}
		}
	}

	const used = new Set(usage.packages);
	for (const { name } of candidates) {
		if (await isDependencyUsed(name, usage, scripts, uri)) {
			used.add(name);
		}
	}
	await addPeerDependencies(used, uri);

	return candidates
		.filter(({ name }) => !used.has(name))
		.map(({ name, section, keyNode }) =>
			makeDiagnostic(
				stringRange(doc, keyNode),
				`"${name}" is in ${section} but is never imported, required, used in a script or config file, or needed as a peer by a used package.`,
				UNUSED_DEPENDENCY
			)
		);
}

// Packages a used package declares as peerDependencies are used too: next needs react-dom even if your code never imports it. Repeats until nothing new is added, so peers of peers count as well.
async function addPeerDependencies(used: Set<string>, packageJson: vscode.Uri): Promise<void> {
	const queue = [...used];
	const visited = new Set<string>();
	while (queue.length > 0) {
		const name = queue.pop()!;
		if (visited.has(name)) {
			continue;
		}
		visited.add(name);
		const peers = (await readInstalledManifest(name, packageJson))?.peerDependencies;
		if (!peers || typeof peers !== 'object') {
			continue;
		}
		for (const peer of Object.keys(peers)) {
			if (!used.has(peer)) {
				used.add(peer);
				queue.push(peer);
			}
		}
	}
}

// Looks for node_modules/<relative> next to `from`, then in each parent folder (where monorepos hoist packages).
async function findInNodeModules(from: vscode.Uri, relative: string): Promise<vscode.Uri | undefined> {
	let dir = vscode.Uri.joinPath(from, '..');
	for (let depth = 0; depth < 10; depth++) {
		const candidate = vscode.Uri.joinPath(dir, 'node_modules', relative);
		if (await exists(candidate)) {
			return candidate;
		}
		const parent = vscode.Uri.joinPath(dir, '..');
		if (parent.path === dir.path) {
			break;
		}
		dir = parent;
	}
	return undefined;
}

// The package.json of an installed package.
async function readInstalledManifest(name: string, packageJson: vscode.Uri): Promise<Record<string, unknown> | undefined> {
	const manifest = await findInNodeModules(packageJson, `${name}/package.json`);
	if (!manifest) {
		return undefined;
	}
	try {
		return JSON.parse(await readText(manifest));
	} catch {
		return undefined;
	}
}

async function scanTsconfig(uri: vscode.Uri, usage: Usage): Promise<vscode.Diagnostic[]> {
	const doc = await vscode.workspace.openTextDocument(uri);
	const root = parseTree(doc.getText(), [], { allowTrailingComma: true });
	const pathsNode = root && findNodeAtLocation(root, ['compilerOptions', 'paths']);
	if (!root || !pathsNode || pathsNode.type !== 'object') {
		return [];
	}

	const base = await pathsBase(uri, root);
	const found: vscode.Diagnostic[] = [];

	for (const prop of pathsNode.children ?? []) {
		const [keyNode, targetsNode] = prop.children ?? [];
		const alias = keyNode?.value;
		if (!keyNode || typeof alias !== 'string') {
			continue;
		}

		if (!isAliasUsed(alias, usage.specifiers)) {
			found.push(
				makeDiagnostic(
					stringRange(doc, keyNode),
					`Path alias "${alias}" is never used by an import in this workspace.`,
					UNUSED_PATH_ALIAS
				)
			);
			continue;
		}

		const targets = (targetsNode?.children ?? []).filter((n) => typeof n.value === 'string');
		const missing: JsonNode[] = [];
		for (const target of targets) {
			if (!(await targetExists(base, target.value))) {
				missing.push(target);
			}
		}

		if (targets.length > 0 && missing.length === targets.length) {
			found.push(
				makeDiagnostic(
					stringRange(doc, keyNode),
					`Path alias "${alias}" only points to locations that don't exist.`,
					DEAD_PATH_ALIAS
				)
			);
		} else {
			for (const target of missing) {
				found.push(
					makeDiagnostic(
						stringRange(doc, target),
						`Path target "${target.value}" for alias "${alias}" does not exist.`,
						MISSING_PATH_TARGET
					)
				);
			}
		}
	}
	return found;
}

// Path targets resolve against baseUrl, which may be set in this file or inherited through "extends" (resolved relative to the file that sets it). Without any baseUrl, against this file's own folder.
async function pathsBase(uri: vscode.Uri, root: JsonNode): Promise<vscode.Uri> {
	const own = findNodeAtLocation(root, ['compilerOptions', 'baseUrl'])?.value;
	if (typeof own === 'string') {
		return vscode.Uri.joinPath(uri, '..', own);
	}
	return (await inheritedBaseUrl(uri, root, 0)) ?? vscode.Uri.joinPath(uri, '..');
}

async function inheritedBaseUrl(uri: vscode.Uri, root: JsonNode, depth: number): Promise<vscode.Uri | undefined> {
	if (depth > 10) {
		return undefined;
	}
	const extendsNode = findNodeAtLocation(root, ['extends']);
	const value: unknown = extendsNode ? getNodeValue(extendsNode) : undefined;
	const specs = typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];

	// With several configs in "extends", later ones override earlier ones, so check them last-first.
	for (const spec of [...specs].reverse()) {
		const parent = await resolveExtends(uri, spec);
		if (!parent) {
			continue;
		}
		const parentRoot = parseTree(await readText(parent), [], { allowTrailingComma: true });
		if (!parentRoot) {
			continue;
		}
		const baseUrl = findNodeAtLocation(parentRoot, ['compilerOptions', 'baseUrl'])?.value;
		if (typeof baseUrl === 'string') {
			return vscode.Uri.joinPath(parent, '..', baseUrl);
		}
		const deeper = await inheritedBaseUrl(parent, parentRoot, depth + 1);
		if (deeper) {
			return deeper;
		}
	}
	return undefined;
}

// "./tsconfig.base.json", "../base" or a package like "@tsconfig/node20/tsconfig.json".
async function resolveExtends(from: vscode.Uri, spec: string): Promise<vscode.Uri | undefined> {
	if (spec.startsWith('.') || spec.startsWith('/')) {
		for (const candidate of [spec, `${spec}.json`]) {
			const uri = vscode.Uri.joinPath(from, '..', candidate);
			if (await exists(uri)) {
				return uri;
			}
		}
		return undefined;
	}
	for (const candidate of [spec, `${spec}.json`, `${spec}/tsconfig.json`]) {
		const uri = await findInNodeModules(from, candidate);
		if (uri && (await isFile(uri))) {
			return uri;
		}
	}
	return undefined;
}

async function targetExists(base: vscode.Uri, target: string): Promise<boolean> {
	const star = target.indexOf('*');
	if (star !== -1) {
		const prefix = target.slice(0, star);
		const dir = prefix.slice(0, prefix.lastIndexOf('/') + 1).replace(/\/+$/, '') || '.';
		return exists(vscode.Uri.joinPath(base, dir));
	}
	for (const ext of TARGET_EXTENSIONS) {
		if (await exists(vscode.Uri.joinPath(base, target + ext))) {
			return true;
		}
	}
	return false;
}

async function exists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

async function isFile(uri: vscode.Uri): Promise<boolean> {
	try {
		return (await vscode.workspace.fs.stat(uri)).type === vscode.FileType.File;
	} catch {
		return false;
	}
}

async function isDependencyUsed(name: string, usage: Usage, scripts: string, packageJson: vscode.Uri): Promise<boolean> {
	if (usage.packages.has(name)) {
		return true;
	}
	if (mentions(scripts, name) || usage.configs.some(({ text }) => mentions(text, name))) {
		return true;
	}
	// ESLint configs refer to plugins and shared configs by short name ("react" for eslint-plugin-react).
	const shortNames = eslintShortNames(name);
	if (
		shortNames.length > 0 &&
		usage.configs.some(({ uri, text }) => fileName(uri).includes('eslint') && shortNames.some((s) => mentions(text, s)))
	) {
		return true;
	}
	// CLI tools are run by their command name, which can differ from the package name (typescript -> tsc).
	const bins = await binNames(name, packageJson);
	return bins.some((bin) => mentions(scripts, bin));
}

async function binNames(name: string, packageJson: vscode.Uri): Promise<string[]> {
	const bin = (await readInstalledManifest(name, packageJson))?.bin;
	if (typeof bin === 'string') {
		return [name.split('/').pop() ?? name];
	}
	if (bin && typeof bin === 'object') {
		return Object.keys(bin);
	}
	return [];
}

async function collectFileUsages(): Promise<FileUsage[]> {
	const [sources, configs] = await Promise.all([
		vscode.workspace.findFiles(SOURCE_GLOB, EXCLUDE_GLOB),
		vscode.workspace.findFiles(CONFIG_GLOB, EXCLUDE_GLOB),
	]);

	const files: FileUsage[] = [];
	const seen = new Set<string>();
	for (const uri of [...sources, ...configs]) {
		if (seen.has(uri.toString())) {
			continue;
		}
		seen.add(uri.toString());

		const text = await readText(uri);
		const dynamicEnv = hasDynamicEnvAccess(text);
		files.push({
			uri,
			envKeys: envKeysRead(text),
			specifiers: importSpecifiers(text),
			configText: isConfigFile(uri) ? text : undefined,
			dynamicEnv,
			words: dynamicEnv ? new Set(text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) : undefined,
		});
	}
	return files;
}

// Prefers the open editor's text, so unsaved changes are taken into account.
async function readText(uri: vscode.Uri): Promise<string> {
	const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
	if (open) {
		return open.getText();
	}
	return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

// The range of a JSON string's contents, without its quotes.
function stringRange(doc: vscode.TextDocument, node: JsonNode): vscode.Range {
	return new vscode.Range(doc.positionAt(node.offset + 1), doc.positionAt(node.offset + node.length - 1));
}

function makeDiagnostic(
	range: vscode.Range,
	message: string,
	code: string,
	severity = vscode.DiagnosticSeverity.Warning
): vscode.Diagnostic {
	const diagnostic = new vscode.Diagnostic(range, message, severity);
	diagnostic.source = 'deadweight';
	diagnostic.code = code;
	return diagnostic;
}

export function deactivate() {}
