import * as vscode from 'vscode';

const SOURCE_GLOB = '**/*.{js,jsx,ts,tsx,mjs,cjs,vue,svelte}';
const EXCLUDE_GLOB = '**/{node_modules,dist,out,build,.git}/**';

// Matches process.env.KEY, process.env["KEY"] and process.env['KEY']
const ENV_USAGE = /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\])/g;

// Matches a KEY=value line, optionally prefixed with "export"
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

let diagnostics: vscode.DiagnosticCollection;

export function activate(context: vscode.ExtensionContext) {
	diagnostics = vscode.languages.createDiagnosticCollection('deadweight');
	context.subscriptions.push(diagnostics);

	context.subscriptions.push(
		vscode.commands.registerCommand('deadweight.scan', async () => {
			const count = await scanWorkspace();
			vscode.window.showInformationMessage(
				count === 0 ? 'Deadweight: no unused .env keys found.' : `Deadweight: found ${count} unused .env key(s).`
			);
		})
	);

	// Rescan whenever a .env file or a source file is saved (debounced so "Save All" triggers a single scan instead of one per file).
	let timer: ReturnType<typeof setTimeout> | undefined;
	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument((doc) => {
			if (!isRelevant(doc.uri)) {
				return;
			}
			clearTimeout(timer);
			timer = setTimeout(() => void scanWorkspace(), 300);
		}),
		{ dispose: () => clearTimeout(timer) }
	);

	// Initial scan so warnings appear without running the command.
	void scanWorkspace();
}

function isRelevant(uri: vscode.Uri): boolean {
	const name = uri.path.split('/').pop() ?? '';
	return name === '.env' || /\.(js|jsx|ts|tsx|mjs|cjs|vue|svelte)$/.test(name);
}

async function scanWorkspace(): Promise<number> {
	diagnostics.clear();

	const envFiles = await vscode.workspace.findFiles('**/.env', EXCLUDE_GLOB);
	if (envFiles.length === 0) {
		return 0;
	}

	const usedKeys = await collectUsedKeys();
	let unused = 0;

	for (const envUri of envFiles) {
		const doc = await vscode.workspace.openTextDocument(envUri);
		const fileDiagnostics: vscode.Diagnostic[] = [];

		for (let i = 0; i < doc.lineCount; i++) {
			const line = doc.lineAt(i);
			const match = ENV_LINE.exec(line.text);
			if (!match || usedKeys.has(match[1])) {
				continue;
			}
			const start = line.text.indexOf(match[1]);
			const range = new vscode.Range(i, start, i, start + match[1].length);
			const diagnostic = new vscode.Diagnostic(
				range,
				`"${match[1]}" is never read via process.env in this workspace.`,
				vscode.DiagnosticSeverity.Warning
			);
			diagnostic.source = 'deadweight';
			fileDiagnostics.push(diagnostic);
		}

		diagnostics.set(envUri, fileDiagnostics);
		unused += fileDiagnostics.length;
	}

	return unused;
}

async function collectUsedKeys(): Promise<Set<string>> {
	const used = new Set<string>();
	const files = await vscode.workspace.findFiles(SOURCE_GLOB, EXCLUDE_GLOB);

	for (const uri of files) {
		const bytes = await vscode.workspace.fs.readFile(uri);
		const text = new TextDecoder().decode(bytes);
		for (const match of text.matchAll(ENV_USAGE)) {
			used.add(match[1] ?? match[2]);
		}
	}

	return used;
}

export function deactivate() {}
