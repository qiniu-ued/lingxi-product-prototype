# Repository guidance

This repository contains a designer-owned interaction prototype and a local workbench implementation.
- Preserve `source/` and root `dist/` unless a task explicitly changes the prototype. Exclude them from project-wide formatting.
- Current decisions live in `docs/product-design.md`; `docs/reference/` contains historical material. Voice, pointer and keyboard share one session.
- Use Node 24 and npm 11. Commit the npm lockfile and use `npm ci` for reproducible installs.
- Keep runtime validation in `packages/protocol`; validate HTTP input and external-provider events.
- Report actual execution events. Never present saved suggestions or demonstration timers as completed Code Agent tasks.
- Preserve request IDs across retries, bind selections to artifact versions, and separate display connection from durable task state.
- Run `npm run check` for implementation changes. Run `npm run test:e2e` when browser behavior, SSE, command APIs or synchronization changes.
- Test user-visible behavior and state boundaries rather than repeating implementation details.
- Do not commit credentials, local databases, recordings, app/package build output, or test reports. Root `dist/` is the intentional exception.
- Record architecture changes in `docs/adr/`. Keep real-device verification distinct from automated tests.
