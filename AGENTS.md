# Repository guidance

## Product and ownership

- This is a Mac-local collaborative workbench: one Node service owns the session; browser operator and display views share it. Voice, pointer and keyboard must use the same command path.
- Read `docs/product-design.md` and `docs/architecture.md` before changing product or system boundaries. Record architectural changes in `docs/adr/`.
- Preserve designer-owned `source/` and root `dist/` unless the task explicitly changes the interaction prototype. Exclude both from project-wide formatting. `docs/reference/` is historical, not the current specification.
- Report real execution events. Saved drafts, timers and demos must never appear as completed Agent work. Codex and Lingxi adapters are not connected yet; do not silently replace them with simulated success.

## Repository map

- `apps/web/`: React operator `/` and passive `/display`; no direct shell, Codex or AirPlay access.
- `apps/server/`: Fastify, SQLite, SSE and future local-process/provider adapters. Keep loopback binding and Host/Origin validation.
- `packages/protocol/`: shared Zod schemas, types and adapter contracts. Validate HTTP input and external-provider events at boundaries.
- `scripts/`: production smoke checks and architecture-specific runtime packaging.
- `docs/development.md`, `docs/deployment.md`, `docs/testing.md`: authoritative run, delivery and verification instructions; update them when commands or behavior change.

## Development

- Use Node 24.x and npm 11.x (`.nvmrc`, `packageManager`). Install with `npm ci`; commit dependency changes together with `package-lock.json`.
- Start with `npm run dev`; the operator is at `http://127.0.0.1:5173/` and display at `/display`. Production uses `npm run build` then `npm start` on port 4310.
- Preserve command IDs across retries, reject stale artifact selections, and keep display connection status separate from durable task state. Do not drop user input on request failure.
- Changes to persisted data require an explicit schema/migration and compatibility decision. An application downgrade does not imply a database downgrade.
- Keep implementations small. Test observable behavior and state boundaries; avoid tests that simply repeat the implementation.

## Required verification

- Run `npm run check` for implementation changes: Biome, TypeScript, unit/API coverage, production build, and real-process startup/restart smoke checks.
- Also run `npm run test:e2e` when browser behavior, SSE, command APIs or synchronization changes. Install Chromium with `npx playwright install chromium` first. CI installs browser dependencies.
- Run `npm run release:pack` for packaging/launcher changes. It installs production dependencies into a clean staging directory, then extracts and boots the actual archive. It packages the host architecture; do not relabel Linux output as a Mac build.
- Validate workflow edits with actionlint 1.7.12: `go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12`. Run `npm run audit:production` for dependency/release changes; resolve reported high/critical production issues without blindly applying `npm audit fix --force`.
- Coverage gates live in `vitest.config.ts`: 85% statements/lines/functions, 75% branches. The process entry point is verified by production smoke checks. Do not lower thresholds or exclude business logic just to pass CI.
- Keep real-device evidence distinct: CI does not verify Mac microphone access, provider login, meeting-room audio or AirPlay. State precisely which checks ran and which remain unverified.

## Delivery and data

- CI uploads verified Apple Silicon and Intel Mac runtime archives and checksums. Delivery currently means downloadable artifacts; no automatic install, cloud deployment, signing or notarization exists.
- Respect the user's requested Git workflow. Keep changes on the working branch; do not merge or publish a release as a side effect of fixing checks.
- Never commit credentials, local databases, recordings, package output, dependency directories or test reports. Root `dist/` is the intentional designer-prototype exception.
- Runtime data belongs outside versioned install folders. Stop the service before a file-copy backup; account for SQLite WAL files. Do not delete or migrate user data as routine cleanup.
