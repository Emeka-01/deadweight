import * as assert from 'assert';
import {
	deepestContaining,
	destructuredEnvKeys,
	envKeysRead,
	envValueRefs,
	eslintShortNames,
	hasDynamicEnvAccess,
	hasIgnoreComment,
	ignoreMatcher,
	importSpecifiers,
	isAliasUsed,
	mentions,
	packageName,
} from '../../matching';

suite('matching: env keys read by code', () => {
	test('reads every named form', () => {
		assert.deepStrictEqual(
			envKeysRead('process.env.A; process.env?.B; process.env["C"]; process.env?.["D"]; import.meta.env.E; const { F } = process.env'),
			['A', 'B', 'C', 'D', 'E', 'F']
		);
	});

	test('destructuring: plain, renamed, default; rest is skipped', () => {
		assert.deepStrictEqual(
			destructuredEnvKeys('const { API_KEY, DB_URL: url, PORT = "3000", ...rest } = process.env;'),
			['API_KEY', 'DB_URL', 'PORT']
		);
	});

	test('destructuring: multi-line with trailing comma, import.meta.env', () => {
		assert.deepStrictEqual(destructuredEnvKeys('const {\n  VITE_A,\n  VITE_B,\n} = import.meta.env'), ['VITE_A', 'VITE_B']);
	});

	test('destructuring: function parameter default', () => {
		assert.deepStrictEqual(destructuredEnvKeys('function f({ HOST } = process.env) {}'), ['HOST']);
	});

	test('destructuring: unrelated objects are ignored', () => {
		assert.deepStrictEqual(destructuredEnvKeys('const { a } = props;'), []);
	});
});

suite('matching: dynamic env access', () => {
	const dynamic = [
		'const v = process.env[name]',
		'cleanEnv(process.env, { API_KEY: str() })',
		'const all = { ...process.env }',
		'Object.keys(import.meta.env)',
	];
	for (const code of dynamic) {
		test(`dynamic: ${code}`, () => assert.strictEqual(hasDynamicEnvAccess(code), true));
	}

	const notDynamic = [
		'process.env.A; process.env["B"]; process.env?.C',
		'const { A, B } = process.env;',
		'const x = process.environment',
	];
	for (const code of notDynamic) {
		test(`not dynamic: ${code}`, () => assert.strictEqual(hasDynamicEnvAccess(code), false));
	}
});

suite('matching: .env value references', () => {
	test('${X} and $X', () => assert.deepStrictEqual(envValueRefs('URL=http://${HOST}:$PORT/path'), ['HOST', 'PORT']));
	test('${X:-default}', () => assert.deepStrictEqual(envValueRefs('A=${B:-fallback}'), ['B']));
	test('single-quoted values are literal', () => assert.deepStrictEqual(envValueRefs("A='${LITERAL}'"), []));
	test('escaped \\$ is ignored', () => assert.deepStrictEqual(envValueRefs('A="price is \\$5"'), []));
	test('plain value', () => assert.deepStrictEqual(envValueRefs('A=plain'), []));
});

suite('matching: ignore comments and setting', () => {
	test('# comment at the end of the line', () => assert.strictEqual(hasIgnoreComment('KEY=1 # deadweight-ignore', undefined), true));
	test('# comment on the line above', () => assert.strictEqual(hasIgnoreComment('KEY=1', '# deadweight-ignore'), true));
	test('// comment on the line above', () =>
		assert.strictEqual(hasIgnoreComment('"@/*": ["./src/*"],', '      // deadweight-ignore'), true));
	test('comment at the end of the line above does not apply', () =>
		assert.strictEqual(hasIgnoreComment('KEY=1', 'OTHER=2 # deadweight-ignore'), false));
	test('"deadweight-ignored" is not the marker', () =>
		assert.strictEqual(hasIgnoreComment('KEY=1 # deadweight-ignored', undefined), false));

	test('setting: wildcard, exact, and alias patterns', () => {
		const isIgnored = ignoreMatcher(['NEXT_PUBLIC_*', 'left-pad', '@/*']);
		assert.deepStrictEqual(
			['NEXT_PUBLIC_URL', 'left-pad', 'left-pad2', '@/*', 'OTHER'].map(isIgnored),
			[true, true, false, true, false]
		);
	});
});

suite('matching: imports and package names', () => {
	test('every import form', () => {
		const code = `import a from "react"; import "lodash/fp"; export * from "@scope/pkg/sub"; const x=require("express");
			await import("chalk"); import y from "./local"; import fs from "node:fs"; import type {T} from "zod"; require.resolve("r")`;
		assert.deepStrictEqual(importSpecifiers(code), [
			'react', 'lodash/fp', '@scope/pkg/sub', 'express', 'chalk', './local', 'node:fs', 'zod', 'r',
		]);
	});

	test('specifier -> package name', () => {
		assert.deepStrictEqual(
			['lodash/fp', '@scope/pkg/sub', './local', 'node:fs', '#internal', '@scope'].map(packageName),
			['lodash', '@scope/pkg', undefined, undefined, undefined, undefined]
		);
	});

	test('mentions: object key, subpath; not inside another name', () => {
		assert.strictEqual(mentions('plugins: { tailwindcss: {} }', 'tailwindcss'), true);
		assert.strictEqual(mentions('"extends": "@tsconfig/node20/tsconfig.json"', '@tsconfig/node20'), true);
		assert.strictEqual(mentions('tsc --noEmit', 'tsc'), true);
		assert.strictEqual(mentions('"prettier-plugin-tailwindcss"', 'tailwindcss'), false);
		assert.strictEqual(mentions('"@scope/react"', 'react'), false);
	});

	test('ESLint short names', () => {
		assert.deepStrictEqual(eslintShortNames('eslint-plugin-react'), ['react']);
		assert.deepStrictEqual(eslintShortNames('eslint-config-prettier'), ['prettier']);
		assert.deepStrictEqual(eslintShortNames('@typescript-eslint/eslint-plugin'), ['@typescript-eslint']);
		assert.deepStrictEqual(eslintShortNames('@acme/eslint-config-base'), ['@acme/base']);
		assert.deepStrictEqual(eslintShortNames('react'), []);
	});
});

suite('matching: tsconfig path aliases', () => {
	test('wildcard alias matches by prefix', () => assert.strictEqual(isAliasUsed('@/*', ['@/components/Button']), true));
	test('exact alias must match exactly', () => assert.strictEqual(isAliasUsed('@utils', ['@utils/x']), false));
	test('bare "*" always counts as used', () => assert.strictEqual(isAliasUsed('*', []), true));
});

suite('matching: monorepo scopes', () => {
	const roots = ['/c:/repo', '/c:/repo/packages/web', '/c:/repo/packages/api'];
	test('nested package wins', () =>
		assert.strictEqual(deepestContaining('/c:/repo/packages/web/src/a.ts', roots), '/c:/repo/packages/web'));
	test('falls back to the root package', () =>
		assert.strictEqual(deepestContaining('/c:/repo/scripts/x.ts', roots), '/c:/repo'));
	test('"web" does not contain "website"', () =>
		assert.strictEqual(deepestContaining('/c:/repo/packages/website/a.ts', roots), '/c:/repo'));
	test('case-insensitive (Windows paths)', () =>
		assert.strictEqual(deepestContaining('/C:/Repo/packages/api/.env', roots), '/c:/repo/packages/api'));
	test('outside every package', () => assert.strictEqual(deepestContaining('/d:/other/a.ts', roots), undefined));
});
