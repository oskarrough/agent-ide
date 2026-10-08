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
client.html ──▶ server.js   one Pi Durable harness: threads, and each agent's conversation in them
                   ▲  model streams, file and shell calls
                   └── runner.js   on your machine: its pi logins, its folder
```

1. The server keeps everything in one Pi Durable harness over one SQLite file: each thread is a Pi conversation, and what agent-ide adds, like a title, a parent, read markers and its agents, is a Pi doc beside it.
2. A runner is a process on someone's machine that connects to the server's WebSocket and lends it its pi logins and a folder; it stores nothing.
3. The server registers each runner as a Pi model provider, `runner:NAME`, whose streams run on the runner, and as the execution environment of every conversation whose model is on it: Pi's whole `ExecutionEnv`, called over the socket and working in the runner's folder. Calls to an offline runner wait for it.
4. An agent is a model on a runner, named by the model's id without its provider, so `echo/echo` on `laptop` is `echo@laptop`. `echo/echo` is pi-ai's faux provider, for testing: it answers `echo@RUNNER heard: ` and the last user text.
5. A thread never runs: every entry in it is a passive message with its `author` and `body`, and `to`, `from`, `re`, `answer`, `error` or `shell` when it has them.
6. Posting a message is the one action: its `to` names the agents it asks, no `to` asks whom the thread last asked, `to: null` asks nobody, and `$ cmd` runs on the first agent's runner and posts what it printed.
7. Each agent in a thread answers from its own Pi conversation, made the first time it is asked there. The thread's doc maps the agent's name to that conversation, and a small doc on the conversation names its thread and the agent's name there. Having no thread doc, it never shows up as a thread.
8. Asking an agent sends its conversation one input. The input holds every thread message the agent hasn't seen yet, except its own: those with its name and no `from`. Each is written as `author: body`, or `author, writing from thread N: body` (`answering` for a message with `re`) when it came from another thread.
9. Each input's Pi request id records `upto`, the newest thread entry it holds, and `re`, the messages in it that asked the agent. The agent has seen everything up to the highest `upto` among its inputs. An input withdrawn before it was placed doesn't count.
10. An agent's final answer is copied back into the thread with `re`, the messages that asked it, and `answer`, the entry it came from. An input that ends with no answer posts an `error` message instead, unless it was stopped. Other agents never see its tool calls.
11. Several agents can work in one thread at once. The thread is working while any of them is, and stopping it stops them all.
12. The server follows every input to its answer, again after a restart from Pi's submission records, and reports a child thread's answers to its parent as a message with `from`.
13. A fork is Pi's own fork of the thread at an entry, plus a fork of each agent's conversation at its last answer up to there, all in one commit. A fork reports nowhere.
14. A thread's status for a reader is one of the [Program Status Protocol](https://www.superlogical.com/rex/docs/build/program-status)'s five words: working, or blocked when its working agents' runners are offline, from Pi's live run and inbox of their conversations; done or error for a result newer than the reader's read marker; otherwise idle.
15. Anything a restart or a replayed tool call might repeat is keyed, so the repeat finds the first.
16. Optional behaviour lives in modules, one file each, switched by an env var of its name: [talk.js](talk.js) (on, `TALK=0`) gives agents `post` and `threads` tools; [status.js](status.js) (on, `STATUS=0`) has runners report to their terminal with OSC 7501, a record for the runner and one per thread by its id; [director.js](director.js) (`DIRECTOR=1`) has a message ask the agents it @mentions.
17. With talk, when an agent answers a post from another thread, the answer goes back to that thread as a message with `from` and `re`. That message asks the agent who posted, and steers into its work if it is busy. Answering it sends nothing back, so the exchange ends there, like email.
18. [examples/](examples) defines the rest and checks all of it: the HTTP API, the runner end's interface (`serveRunner` in [remote.js](remote.js)), and each sentence above.

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

Send `x-user: name` to say who you are. A thread entry is Pi's own, `{id, kind: "agent-ide.message", data}`, and `data` is a message:

```
{ author, body, to?: [{runner, model, effort?, dir?}], from?: threadId, re?: [entryId],
  answer?: {conversation, entry}, error?: true, shell?: {runner, code, stdout, stderr} }
```

- `GET /api/server`: the server's options, its modules, and what Pi is running.
- `GET|POST /api/threads` `{"title","parent"?}`: each thread with its agents and status.
- `GET /api/threads/:id`: the thread, its Pi conversation record, its `agents` as `{name, conversation, to, status}`, and every entry.
- `POST /api/threads/:id/entries` `{"body","to"?: agent | [agent] | null, "steer"?: true}`, an agent being `{"runner","model"?,"effort"?,"dir"?}`: a steer joins the answer being written.
- `POST /api/threads/:id/fork` `{"at": entryId, "title"?}`: a new thread from that entry.
- `POST /api/threads/:id/read`: marks it read for you, so its last answer stops counting as done.
- `POST /api/threads/:id/stop`: withdraws queued inputs and stops its agents.
- `DELETE /api/threads/:id`: hides it; Pi Durable keeps everything.
- `GET /api/conversations/:id`: any Pi conversation's view as Pi gives it, such as an agent's: its entries and docs.
- `GET /api/runners`: each runner, its default model, and the calls it's answering.
- Agents' tools, with talk: `post {"thread"?, "title"?, "body", "to"?}`, where no thread starts a child and `to` is `model@runner`, a runner, or `nobody`; and `threads {"thread"?, "last"?}`.
- `/ws`: pushes `{threadId}` whenever a thread changes. Runners connect here too and speak the protocol in [remote.js](remote.js).
