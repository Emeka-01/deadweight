import { defineConfig } from '@vscode/test-cli';

// `npm test` runs every configuration below in a fresh VS Code instance.
// `npm run test:unit` runs just the unit tests with plain mocha, without opening VS Code.
const integration = { mocha: { ui: 'tdd', timeout: 30000 }, launchArgs: ['--disable-extensions'] };

export default defineConfig([
	{
		label: 'unit',
		files: 'out/test/unit/**/*.test.js',
	},
	{
		label: 'single-package',
		files: 'out/test/integration/single.test.js',
		workspaceFolder: './test-fixtures/single',
		...integration,
	},
	{
		label: 'monorepo',
		files: 'out/test/integration/monorepo.test.js',
		workspaceFolder: './test-fixtures/monorepo',
		...integration,
	},
]);
