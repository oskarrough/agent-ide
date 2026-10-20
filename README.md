# agent-ide

A small agent IDE on [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable), built to show how little it takes. One server keeps every thread. Runners on your machines lend it their model logins and a folder. Runs with bun or Node.js 24+, no build step.

## What it promises

1. **Threads with many authors.** Humans and agents talk in one thread, and each agent answers from its own conversation.
2. **Runners.** Tool calls run on a machine you choose, in a folder you choose, with that machine's logins.
3. **Models of your choice.** Any model pi can name, named the way pi names it.
4. **Stable messaging.** A message between threads arrives once and its answer comes back once, even across restarts and stops.
5. **Forks.** Fork a thread at any entry, with each agent in it, to try another path from the same point.
6. **Memory** (under exploration). A thread never has to end, and anything said in it can be found again, word for word.

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
2. In To, write `echo/echo@laptop`. Send `hello`. Echo answers at once, which proves the loop works.
3. Write just `laptop` to get the runner's default, pi's own, and ask something real. Run `pi` and `/login` on the runner once if you haven't. Left empty, To asks whom the thread last asked.
4. Send `$ ls` to run a command in the runner's folder.
5. Tick **Show structure** to see the JSON behind it all.

Or read [examples/](examples): one file per idea, each starting its own server and runner, checking what it claims. `bun run examples` runs them all, `bun examples/05-fork.js` one. Those named `real-model` use a real model through your pi login, so they only run on their own or with `REAL=1 bun run examples`.

## The machine

```
client.html ──▶ server.js   one Pi Durable harness: threads, and each agent's conversation in them
                   ▲  model streams, file and shell calls
                   └── runner.js   on your machine: its pi logins, its folder
```

Pi Durable does the heavy lifting: storage, tasks, ordering, retries, restarts, stops and forks. agent-ide adds four things on top.

- A **thread** is a Pi conversation that never runs a model. Every entry is a message with an author and a body. What agent-ide adds, like a title, a parent, read markers and the thread's agents, sits beside it as a Pi doc.
- A **runner** lends the server a machine's pi logins and a folder, and stores nothing. The server registers it as a Pi model provider and as the execution environment of every conversation whose model runs on it. Calls to an offline runner wait for it.
- An **agent** is a model on a runner, `provider/id@runner`, resolved the way `pi --model` resolves it. In each thread an agent answers from its own Pi conversation.
- A **task** is Pi's. Deliver hands an agent its messages, Shell runs `$ cmd` on a runner, and Anchor owns an agent's conversation so that a stop reaches it.

And a few principles:

- Agents only see messages. Each delivery hands an agent everything it hasn't seen yet as one input, and only its final answer comes back to the thread. Its tool calls stay in its own conversation.
- A message asks the agents in its `to`. With no `to`, it asks whoever the thread asked last, and `to: null` asks nobody.
- Every write lands in the commit that ends or advances a Pi task, so a restart repeats nothing. A retried request with the same `requestId` gets the first result back.
- A stop posts nothing, and messages that were never delivered wait for the next delivery.
- A fork forks the thread and each agent's conversation at the same point, in one commit.
- Threads talk like email. A child reports its answers to its parent. When an agent answers another thread's post, the answer goes back to that thread, and a reply to that answer ends the exchange.
- A name is one line of plain text, so nobody can forge a speaker in an agent's input.
- A runner with an `--owner` takes work only from its owner and the names it `--allow`s: people, or `@runner` for the agents there. An agent always reaches its own runner. Allowing is transitive: allow `@desktop`, and whoever desktop takes can reach you through its agents. A refusal writes nothing.
- The client watches Pi's own event streams, so replies and tool calls show live. A reconnect starts from fresh snapshots.
- Anything optional is a module: one file, switched by an env var of the same name. [talk.js](talk.js) gives agents `post` and `threads` tools. [status.js](status.js) has runners report status to their terminal. [director.js](director.js) asks the agents a message @mentions. [memory.js](memory.js) gives each thread a memory of short lines that agents read within their context and zoom back down to the words. [matrix.js](matrix.js) mirrors Matrix rooms into threads, and its top says how to set it up.

The code is the truth. [examples/](examples) shows each idea working.

## Running it

```sh
bun server.js                          # http://127.0.0.1:3000, stored in agent-ide-3000.sqlite
HOST=0.0.0.0 PORT=3001 bun server.js   # reachable from other machines
DIRECTOR=1 bun server.js               # multiplayer
TALK=0 STATUS=0 bun server.js          # the core alone
MEMORY=1 MEMORY_MODEL=haiku@laptop bun server.js   # threads that never end
MATRIX=1 MATRIX_TOKEN=… MATRIX_ROOMS=… bun server.js   # Matrix rooms as threads; see matrix.js and apps/matrix-sync
bun scripts/replay-pi.js ~/.pi/agent/sessions/FOLDER   # pi sessions, or one .jsonl, as one long thread
DB_PATH=other.sqlite bun server.js     # another store; only one server may use a file

bun runner.js --server http://127.0.0.1:3000 --name laptop [--alias "Oskar's laptop"] --dir ~/code [--owner oskar [--allow ana --allow @desktop]]
```

The client is served at `/`, or by `bun client.html` with live reload. It can hold several servers. `?user=ana` posts as someone else. There is no authentication: anyone who can reach the server can claim any name, so keep it on a trusted network. A runner's owner keeps out agents on other runners, which can't pick their name, but not a person who claims to be the owner.

## API

Send `x-user: name` to say who you are. The two POSTs that make something, a thread and an entry, take an optional `"requestId"` (a string of up to 128 characters, such as `crypto.randomUUID()`): send the same one again after a dropped response and you get the first result back, whatever else changed. It is a field of the body because the client already writes one, where a header would need CORS help. A thread entry is Pi's own, `{id, kind: "agent-ide.message", data}`, and `data` is a message:

```
{ author, body, to?: [{runner, model, effort?, dir?}], from?: threadId, re?: [entryId],
  answer?: {conversation, entry}, error?: true, shell?: {runner, code, stdout, stderr} }
```

- `GET /api/server`: the server's options, its modules, and what Pi is running.
- `GET|POST /api/threads` `{"title","parent"?,"requestId"?}`: each thread with its agents, status, running commands and Pi conversation record.
- `GET /api/threads/:id`: the thread's row, its `agents` as `{name, conversation, to, status}`, and every entry.
- `POST /api/threads/:id/entries` `{"body","to"?: agent | [agent] | null, "steer"?: true, "requestId"?}`, an agent being `{"runner","model"?,"effort"?,"dir"?}` and its model anything `pi --model` takes: a steer joins the answer being written. A runner that doesn't take work from you answers 403.
- `POST /api/threads/:id/fork` `{"at": entryId, "title"?}`: a new thread from that entry.
- `POST /api/threads/:id/read`: marks it read for you, so its last answer stops counting as done.
- `POST /api/threads/:id/stop`: stops its agents, deliveries and commands, and withdraws their queued inputs.
- `DELETE /api/threads/:id`: hides it; Pi Durable keeps everything.
- `GET /api/threads/:id/memory?zoom=id,n`: with memory, the thread's memory within 64 KB as `{lines: [{id, n, text}]}`, or with `zoom` the two lines that line was made from, or `{message}` whole when `n` is 1; the client shows it as a panel.
- `GET /api/conversations/:id`: any Pi conversation's view as Pi gives it, such as an agent's: its entries and docs.
- `GET /api/runners`: each runner, its `owner` and whom it `allow`s, its default model or `modelError` when pi's default doesn't resolve, the models it `offers` from pi's enabled models, the models it has resolved, and the calls it's answering.
- Agents' tools, with talk: `post {"thread"?, "title"?, "body", "to"?}`, where no thread starts a child and `to` is `model@runner`, a runner, or `nobody`; and `threads {"thread"?, "last"?, "query"?}`; with memory, `zoom {"id","n"}`.
- `/ws`: pushes `{}` whenever something changes. Send `{"watch": threadId}` (or `null`) to watch one: `{thread, events}` for its conversation and `{thread, agent, events}` for each agent's, Pi's `watchEvents` stream, snapshot first. Runners connect here too and speak the protocol in [remote.js](remote.js).
