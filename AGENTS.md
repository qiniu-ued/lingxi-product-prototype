# Repository guidance

## Product and ownership

- This is a Mac-local collaborative workbench: an Electron parent owns one Node 24 service and the canonical product WebContentsView; operator and display share task state. The standalone browser service retains draft-only behavior. Voice, pointer and keyboard must use the same command path.
- Read `docs/product-design.md` and `docs/architecture.md` before changing product or system boundaries. Record architectural changes in `docs/adr/`.
- Preserve designer-owned `source/` and root `dist/` unless the task explicitly changes the interaction prototype. Exclude both from project-wide formatting. `docs/reference/` is historical, not the current specification.
- Report real execution events. Saved drafts, timers and demos must never appear as completed Agent work. Desktop Codex tasks and scoped preview MCP are implemented; Lingxi audio and wake detection are not connected. Protocol fixtures are not proof of real model, audio or AirPlay success.

## Repository map

- `apps/desktop/`: Electron lifecycle, trusted preload and canonical preview. Bundle Node/npm; keep SQLite in the separate Node process. Generated pages must have no preload/Node/IPC or local-service network access. Only fixed, schema-validated native actions and versioned preview operations are allowed.
- `apps/web/`: React operator `/` and passive `/display`; no direct shell, Codex or AirPlay access.
- `apps/server/`: Fastify, SQLite, SSE and Codex App Server tasks; Lingxi provider integration remains pending. Keep loopback binding and Host/Origin validation.
- `packages/protocol/`: shared Zod schemas, types and adapter contracts. Validate HTTP input and external-provider events at boundaries.
- `scripts/`: production smoke checks and architecture-specific runtime packaging.
- `/setup` first inspects both Codex and Lingxi, then offers steps based on results. Keep diagnostics read-only: no installation, login, thread creation, turns or credential-file reads. Separate explicit-click actions may install the stable latest Codex into managed storage or start official browser login. Keep fixed operations, strict local Origin validation, retry IDs, cancellation and child cleanup; never accept arbitrary executable input from HTTP. Diagnostic readiness must not start tasks or enable voice. Task capability comes from the private desktop bridge, not a successful diagnostic. Lingxi is currently uncheckable, not implicitly missing.
- `docs/development.md`, `docs/deployment.md`, `docs/testing.md`: authoritative run, delivery and verification instructions; update them when commands or behavior change.

## Development

- Use Node 24.x and npm 11.x (`.nvmrc`, `packageManager`). Install with `npm ci`; commit dependency changes together with `package-lock.json`.
- Desktop development: `npm run desktop:dev`; quit and restart to load compiled changes. Build Mac distributions on each target architecture with `npm run desktop:pack`.
- Browser foundation: `npm run dev`; the operator is at `http://127.0.0.1:5173/` and display at `/display`. Production uses `npm run build` then `npm start` on port 4310.
- Preserve command IDs across retries, reject stale artifact selections, and keep display connection status separate from durable task state. Do not drop user input on request failure.
- Task request IDs are durable in `workbench_requests`; never replay interrupted tasks automatically. Preserve project-specific browser storage, reject stale binding/ref selections, and do not refresh an unchanged artifact after a browser-only action. Desktop v1 publishes only public `preview/` static assets; no arbitrary dev-server launch or shell endpoint.
- Changes to persisted data require an explicit schema/migration and compatibility decision. An application downgrade does not imply a database downgrade.
- Keep implementations small. Test observable behavior and state boundaries; avoid tests that simply repeat the implementation.

## Required verification

- Run `npm run check` for implementation changes: Biome, TypeScript, unit/API coverage, production build, and real-process startup/restart smoke checks.
- Also run `npm run test:e2e` when browser behavior, SSE, command APIs or synchronization changes. Install Chromium with `npx playwright install chromium` first. CI installs browser dependencies.
- Run `npm run test:desktop` for desktop, task or preview changes: it uses a real Electron page, private Node child and a deterministic App Server peer, without provider credentials. Keep native lifecycle/preview checks in this integration harness; protocol/server logic remains subject to unit coverage gates.
- Run `npm run release:pack` for packaging/launcher changes; on Mac also run `npm run desktop:pack` to verify the extracted `.app` with its bundled Node. It installs production dependencies into a clean staging directory, then extracts and boots the actual archive. It packages the host architecture; do not relabel Linux output as a Mac build.
- Validate workflow edits with actionlint 1.7.12: `go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12`. Run `npm run audit:production` for dependency/release changes; resolve reported high/critical production issues without blindly applying `npm audit fix --force`.
- Coverage gates live in `vitest.config.ts`: 85% statements/lines/functions, 75% branches. The process entry point is verified by production smoke checks. Do not lower thresholds or exclude business logic just to pass CI.
- Keep real-device evidence distinct: CI does not verify Mac microphone access, provider login, meeting-room audio or AirPlay. State precisely which checks ran and which remain unverified.

## Delivery and data

- CI uploads Apple Silicon and Intel runtime archives plus desktop app ZIPs and checksums after their checks. Delivery currently means downloadable artifacts; no automatic install, cloud deployment, Developer ID signing, notarization or auto-update exists.
- Respect the user's requested Git workflow. Keep changes on the working branch; do not merge or publish a release as a side effect of fixing checks.
- Never commit credentials, local databases, recordings, package output, dependency directories or test reports. Root `dist/` is the intentional designer-prototype exception.
- Runtime data belongs outside versioned install folders. Stop the service before a file-copy backup; account for SQLite WAL files. Do not delete or migrate user data as routine cleanup.
