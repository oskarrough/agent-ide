# agent-ide

A small agent IDE built on [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable), meant to show how little it takes. The server keeps every thread in one Pi Durable harness. Runners on your machines lend it their model logins and a folder to work in. Runs with bun or Node.js 24+, no build step.

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
2. In the To row, pick `laptop` and `echo`. Type `hello` and send. Echo answers straight away, which proves the loop works.
3. Switch the harness to `pi-durable` and ask something real. It uses the runner's pi login, so run `pi` and `/login` there once first if you haven't.
4. Send `$ ls` to run a command in the runner's folder.
5. Tick **Show structure** at the top to see the JSON behind it all.

## What it explores

1. A server that decides where threads live and which runner does what. It doesn't have to stay a server.
2. Runners: optional machines that connect to the server and lend it their logins and folders.
3. Multiplayer threads, where several humans and agents talk, and anyone can steer or stop an agent that's working.
4. Forking a thread at any entry, to try another agent or model from the same point.
5. Messages between threads, so one thread can hand work to another and get the answer back.

```
client.html ──▶ server.js: one Pi Durable harness; every thread is a conversation in it
                   ▲ model streams, file and shell calls
                   └── runner.js dials in and answers them with its own pi logins, in its own folder
```

Threads are stored once, in the server's harness. A runner keeps nothing.

## Words

- A **thread** is a Pi Durable conversation. Its **entries** are Pi entries: a human's input (`pi.user`), the agent's answers, tool calls and results (`pi.assistant`, `pi.tool-result`), and agent-ide's own kinds: chat nobody answers (`agent-ide.chat`), a command's output (`agent-ide.shell`), a note (`agent-ide.note`) and an error (`agent-ide.error`). A thread can have a parent.
- An entry can say who should answer it with a **to**: a runner, a harness, and optionally a model, effort and folder. The server turns it into the conversation's agent: the model through the runner, effort as thinking level, the folder as its working directory.
- A **runner** is a machine connected to the server. A **harness** is what answers: `pi-durable` with a real model, or `echo`. An agent has one name everywhere, like `pi-durable@laptop`.
- A thread's **status** comes from Pi: working while a run is going, queued while its runner is offline, done (an answer you haven't seen), failed, or idle.

Posting an entry is the one thing you do. With no `to`, the server picks the thread's last agent; `to: null` means nobody answers. `$ cmd` runs on the runner instead of asking its agent. Handing work off is posting the first entry of a child thread; each answer there is reported to the parent.

One conversation runs one agent at a time. While it works, another entry for the same agent waits its turn; an entry for a different agent is refused until it's done or stopped.

## Server

```sh
bun server.js                          # http://127.0.0.1:3000
HOST=0.0.0.0 PORT=3001 bun server.js   # reachable from other machines
DIRECTOR=1 bun server.js               # multiplayer: see below
```

A small local patch to Pi Durable ([patches/](patches), applied by `bun install`) lets an input carry data, so each human input lands as a `pi.user` entry with its author and `to` on it.

Each server has its own Pi Durable SQLite file (`DB_PATH`, default `agent-ide-PORT.sqlite`). Servers share nothing, and only one server may use a file. The old `threads-*.db` files are left alone and not read. There is no authentication, so keep it on a trusted network.

Everything an answer does is committed before it's shown, so a server restart picks up where it stopped: a half-written answer is kept as an aborted entry and asked again. If a runner drops mid-answer, Pi's own rules decide: a broken model stream is retried once the runner is back, and a tool call that was running fails, so the model sees the error and carries on.

The server never holds a model login. It registers each runner as a pi-ai provider (`runner:laptop`) whose models are pi's catalog as `provider/model`, and whose streams run on the runner. A conversation's files and commands go to the runner its model is on, through a remote execution environment confined to that runner's `--dir`. Shell commands can still reach outside it; only file paths are checked.

By default a thread is single-player: an entry without a `to` goes to the thread's last agent. With `DIRECTOR=1`, [director.js](director.js) decides instead: an entry goes to nobody unless an @mention such as `@echo` or `@pi-durable@laptop` calls in an agent the thread has asked before.

## Client

`bun client.html` serves it with live reload, and every server serves it at `/`. Add one or more servers; the list stays in localStorage. `?user=ana` posts as someone else.

The sidebar shows each server's file and options, what Pi is running, its runners with their folder, default model and current calls, and its threads with their status. In the To row, default leaves the choice to the server; tick "in a child thread" to hand the entry off. The thread shows Pi's live answer, running tools and queued inputs as they happen, and a stop button while an agent works. "Show structure" adds the raw JSON of the server, runners, thread and every entry.

## Runner

```sh
bun runner.js --server http://127.0.0.1:3000 --name laptop [--alias "Oskar's laptop"] --dir ~/code [--owner oskar]
```

A runner connects to one server and does what it's asked: stream a model with this machine's pi logins (`~/.pi/agent/auth.json`), or read, write and run commands under `--dir`. It never acts on its own and stores nothing. It reports pi's default model, which an entry gets when it names none. `echo` is pi-ai's faux provider, for testing. The name is its key and the alias is what the client shows.

## API

Send `x-user: name` to say who you are.

- `GET /api/server` lists the server's options and what Pi is running (`harness.inspect()`).
- `GET|POST /api/threads` `{"title","parent"?}`. Each thread comes with its `status` and agent.
- `GET /api/threads/:id` is the thread: its row, Pi's built-in docs (`pi.live`, `pi.inbox`, `pi.agent`, `pi.usage`), shell commands still running, and every entry as `{author, to, replyTo, entry}`. `replyTo` lists the inputs an answer settled, from Pi's submission records; a steer makes it two.
- `DELETE /api/threads/:id` hides it. Pi Durable keeps everything.
- `POST /api/threads/:id/entries` `{"body","to"?: {"runner","harness","model"?,"effort"?,"dir"?} | null, "steer"?: true}`. A steer joins the answer being written instead of waiting for it.
- `POST /api/threads/:id/read` marks the thread read for you, so its last answer stops counting as done.
- `POST /api/threads/:id/stop` withdraws queued inputs and aborts the run.
- `GET /api/runners` lists each runner and the calls it is answering.
- `/ws` pushes `{threadId}` whenever a commit touches a thread, and `{threadId: null}` when the lists change. Runners connect with `/ws?runner=NAME&harnesses=…&dir=…&model=…` and speak the protocol in [remote.js](remote.js).
