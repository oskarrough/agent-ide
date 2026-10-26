# AGENTS.md

agent-ide proves that an agent IDE can be small. A change serves one of the promises in [docs/concepts.html](docs/concepts.html), or it doesn't land. Read it. The sixth, memory, is under exploration: a module, off by default, until its examples prove it.

## What every change keeps

- **Clean.** One name per concept, named in docs/concepts.html. If a change can't be said in one sentence, it isn't understood yet.
- **Stable.** A restart or a stop at any point loses nothing and duplicates nothing. An action that takes more than one commit is a Pi task or transaction, or it's a bug. Durability, ordering, retries and cancellation belong to Pi Durable, so find its primitive before writing your own.
- **Fast.** Don't make it slower.
- **Agreeing.** The code is the truth; keep docs/concepts.html and the README saying the same.

## Before adding anything

1. Which primitive or principle does it touch? If none of them describes it, it's not ready.
2. Can it be a module, off by default? Then make it one.
3. Is there a version that deletes more than it adds? Build that one.

The principles can be wrong. When a clearly better design breaks one, don't bend the design to fit: stop and ask Oskar, saying which principle and why.

## Reviewing

Read docs/concepts.html, the code and Pi Durable's spec as an adversary. Look for three things:

- where we rebuild something Pi already does
- where a sentence breaks between two steps (a restart, a stop, a fork, a replay)
- any concept that serves no promise

A finding counts only if you can reproduce it. Examples prove the promises, not every edge case: an edge case gets fixed when it breaks, without an example of its own. All of them run in about 10 seconds; keep it so.

## Checking the UI

A change you can see in apps/client/client.html gets seen. Run `bun server.js` in the background, which lends this folder as a runner named after the machine (another runner needs a key: `bun cli.js key laptop` prints how to connect it), then drive the page with [agent-browser](https://github.com/vercel-labs/agent-browser):

`agent-browser open http://127.0.0.1:3000`, then `snapshot -i` for the page with @refs to act on; `agent-browser skills get core` is its own guide. Locally, install it with `npm i -g agent-browser && agent-browser install`; in Claude Code on the web, `.claude/hooks/session-start.sh` does it. Examples still prove behaviour; the browser only shows it.

## Said no

One line each, so nobody proposes them twice.

- **Unit tests.** `examples/` is the proof, with one file per idea.
- **TypeScript or a build step.** Plain JS that runs with bun or Node.
- **UX polish.** Functional UI, not shiny.
- **Rebuilding from the docs.** They're a plan, not a spec.
- **Backwards compatibility.** No migrations, shims or old shapes; an old store can be thrown away.
