# AGENTS.md

agent-ide proves that an agent IDE can be small. 

## What agent-ide is

The promises under "What it promises" in the README, and nothing else. Read the readme. The sixth is under exploration: a module, off by default, until its examples prove it. A change serves one of them, or it doesn't land.

## What every change keeps

- **Clean.** One name per concept, named in the README. If a change can't be said in one sentence, it isn't understood yet.
- **Stable.** A restart or a stop at any point loses nothing and duplicates nothing. An action that takes more than one commit is a Pi task or transaction, or it's a bug. Durability, ordering, retries and cancellation belong to Pi Durable, so find its primitive before writing your own.
- **Fast.** No guardrail yet. Don't make it slower.
- **Planned.** The README holds the principles and primitives; the code is the truth. Keep them agreeing.

## Before adding anything

1. Which promise does it serve? If none, the answer is no.
2. Which primitive or principle does it touch? If none can say it, it's not ready.
3. Can it be a module, off by default? Then make it one.
4. Is there a version that deletes more than it adds? Build that one.

The principles can be wrong. When a clearly better design breaks one, don't bend the design to fit: stop and ask Oskar, saying which principle and why.

## Reviewing

Read the README, the code and Pi Durable's spec as an adversary. Look for three things:

- where we rebuild something Pi already does
- where a sentence breaks between two steps (a restart, a stop, a fork, a replay)
- any concept that serves no promise

A finding counts only if an example reproduces it, and its fix lands with that example.

## Checking the UI

A change you can see in client.html gets seen. Run `bun server.js` and `bun runner.js --name laptop --dir .` in the background, then drive the page with [agent-browser](https://github.com/vercel-labs/agent-browser):

```sh
agent-browser open http://127.0.0.1:3000
agent-browser snapshot -i            # the page as an accessibility tree, with @refs
agent-browser click @e9              # act on a ref
agent-browser fill @e11 hello
agent-browser screenshot shot.png
agent-browser close --all
```

`agent-browser skills get core` is its own guide. Locally, install it with `npm i -g agent-browser && agent-browser install`; in Claude Code on the web, `.claude/hooks/session-start.sh` does it. Examples still prove behaviour; the browser only shows it.

## Said no

One line each, so nobody proposes them twice.

- **Unit tests.** `examples/` is the proof, with one file per idea.
- **TypeScript or a build step.** Plain JS that runs with bun or Node.
- **UX polish.** Functional UI, not shiny.
- **Our own durability.** Pi Durable has it.
- **Rebuilding from the README.** It's a plan, not a spec. 
- **Backwards compatibility.** No migrations, shims or old shapes; an old store can be thrown away.
