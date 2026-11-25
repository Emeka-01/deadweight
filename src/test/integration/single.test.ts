// Runs against test-fixtures/single (see .vscode-test.mjs).
import * as assert from 'assert';
import * as vscode from 'vscode';
import { parse, type ParseError } from 'jsonc-parser';
import { findings, fixtureUri, scan, warning } from './helpers';

suite('single package', () => {
	suiteSetup(scan);

	test('.env: unused keys, including a key only referenced by an unused key', async () => {
		// Not flagged: USED_KEY (process.env.X), API_KEY (destructured), HOST and PORT (referenced by the used
		// BASE_URL), KEPT_FOR_LATER and LEGACY_TOKEN (ignore comments).
		assert.deepStrictEqual(await findings('.env'), [
			warning('DEAD_KEY', 'unused-env-key'),
			warning('ORPHAN_HOST', 'unused-env-key'),
			warning('UNUSED_URL', 'unused-env-key'),
		]);
	});

	test('.env.local is checked; VITE_API_URL is read via import.meta.env', async () => {
		assert.deepStrictEqual(await findings('.env.local'), [warning('LOCAL_ONLY', 'unused-env-key')]);
	});

	test('.env.example is a template and never checked', async () => {
		assert.deepStrictEqual(await findings('.env.example'), []);
	});

	test('package.json: imported, script-run and peer dependencies are kept', async () => {
		// Not flagged: chalk (imported), nodemon (dev script), fake-framework (imported), fake-renderer (its peer),
		// tsconfig-paths (only run by the Dockerfile: `node -r tsconfig-paths/register`).
		assert.deepStrictEqual(await findings('package.json'), [
			warning('is-odd', 'unused-dependency'),
			warning('left-pad', 'unused-dependency'),
		]);
	});

	test('tsconfig.json: unused alias, dead alias, and one missing target', async () => {
		assert.deepStrictEqual(await findings('tsconfig.json'), [
			warning('./gone/*', 'missing-path-target'),
			warning('@old/*', 'dead-path-alias'),
			warning('@unused/*', 'unused-path-alias'),
		]);
	});

	test('Quick Fix: removing all dead tsconfig entries keeps the JSON valid', async () => {
		const uri = fixtureUri('tsconfig.json');
		const doc = await vscode.workspace.openTextDocument(uri);
		const target = vscode.languages.getDiagnostics(uri).find((d) => d.code === 'missing-path-target');
		assert.ok(target, 'expected a missing-path-target finding');

		const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
			'vscode.executeCodeActionProvider',
			uri,
			target.range,
			vscode.CodeActionKind.QuickFix.value
		);
		const removeAll = actions.find((a) => a.title === 'Remove all 3 dead path entries in this file');
		assert.ok(removeAll?.edit, `actions were: ${actions.map((a) => a.title).join(' | ')}`);

		try {
			assert.ok(await vscode.workspace.applyEdit(removeAll.edit));
			const errors: ParseError[] = [];
			const result = parse(doc.getText(), errors, { allowTrailingComma: true });
			assert.deepStrictEqual(errors, [], doc.getText());
			assert.deepStrictEqual(result.compilerOptions.paths, { '@lib/*': ['./lib/*'], '@mixed/*': ['./lib/*'] });
		} finally {
			// The edit is unsaved; revert it so the fixture file on disk is never changed.
			await vscode.window.showTextDocument(doc);
			await vscode.commands.executeCommand('workbench.action.files.revert');
		}
	});
});
