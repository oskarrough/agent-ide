# agent-ide

A small agent IDE built on [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable), meant to show how little it takes. Threads live on a server; runners on your machines answer them. Runs with bun or Node.js 24+, no build step.

## Try it

In two terminals:

```sh
bun install
bun server.js
```

```sh
bun runner.js --name laptop --dir ~/code
```

Open http://127.0.0.1:3000 and:

1. Under Threads, click **+ new**.
2. In the To row, pick `laptop` and `echo`. Type `hello` and send. The echo harness answers straight away, which proves the loop works.
3. Switch the harness to `pi-durable` and ask something real. It uses your pi login, so run `pi` and `/login` once first if you haven't.
4. Send `$ ls` to run a command in the runner's folder.
5. Tick **Show structure** at the top to see the JSON behind it all.

## What it explores

1. A server that decides where threads live and which runner does what. It doesn't have to stay a server.
2. Runners: optional machines that connect to the server, each with whatever harnesses it has installed.
3. Multiplayer threads, where several humans and agents talk, and anyone can steer or stop an agent that's working.
4. Forking a thread at any entry, to try another agent or model from the same point.
5. Messages between threads, so one thread can hand work to another and get the answer back.

```
client.html ──▶ server.js (threads and their entries, which runners are online)
                   ▲
                   └── runner.js dials in and answers entries addressed to it: pi-durable, shell, echo, claude, codex, pi
```

## Words

- A **thread** holds **entries**: chat, a command's output, a note from the server, or an error. A thread can have a parent.
- An entry can say who should answer it with a **to**: a runner, one of its harnesses, and optionally a model, effort and folder. An entry without one is for the humans.
- A **runner** is a machine connected to the server. A **harness** is what it answers with. The answer is an entry signed like `codex@laptop`, and its `replyTo` points at the entry it answers.
- An addressed entry with no answer yet is **pending**: working while its runner has it, queued while the runner is offline.
- A thread's **status** is working, queued, done (an answer you haven't seen), failed, or idle.

Posting an entry is the one thing you do. The `$ cmd` shorthand addresses the runner's `shell` harness. Handing work off is posting the first entry of a child thread; each answer there is reported to the parent.

## Server

```sh
bun server.js                          # http://127.0.0.1:3000
HOST=0.0.0.0 PORT=3001 bun server.js   # reachable from other machines
DIRECTOR=1 bun server.js               # multiplayer: see below
```

Each server has its own SQLite file (`DB_PATH`, default `threads-PORT.db`). Servers share nothing. Pending entries are stored like any other, so they survive a restart. There is no authentication, so keep it on a trusted network.

By default a thread is single-player: the client addresses each entry to whoever the thread last asked, so every entry gets an answer. With `DIRECTOR=1`, [director.js](director.js) decides instead. The client then sends entries to nobody, and an @mention such as `@codex` or `@codex@laptop` calls in an agent that has answered in the thread before.

## Client

`bun client.html` serves it with live reload, and every server serves it at `/`. Add one or more servers; the list stays in localStorage. `?user=ana` posts as someone else.

The sidebar shows each server's options, its runners and what each is answering, and its threads with their status. A thread starts with its first entry. Pick who answers in the To row, or tick "in a child thread" to hand the entry off. "Show structure" adds the raw JSON of the server, runners, thread and every entry, for tracing what happened.

## Runner

```sh
bun runner.js --server http://127.0.0.1:3000 --name laptop [--alias "Oskar's laptop"] --dir ~/code [--owner oskar]
```

A runner connects to one server, reports its harnesses and answers what's addressed to it. It never acts on its own. Commands run in a folder under `--dir`. The name is its key and the alias is what the client shows.

`pi-durable` is the runner's own harness, built on Pi Durable. Each thread gets one conversation on the runner, stored in `~/.agent-ide/NAME.sqlite`, with read, write, edit and bash. It uses pi's logins, and pi's default model unless the `to` names one as `provider/model`. Answers stream into the thread with their tool calls. If the runner dies mid-answer, it finishes on restart and posts the answer late.

`claude`, `codex` and `pi` are one-shot: each answer is a fresh process that gets the whole thread as its prompt. `shell` runs the entry as a command, and `echo` repeats it, for testing.

`delegate.js --server URL --parent T --runner laptop --harness codex "task"` hands off from the command line.

## API

Send `x-user: name` to say who you are.

- `GET /api/server` lists the server's options and counts.
- `GET|POST /api/threads` `{"title","parent"?}`. Each thread comes with its `status`, `pending` entries and `live` answers.
- `GET|POST /api/threads/:id/entries` `{"body","to"?: {"runner","harness","model"?,"effort"?,"dir"?}}`
- `POST /api/threads/:id/read` marks the thread read for you, so its last answer stops counting as done.
- `POST /api/entries/:id/cancel` answers a queued entry with a note, so nobody owes it anymore.
- `GET /api/runners` lists each runner's harnesses and the entries it's working on.
- `/ws` pushes `{threadId}` on changes and `{threadId, live}` for answers in progress. Runners connect with `/ws?runner=NAME&harnesses=…`, receive `{entry}`, and post to `/api/entries/:id/live` while they work and `/api/entries/:id/reply` when done.
