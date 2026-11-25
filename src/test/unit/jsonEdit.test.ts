import * as assert from 'assert';
import { parse, type JSONPath, type ParseError } from 'jsonc-parser';
import { removeJsonNode } from '../../jsonEdit';

const tsconfig = `{
  // Comments and trailing commas are allowed in tsconfig files
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@lib/*": ["./lib/*"],
      "@old/*": ["./old/*"],
      "@unused/*": ["./lib/*"],
      "@mixed/*": ["./lib/*", "./gone/*"],
    },
  },
}
`;

const pkg = `{
  "dependencies": {
    "a": "1",
    "b": "2",
    "c": "3"
  }
}
`;

function removeAll(text: string, paths: JSONPath[]): string {
	let out = text;
	for (const path of paths) {
		out = removeJsonNode(out, path);
	}
	const errors: ParseError[] = [];
	parse(out, errors, { allowTrailingComma: true });
	assert.deepStrictEqual(errors, [], `result is not valid JSON:\n${out}`);
	return out;
}

const paths = (...keys: (string | number)[]): JSONPath => ['compilerOptions', 'paths', ...keys];

suite('jsonEdit: removeJsonNode', () => {
	test('last array item before a trailing comma (regression: produced `"./lib/*""]`)', () => {
		const out = removeAll(tsconfig, [paths('@mixed/*', 1)]);
		assert.ok(out.includes('"@mixed/*": ["./lib/*"],'), out);
	});

	test('first array item keeps the array on one line', () => {
		const out = removeAll(tsconfig, [paths('@mixed/*', 0)]);
		assert.ok(out.includes('"@mixed/*": ["./gone/*"],'), out);
	});

	test('last property keeps the trailing comma style and the comment', () => {
		const out = removeAll(tsconfig, [paths('@mixed/*')]);
		assert.ok(!out.includes('@mixed'), out);
		assert.ok(out.includes('"@unused/*": ["./lib/*"],\n    },'), out);
		assert.ok(out.includes('// Comments and trailing commas'), out);
	});

	test('several removals, last-first (as the Quick Fix does)', () => {
		const out = removeAll(tsconfig, [paths('@mixed/*', 1), paths('@unused/*'), paths('@old/*')]);
		assert.ok(out.includes('"@lib/*": ["./lib/*"],\n      "@mixed/*": ["./lib/*"],'), out);
	});

	test('removing every entry leaves an empty object', () => {
		const out = removeAll(tsconfig, ['@mixed/*', '@unused/*', '@old/*', '@lib/*'].map((k) => paths(k)));
		assert.ok(out.includes('"paths": {},'), out);
	});

	test('first, middle and last dependency', () => {
		assert.strictEqual(removeAll(pkg, [['dependencies', 'a']]), pkg.replace('    "a": "1",\n', ''));
		assert.strictEqual(removeAll(pkg, [['dependencies', 'b']]), pkg.replace('    "b": "2",\n', ''));
		assert.strictEqual(removeAll(pkg, [['dependencies', 'c']]), pkg.replace(',\n    "c": "3"', ''));
	});

	test('all dependencies -> empty object', () => {
		const out = removeAll(pkg, [['dependencies', 'c'], ['dependencies', 'b'], ['dependencies', 'a']]);
		assert.strictEqual(out, '{\n  "dependencies": {}\n}\n');
	});

	test('Windows (CRLF) line endings', () => {
		const crlf = pkg.replace(/\n/g, '\r\n');
		assert.strictEqual(removeAll(crlf, [['dependencies', 'a']]), crlf.replace('    "a": "1",\r\n', ''));
	});

	test('a path that does not exist leaves the text unchanged', () => {
		assert.strictEqual(removeJsonNode(pkg, ['dependencies', 'nope']), pkg);
	});
});
