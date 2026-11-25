import * as vscode from 'vscode';

export interface Finding {
	name: string;
	code: string;
	severity: 'warning' | 'info';
}

export function fixtureUri(relativePath: string): vscode.Uri {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		throw new Error('Integration tests must run with a fixture folder open (see .vscode-test.mjs).');
	}
	return vscode.Uri.joinPath(folder.uri, relativePath);
}

// Runs the scan command (which activates the extension if needed) and waits for it to finish.
export async function scan(): Promise<void> {
	await vscode.commands.executeCommand('deadweight.scan');
}

// Deadweight's findings for one file, sorted by name, e.g. { name: 'DEAD_KEY', code: 'unused-env-key', severity: 'warning' }.
export async function findings(relativePath: string): Promise<Finding[]> {
	const uri = fixtureUri(relativePath);
	const doc = await vscode.workspace.openTextDocument(uri);
	return vscode.languages
		.getDiagnostics(uri)
		.filter((d) => d.source === 'deadweight')
		.map((d) => ({
			name: doc.getText(d.range),
			code: String(d.code),
			severity: d.severity === vscode.DiagnosticSeverity.Warning ? ('warning' as const) : ('info' as const),
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}

export const warning = (name: string, code: string): Finding => ({ name, code, severity: 'warning' });
export const info = (name: string, code: string): Finding => ({ name, code, severity: 'info' });
