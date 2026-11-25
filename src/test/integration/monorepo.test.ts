// Runs against test-fixtures/monorepo (see .vscode-test.mjs). Its .vscode/settings.json turns on
// deadweight.checkDevDependencies.
import * as assert from 'assert';
import { findings, info, scan, warning } from './helpers';

suite('monorepo', () => {
	suiteSetup(scan);

	test('root .env sees code in every package; dynamic access softens the rest to info', async () => {
		// SHARED_KEY is read in packages/api. packages/api/src/config.ts reads process.env dynamically.
		assert.deepStrictEqual(await findings('.env'), [info('ROOT_ONLY_DEAD', 'unused-env-key')]);
	});

	test('root devDependencies are checked; ESLint short names count', async () => {
		// eslint-plugin-react is referenced as "react" in .eslintrc.json.
		assert.deepStrictEqual(await findings('package.json'), [warning('unused-tool', 'unused-dependency')]);
	});

	test('a package only sees its own code', async () => {
		// API_SECRET is read only by packages/api, so it's dead in web.
		assert.deepStrictEqual(await findings('packages/web/.env'), [warning('API_SECRET', 'unused-env-key')]);
		assert.deepStrictEqual(await findings('packages/web/package.json'), [warning('lodash', 'unused-dependency')]);
		assert.deepStrictEqual(await findings('packages/api/package.json'), []);
	});

	test('keys named in a validation schema count; other keys become info', async () => {
		// SCHEMA_KEY is listed in cleanEnv(process.env, {...}); DB_URL isn't named anywhere.
		assert.deepStrictEqual(await findings('packages/api/.env'), [info('DB_URL', 'unused-env-key')]);
	});

	test('tsconfig paths resolve against a baseUrl inherited through "extends"', async () => {
		assert.deepStrictEqual(await findings('packages/web/tsconfig.json'), []);
	});
});
