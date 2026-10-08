# AGENTS.md

agent-ide proves that an agent IDE can be small. This file is how we keep it that way. Read it before you change anything.

## What agent-ide is

The promises under "What it promises" in the README, and nothing else. The sixth is under exploration: a module, off by default, until its examples prove it. A change serves one of them, or it doesn't land.

## What every change keeps

- **Clean.** One name per concept. Every rule is a numbered sentence under "The machine" in the README. If a change can't be said in one sentence, it isn't understood yet.
- **Stable.** A restart or a stop at any point loses nothing and duplicates nothing. An action that takes more than one commit is a Pi task or transaction, or it's a bug. Durability, ordering, retries and cancellation belong to Pi Durable, so find its primitive before writing your own.
- **Fast.** No guardrail yet. Don't make it slower.
- **Small.** The line count only grows with a reason in the commit message.
- **Planned.** The README is the machine's plan, in rules; the code is how it runs. They change together.

## Before adding anything

1. Which promise does it serve? If none, the answer is no.
2. Which README sentence changes? If no sentence can say it, it's not ready.
3. Can it be a module, off by default? Then make it one.
4. Is there a version that deletes more than it adds? Build that one.

## Reviewing

Read the README, the code and Pi Durable's spec as an adversary. Look for three things:

- where we rebuild something Pi already does
- where a sentence breaks between two steps (a restart, a stop, a fork, a replay)
- any concept that serves no promise

A finding counts only if an example reproduces it, and its fix lands with that example.

## Said no

One line each, so nobody proposes them twice.

- **Unit tests.** `examples/` is the proof, with one file per idea.
- **TypeScript or a build step.** Plain JS that runs with bun or Node.
- **UX polish.** The client shows the data, nothing more.
- **Our own durability.** Pi Durable has it.
- **Rebuilding from the README.** It's a plan, not a spec. A rebuild cost more than it taught.
- **Speed guardrails, for now.** It's fast already.
