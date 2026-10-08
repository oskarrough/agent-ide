# AGENTS.md

agent-ide proves that an agent IDE can be small. This file is how we keep it that way. Read it before you change anything.

## What agent-ide is

Four promises, and nothing else:

1. **Threads with many authors.** Humans and agents talk in one thread, and each agent answers from its own conversation.
2. **Runners.** Tool calls run on a machine you choose, in a folder you choose, with that machine's logins.
3. **Models of your choice.** Any model pi can name, named the way pi names it.
4. **Stable messaging.** A message between threads arrives once and its answer comes back once, even across restarts and stops.

A change serves one of these, or it doesn't land.

## What every change keeps

- **Clean.** One name per concept. Every rule is a numbered sentence under "The machine" in the README. If a change can't be said in one sentence, it isn't understood yet.
- **Stable.** A restart or a stop at any point loses nothing and duplicates nothing. An action that takes more than one commit is a Pi task or transaction, or it's a bug. Durability, ordering, retries and cancellation belong to Pi Durable, so find its primitive before writing your own.
- **Fast.** No guardrail yet. Don't make it slower.
- **Small.** The line count only grows with a reason in the commit message.
- **Rebuildable.** The README and `examples/` are enough to rebuild it.

## Before adding anything

1. Which promise does it serve? If none, the answer is no.
2. Which README sentence changes? If no sentence can say it, it's not ready.
3. Can it be a module, off by default? Then make it one.
4. Is there a version that deletes more than it adds? Build that one.

## The loop

Run it by hand, when Oskar asks.

1. **Examples.** `bun run examples` passes.
2. **Rebuild.** Copy only `README.md`, `examples/` and `package.json` into an empty folder, and run `bun install`. A cheap model writes the code until the examples pass. In `FINDINGS.md` it logs every guess: what it needed, where it found it, and the sentence the README lacked.
3. **Review.** A model that didn't write the code reads the README, the code and Pi Durable's spec, as an adversary. It looks for three things:
   - where we rebuild something Pi already does
   - where a sentence breaks between two steps (a restart, a stop, a fork, a replay)
   - any concept that serves no promise

   A finding counts only if an example reproduces it.
4. **Scoreboard.** Add a row. Fix what was reproduced. Turn each guess into a README sentence, or cut what caused it.

The round is done when the review reproduces nothing.

## Scoreboard

| main | lines | sentences | rebuild guesses | reproduced findings |
|---|---|---|---|---|
| `50bf6a1` | 2,192 | 18 | 31 (Sonnet 5.5) | 3 (GPT-6-Astra) |

Lines count `*.js`, `client.html`, `README.md` and `examples/*.js`.

## Said no

One line each, so nobody proposes them twice.

- **Unit tests.** `examples/` is the proof, with one file per idea.
- **TypeScript or a build step.** Plain JS that runs with bun or Node.
- **UX polish.** The client shows the data, nothing more.
- **Our own durability.** Pi Durable has it.
- **Running the loop on every push.** It costs a rebuild and a review each time. We run it by hand until the scoreboard shows it pays.
- **Speed guardrails, for now.** It's fast already.
