# agent-ide

A small agent IDE on [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable), built to show how little it takes. One server keeps every thread. Runners on your machines lend it their model logins and a folder. Runs with bun or Node.js 24+, no build step.

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
2. In the To row, pick `laptop` and the model `echo/echo`. Send `hello`. Echo answers at once, which proves the loop works.
3. Clear the model to get the runner's default, pi's own, and ask something real. Run `pi` and `/login` on the runner once if you haven't.
4. Send `$ ls` to run a command in the runner's folder.
5. Tick **Show structure** to see the JSON behind it all.

Or read [examples/](examples): one file per idea, each starting its own server and runner, checking what it claims. `bun run examples` runs them all, `bun examples/05-fork.js` one. The last uses a real model through your pi login, so it only runs on its own or with `REAL=1 bun run examples`.

## The machine

```
client.html ──▶ server.js   one Pi Durable harness; every thread is a conversation in it
                   ▲  model streams, file and shell calls
                   └── runner.js   on your machine: its pi logins, its folder
```

1. The server keeps everything in one Pi Durable harness over one SQLite file: each thread is a conversation, and what agent-ide adds, like a title, a parent and read markers, is Pi docs beside it.
2. A runner is a process on someone's machine that connects to the server's WebSocket and lends it its pi logins and a folder; it stores nothing.
3. The server registers each runner as a Pi model provider, `runner:NAME`, whose streams run on the runner, and as the execution environment of every conversation whose agent uses it: Pi's whole `ExecutionEnv`, called over the socket and working in the runner's folder. Calls to an offline runner wait for it.
4. An agent is a model on a runner, named `model@runner`, and a thread's agent is Pi's own agent setting; `echo/echo` is pi-ai's faux provider, for testing.
5. Posting an entry is the one action: its `to` names the agent that answers and becomes the thread's agent, no `to` means the thread's agent, `to: null` means nobody, and `$ cmd` runs on the agent's runner.
6. A thread runs one agent at a time, so while one works, asking a different agent there is refused.
7. An input's Pi request id holds its `author`, `to` and `key` as URL params, plus `from` and `re` when it comes from another thread; the model reads them as a heading before the body.
8. The server follows every input to its answer, again after a restart from Pi's submission records, and reports a child thread's answers to its parent as a note.
9. A fork is Pi's own conversation fork at an entry; it reports nowhere, and its inherited inputs keep their authors.
10. A thread's status for a reader is one of the [Program Status Protocol](https://www.superlogical.com/rex/docs/build/program-status)'s five words: working, or blocked when its runner is offline, from Pi's live run and inbox; done or error for a result newer than the reader's read marker; otherwise idle.
11. Anything a restart or a replayed tool call might repeat is keyed, so the repeat finds the first.
12. Optional behaviour lives in modules, one file each, switched by an env var of its name: [talk.js](talk.js) (on, `TALK=0`) gives agents `post` and `threads` tools; [status.js](status.js) (on, `STATUS=0`) has runners report to their terminal with OSC 7501, a record for the runner and one per thread by its id; [director.js](director.js) (`DIRECTOR=1`) has an entry answered only by an agent it @mentions.
13. With talk, an answer to an agent's post comes back to the asking thread as an input with `from` and `re` that steers in and asks for nothing back, like email.
14. [examples/](examples) defines the rest and checks all of it: the HTTP API, the runner end's interface (`serveRunner` in [remote.js](remote.js)), and each sentence above.

## What it explores

1. A server that decides where threads live and which runner does what. It doesn't have to stay a server.
2. Runners: optional machines that lend the server their logins and folders.
3. Multiplayer threads, where several humans and agents talk, and anyone can steer or stop an agent that's working.
4. Forking a thread at any entry, to try another agent from the same point.
5. Messages between threads, so one thread can hand work to another and get the answer back.

## Running it

```sh
bun server.js                          # http://127.0.0.1:3000, stored in agent-ide-3000.sqlite
HOST=0.0.0.0 PORT=3001 bun server.js   # reachable from other machines
DIRECTOR=1 bun server.js               # multiplayer
TALK=0 STATUS=0 bun server.js          # the core alone
DB_PATH=other.sqlite bun server.js     # another store; only one server may use a file

bun runner.js --server http://127.0.0.1:3000 --name laptop [--alias "Oskar's laptop"] --dir ~/code [--owner oskar]
```

The client is served at `/`, or by `bun client.html` with live reload. It can hold several servers. `?user=ana` posts as someone else. There is no authentication: anyone who can reach the server can claim any name, so keep it on a trusted network.

## API

Send `x-user: name` to say who you are.

- `GET /api/server`: the server's options, its modules, and what Pi is running.
- `GET|POST /api/threads` `{"title","parent"?}`: each thread with its agent and status.
- `GET /api/threads/:id`: the thread, Pi's docs (`pi.live`, `pi.inbox`, `pi.agent`, `pi.usage`), and every entry as `{author, to, re?, entry}`, plus `requestId, from, body` on inputs. `re` lists what an entry answers: for an answer, the inputs here; with `from`, the posts it answers in that thread.
- `POST /api/threads/:id/entries` `{"body","to"?: {"runner","model"?,"effort"?,"dir"?} | null, "steer"?: true}`: a steer joins the answer being written.
- `POST /api/threads/:id/fork` `{"at": entryId, "title"?}`: a new thread from that entry.
- `POST /api/threads/:id/read`: marks it read for you, so its last answer stops counting as done.
- `POST /api/threads/:id/stop`: withdraws queued inputs and stops the agent.
- `DELETE /api/threads/:id`: hides it; Pi Durable keeps everything.
- `GET /api/runners`: each runner, its default model, and the calls it's answering.
- Agents' tools, with talk: `post {"thread"?, "title"?, "body", "to"?}`, where no thread starts a child and `to` is `model@runner`, a runner, or `nobody`; and `threads {"thread"?, "last"?}`.
- `/ws`: pushes `{threadId}` whenever a thread changes. Runners connect here too and speak the protocol in [remote.js](remote.js).
