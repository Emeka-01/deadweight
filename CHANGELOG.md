# Change Log

All notable changes to Deadweight are documented in this file, following [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- Flags `.env` keys that code never reads, in `.env` and `.env.*` files (templates such as `.env.example` are skipped).
- Recognizes `process.env.KEY`, `process.env["KEY"]`, `process.env?.KEY`, `import.meta.env.KEY`, destructuring, and `${KEY}` references between `.env` keys.
- Softens `.env` findings to information when code reads env vars dynamically, and counts keys named in validation schemas.
- Flags unused `dependencies` and `optionalDependencies`, recognizing imports, scripts, command names, config files, ESLint short names and peer dependencies. `devDependencies` are optional, behind `deadweight.checkDevDependencies`.
- Flags unused tsconfig/jsconfig path aliases, aliases whose targets are all missing, and individual missing targets, including a `baseUrl` inherited through `"extends"`.
- Monorepo support: each file is checked against the code in its own package.
- Quick Fixes to remove one entry or all of them, or to ignore a finding with a comment or the `deadweight.ignore` setting.
- Scans automatically on startup and on save, and live while editing `.env`, `package.json` and tsconfig files.
