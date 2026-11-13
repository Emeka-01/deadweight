import * as vscode from 'vscode';
import { applyEdits, findNodeAtLocation, findNodeAtOffset, getNodePath, modify, parseTree } from 'jsonc-parser';
import type { Node as JsonNode } from 'jsonc-parser';

const SOURCE_EXTS = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte', 'astro'];
const SOURCE_GLOB = `**/*.{${SOURCE_EXTS.join(',')}}`;
const SOURCE_RE = new RegExp(`\\.(${SOURCE_EXTS.join('|')})$`);
// Tool config files (vite.config.ts, .babelrc, tsconfig.json, ...) often name packages without importing them.
const CONFIG_GLOB = '**/{*.config.*,.*rc,.*rc.*,tsconfig*.json,jsconfig*.json}';
const CONFIG_RE = /(\.config\.[^./]+|\/\.[^/]*rc(\.[^./]+)?|\/[tj]sconfig[^/]*\.json)$/;
const TSCONFIG_GLOB = '**/{tsconfig,jsconfig}*.json';
const TSCONFIG_RE = /\/[tj]sconfig[^/]*\.json$/;
const EXCLUDE_GLOB = '**/{node_modules,dist,out,build,coverage,.git,.next,.svelte-kit}/**';

// Matches process.env.KEY / import.meta.env.KEY, plus the ["KEY"] and ['KEY'] forms
const ENV_USAGE = /(?:process\.env|import\.meta\.env)(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\])/g;

// Matches a KEY=value line, optionally prefixed with "export"
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

// Matches `from 'x'`, `import 'x'`, `import('x')`, `require('x')` and `require.resolve('x')`
const IMPORT_USAGE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire(?:\.resolve)?\s*\(\s*)["']([^"'\s]+)["']/g;

// Only runtime dependencies are checked: devDependencies are mostly CLI tools
// and type packages, which would produce a lot of false warnings.
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
		{ dispose: () => clearTimeout(timer) }
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
			action.isPreferred = true;
			actions.push(action);
		}

		if (all.length > 1) {
			const what = isEnv ? 'unused keys' : isPackageJson(document.uri) ? 'unused dependencies' : 'dead path entries';
			const action = new vscode.CodeAction(`Remove all ${all.length} ${what} in this file`, vscode.CodeActionKind.QuickFix);
			action.edit = removeEdit(document, all);
			action.diagnostics = [...all];
			actions.push(action);
		}

		return actions;
	}
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
			text = applyEdits(text, modify(text, path, undefined, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
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

interface Usage {
	envKeys: Set<string>;
	packages: Set<string>;
	specifiers: Set<string>;
	configTexts: string[];
}

async function scanWorkspace(): Promise<{ envKeys: number; dependencies: number; paths: number }> {
	const [envFiles, packageFiles, tsconfigFiles, usage] = await Promise.all([
		vscode.workspace.findFiles('**/.env*', EXCLUDE_GLOB).then((uris) => uris.filter(isEnvFile)),
		vscode.workspace.findFiles('**/package.json', EXCLUDE_GLOB),
		vscode.workspace.findFiles(TSCONFIG_GLOB, EXCLUDE_GLOB),
		collectUsage(),
	]);

	diagnostics.clear();
	const counts = { envKeys: 0, dependencies: 0, paths: 0 };

	for (const uri of envFiles) {
		const found = await scanEnvFile(uri, usage);
		diagnostics.set(uri, found);
		counts.envKeys += found.length;
	}
	for (const uri of packageFiles) {
		const found = await scanPackageJson(uri, usage);
		diagnostics.set(uri, found);
		counts.dependencies += found.length;
	}
	for (const uri of tsconfigFiles) {
		const found = await scanTsconfig(uri, usage);
		diagnostics.set(uri, found);
		counts.paths += found.length;
	}

	return counts;
}

async function scanEnvFile(uri: vscode.Uri, usage: Usage): Promise<vscode.Diagnostic[]> {
	const doc = await vscode.workspace.openTextDocument(uri);
	const found: vscode.Diagnostic[] = [];

	for (let i = 0; i < doc.lineCount; i++) {
		const line = doc.lineAt(i);
		const match = ENV_LINE.exec(line.text);
		if (!match || usage.envKeys.has(match[1])) {
			continue;
		}
		const start = line.text.indexOf(match[1]);
		const range = new vscode.Range(i, start, i, start + match[1].length);
		found.push(
			makeDiagnostic(
				range,
				`"${match[1]}" is never read via process.env or import.meta.env in this workspace.`,
				UNUSED_ENV_KEY
			)
		);
	}
	return found;
}

async function scanPackageJson(uri: vscode.Uri, usage: Usage): Promise<vscode.Diagnostic[]> {
	const doc = await vscode.workspace.openTextDocument(uri);
	const root = parseTree(doc.getText());
	if (!root) {
		return [];
	}

	const scriptsNode = findNodeAtLocation(root, ['scripts']);
	const scripts = (scriptsNode?.children ?? []).map((prop) => String(prop.children?.[1]?.value ?? '')).join('\n');
	const found: vscode.Diagnostic[] = [];

	for (const section of DEP_SECTIONS) {
		for (const prop of findNodeAtLocation(root, [section])?.children ?? []) {
			const keyNode = prop.children?.[0];
			const name = keyNode?.value;
			if (!keyNode || typeof name !== 'string' || name.startsWith('@types/')) {
				continue;
			}
			if (await isDependencyUsed(name, usage, scripts, uri)) {
				continue;
			}
			found.push(
				makeDiagnostic(
					stringRange(doc, keyNode),
					`"${name}" is in ${section} but is never imported, required, or used in a script or config file.`,
					UNUSED_DEPENDENCY
				)
			);
		}
	}
	return found;
}

async function scanTsconfig(uri: vscode.Uri, usage: Usage): Promise<vscode.Diagnostic[]> {
	const doc = await vscode.workspace.openTextDocument(uri);
	const root = parseTree(doc.getText(), [], { allowTrailingComma: true });
	const pathsNode = root && findNodeAtLocation(root, ['compilerOptions', 'paths']);
	if (!root || !pathsNode || pathsNode.type !== 'object') {
		return [];
	}

	// Targets resolve against baseUrl if set, otherwise against the tsconfig's own folder.
	const baseUrl = findNodeAtLocation(root, ['compilerOptions', 'baseUrl'])?.value;
	const base = vscode.Uri.joinPath(uri, '..', typeof baseUrl === 'string' ? baseUrl : '.');
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

// "@/*" matches any import starting with "@/"; an alias without "*" must match exactly.
function isAliasUsed(alias: string, specifiers: Set<string>): boolean {
	const star = alias.indexOf('*');
	if (star === -1) {
		return specifiers.has(alias);
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

async function isDependencyUsed(name: string, usage: Usage, scripts: string, packageJson: vscode.Uri): Promise<boolean> {
	if (usage.packages.has(name)) {
		return true;
	}
	if (mentions(scripts, name) || usage.configTexts.some((text) => mentions(text, name))) {
		return true;
	}
	// CLI tools are run by their command name, which can differ from the package name (typescript -> tsc).
	const bins = await binNames(name, packageJson);
	return bins.some((bin) => mentions(scripts, bin));
}

// True if `name` appears as a whole word: "tailwindcss" matches `tailwindcss: {}` but not "prettier-plugin-tailwindcss".
function mentions(text: string, name: string): boolean {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`(^|[^\\w@/.-])${escaped}($|[^\\w/.-])`).test(text);
}

async function binNames(name: string, packageJson: vscode.Uri): Promise<string[]> {
	const manifest = vscode.Uri.joinPath(packageJson, '..', 'node_modules', name, 'package.json');
	try {
		const bin = JSON.parse(await readText(manifest)).bin;
		if (typeof bin === 'string') {
			return [name.split('/').pop() ?? name];
		}
		if (bin && typeof bin === 'object') {
			return Object.keys(bin);
		}
	} catch {
		// Not installed, or no readable manifest: no bin names to check.
	}
	return [];
}

async function collectUsage(): Promise<Usage> {
	const usage: Usage = { envKeys: new Set(), packages: new Set(), specifiers: new Set(), configTexts: [] };
	const [sources, configs] = await Promise.all([
		vscode.workspace.findFiles(SOURCE_GLOB, EXCLUDE_GLOB),
		vscode.workspace.findFiles(CONFIG_GLOB, EXCLUDE_GLOB),
	]);

	const seen = new Set<string>();
	for (const uri of [...sources, ...configs]) {
		if (seen.has(uri.toString())) {
			continue;
		}
		seen.add(uri.toString());

		const text = await readText(uri);
		for (const match of text.matchAll(ENV_USAGE)) {
			usage.envKeys.add(match[1] ?? match[2]);
		}
		for (const match of text.matchAll(IMPORT_USAGE)) {
			usage.specifiers.add(match[1]);
			const pkg = packageName(match[1]);
			if (pkg) {
				usage.packages.add(pkg);
			}
		}
		if (isConfigFile(uri)) {
			usage.configTexts.push(text);
		}
	}
	return usage;
}

// "lodash/fp" -> "lodash", "@scope/pkg/sub" -> "@scope/pkg"; relative paths and node:/virtual: imports -> undefined.
function packageName(specifier: string): string | undefined {
	if (/^[./#]/.test(specifier) || specifier.includes(':')) {
		return undefined;
	}
	const parts = specifier.split('/');
	if (specifier.startsWith('@')) {
		return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined;
	}
	return parts[0];
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

function makeDiagnostic(range: vscode.Range, message: string, code: string): vscode.Diagnostic {
	const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Warning);
	diagnostic.source = 'deadweight';
	diagnostic.code = code;
	return diagnostic;
}

export function deactivate() {}
