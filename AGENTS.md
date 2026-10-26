# AGENTS.md

- A change serves one of the promises in [docs/concepts.html](docs/concepts.html), or it doesn't land.
- Use the words concepts.html uses, one per concept. Fewer concepts beats fewer lines.
- Durability, ordering, retries and cancellation are Pi Durable's: find its primitive before writing your own.
- New features are modules, off by default.
- Keep concepts.html and the README saying what the code does.
- Prove things in `examples/`, one file per idea. No unit tests, no TypeScript, no build step, no migrations or shims.
- Check UI changes in a browser: `agent-browser open http://127.0.0.1:3000` with `bun server.js` running.
- When a better design breaks a principle, or an idea looks wrong, Oskar's included, argue before building.
