# Deadweight

Find and remove the config nobody uses anymore: **unused dependencies**, **stale `.env` keys**, and **dead tsconfig paths**.

Deadweight checks your project in the background and underlines what's unused, right in the file where it's declared. Press `Ctrl+.` (`Cmd+.` on macOS) to remove the entry or to ignore it.

## What it finds

| Where | What gets flagged |
|---|---|
| `.env`, `.env.local`, `.env.production`, … | Keys your code never reads |
| `package.json` | Dependencies nothing imports, runs, or needs |
| `tsconfig.json` / `jsconfig.json` | Path aliases no import uses, aliases whose folders are gone, and individual missing targets |

Findings show up as warnings in the editor and in the **Problems** panel (`Ctrl+Shift+M`).

## Quick Fixes

On any finding, press `Ctrl+.` or click the lightbulb:

- **Remove** the key, dependency or path entry. Commas are fixed so your JSON stays valid, and the rest of the file keeps its formatting.
- **Remove all** flagged entries in the file at once.
- **Ignore with a comment** (`.env` and tsconfig files): adds a `deadweight-ignore` comment above the line.
- **Always ignore in this workspace**: adds the name to the `deadweight.ignore` setting.

Removals are ordinary edits: nothing is saved until you save, and `Ctrl+Z` undoes them. After removing dependencies, run `npm install` (or your package manager's equivalent) to update your lockfile.

## How Deadweight decides something is used

Deadweight reads your source files (`.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`, `.mts`, `.cts`, `.vue`, `.svelte`, `.astro`) and tool config files. It skips `node_modules`, `dist`, `out`, `build`, `coverage`, `.git`, `.next` and `.svelte-kit`.

**An `.env` key is used if:**
- code reads it: `process.env.KEY`, `process.env["KEY"]`, `process.env?.KEY` or `import.meta.env.KEY`;
- code destructures it: `const { KEY } = process.env`;
- another used key references it: `URL=http://${HOST}:3000` keeps `HOST` as long as `URL` is used.

Template files (`.env.example`, `.env.sample`, `.env.template`, `.env.dist`) are never checked.

**A dependency is used if:**
- code imports or requires it, including subpaths like `lodash/fp`;
- a `package.json` script runs it, by package name or by the command it installs (`tsc` counts as using `typescript`);
- a config file names it, for example `plugins: { tailwindcss: {} }` in `postcss.config.js`, or an ESLint plugin's short name (`"react"` for `eslint-plugin-react`);
- a package you use lists it in `peerDependencies`. For example, `next` needs `react-dom` even if you never import `react-dom` yourself.

`dependencies` and `optionalDependencies` are always checked. `devDependencies` are checked only if you turn on `deadweight.checkDevDependencies`. `@types/*` packages are never flagged.

**A tsconfig path alias is used if** an import matches it: `@/*` matches `@/components/Button`. Targets are resolved the way TypeScript does, from `baseUrl` if it's set (including a `baseUrl` inherited through `"extends"`), otherwise from the tsconfig's own folder.

## Monorepos

Each file is checked against the code in its own package: the nearest folder above it with a `package.json`. Packages nested inside that folder count too.

- `packages/api/.env` and `packages/api/package.json` only count code under `packages/api`.
- Files at the repository root count code from the whole repo, since shared root config is normal.

## When Deadweight can't be sure

Some code reads environment variables in ways that hide which keys it uses:

```js
const value = process.env[name];                          // computed key
export const env = cleanEnv(process.env, { API_KEY: str() }); // the whole object
```

When a package contains code like this, Deadweight:
- counts any key **named anywhere in those files** as used, which covers validation schemas such as envalid and zod;
- reports the remaining unused keys as **information** (blue) instead of warnings, and names the file that reads env vars dynamically.

## Ignoring findings

**One line:** add a comment at the end of the line or on the line above it.

```sh
# .env
LEGACY_TOKEN=abc # deadweight-ignore

# deadweight-ignore
KEPT_FOR_LATER=1
```

```jsonc
// tsconfig.json
"paths": {
  // deadweight-ignore
  "@legacy/*": ["./legacy/*"]
}
```

**By name, everywhere:** list names in the `deadweight.ignore` setting. `*` matches any characters.

```json
"deadweight.ignore": ["NEXT_PUBLIC_*", "left-pad", "@legacy/*"]
```

`package.json` doesn't allow comments, so use the setting for dependencies.

## Settings

| Setting | Default | Description |
|---|---|---|
| `deadweight.ignore` | `[]` | Names never to flag: `.env` keys, dependency names, or tsconfig aliases and targets. Supports `*`. |
| `deadweight.checkDevDependencies` | `false` | Also check `devDependencies`. Dev tools are often used in ways Deadweight can't see (by your editor, or another tool's config), so expect to ignore a few. |

## Commands

- **Deadweight: Scan Config Files**: scans now and shows a summary. You rarely need it, because Deadweight scans automatically when a project opens, when you save a source, config, `.env`, `package.json` or tsconfig file, and while you edit those last three.

## Known limitations

- **Dependencies** are only recognized as peers or command-line tools once they're installed. Before `npm install`, there's no `node_modules` to read.
- **A package your framework loads by convention**, without naming it anywhere, can be flagged. Use `deadweight.ignore` for these.
- **All `.env` files in a package share one set of usage.** Deadweight doesn't know which file each environment (development, production) loads.
- **Detecting dynamic env access** can be set off by `process.env` appearing in a comment or string. This only softens warnings to information, so it never hides anything.
- **Paths in an extended tsconfig** are checked in the file that defines them, not in the files that extend it.
