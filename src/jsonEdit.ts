import { findNodeAtLocation, parseTree } from 'jsonc-parser';
import type { JSONPath } from 'jsonc-parser';

// Deletes one object property or array item by cutting text only (no reformatting), keeping commas valid:
// - not the last entry: remove it and the comma after it (its whole line, if it sits on its own line);
// - the last entry: remove it and the comma before it, so a trailing comma after it is left as it was;
// - the only entry: empty the brackets, leaving [] or {}.
// (jsonc-parser's own modify() reformats the surrounding text and can produce invalid JSON when trailing commas are present.)
export function removeJsonNode(text: string, path: JSONPath): string {
	const root = parseTree(text, [], { allowTrailingComma: true });
	const valueNode = root && findNodeAtLocation(root, path);
	const node = valueNode && (typeof path[path.length - 1] === 'number' ? valueNode : valueNode.parent);
	const siblings = node?.parent?.children;
	if (!node?.parent || !siblings) {
		return text;
	}
	const container = node.parent;
	const index = siblings.indexOf(node);
	let start: number;
	let end: number;

	if (siblings.length === 1) {
		start = container.offset + 1;
		end = container.offset + container.length - 1;
	} else if (index < siblings.length - 1) {
		start = node.offset;
		end = node.offset + node.length;
		end += /^\s*,/.exec(text.slice(end))?.[0].length ?? 0;
		const lineStart = text.lastIndexOf('\n', start - 1) + 1;
		const restOfLine = /^[ \t]*\r?\n/.exec(text.slice(end));
		if (restOfLine && /^[ \t]*$/.test(text.slice(lineStart, start))) {
			start = lineStart;
			end += restOfLine[0].length;
		} else {
			end += /^[ \t]*/.exec(text.slice(end))?.[0].length ?? 0;
		}
	} else {
		const previous = siblings[index - 1];
		start = previous.offset + previous.length;
		end = node.offset + node.length;
	}

	return text.slice(0, start) + text.slice(end);
}
