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

## The idea

```
client.html ──▶ server.js   one Pi Durable harness; every thread is a conversation in it
                   ▲  model streams, file and shell calls
                   └── runner.js   on your machine: its pi logins, its folder
```

- A **thread** is a Pi Durable conversation with a title, and maybe a parent. It's stored once, on the server.
- An **entry** is one record in a thread. Pi's own kinds are a human's input, an answer, a tool call and its result. Ours are chat for the humans, a command's output, a note and an error.
- A **runner** is a machine connected to the server. It streams models with its own logins and runs file and shell calls in its folder. It stores nothing.
- An **agent** is a model on a runner, named like `gpt-6.1-sol@laptop`, with an optional effort level and folder. A thread has one agent at a time, kept as Pi's own agent setting.
- An entry's **to** names the agent that should answer it. An input keeps its author and `to` in its Pi request id, written as URL params: `author=oskar&runner=laptop&model=echo%2Fecho&key=…`.
- Agents have two tools of their own, run by the server: `post` to another thread, or to a new child thread, and `threads` to read one or list them.

Posting an entry is the one thing you do:

- With a `to`, that agent answers and becomes the thread's agent.
- With no `to`, the thread's agent answers.
- With `to: null`, nobody answers; it's for the humans.
- `$ cmd` runs on the agent's runner, in its folder.
- Posting into a child thread hands work off. Each answer there is reported to the parent as a note.
- An agent posts the same way, as itself. Like an email, its post says `from=` its own thread, and the answer comes back there as an input that says `from=` the thread that answered and `re=` the post it answers. The answer wakes the asking agent, or reaches it between tool calls if it's busy. An answer asks for nothing back, so two threads never ping-pong; to keep talking, an agent posts again.

Forking a thread at an entry starts a new thread with everything up to there and the agent it had then. Ask another agent from the same point; nothing in the fork reports back.

While an agent works, another entry for it waits its turn. An entry for a different agent is refused until the first is done or stopped.

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

Everything optional is a module, one file each, on or off by an env var of its name, on the server and on a runner alike. Off, it isn't loaded at all. The core is the rest: threads and entries, posting with a `to`, runners, `$ cmd`, fork, child threads reporting to their parent, the API and the push.

- [director.js](director.js), `DIRECTOR=1`, off by default: multiplayer routing, below.
- [talk.js](talk.js), `TALK=0` turns it off: agents talking to threads with `post` and `threads`, and hearing back.
- [status.js](status.js), `STATUS=0` turns it off: thread status pushed to runners, and their terminal reports.

[modules.js](modules.js) loads them and names the few hooks they can have.

A runner tells its terminal how the threads its agents answer stand, with the [Program Status Protocol](https://www.superlogical.com/rex/docs/build/program-status) (OSC 7501): one record per thread that's working, done or failed for its `--owner`, or for anyone if it has none, and one for itself. It reports only if the terminal answers the protocol's query, or with `STATUS=1`.

The client is served at `/`, or by `bun client.html` with live reload. It can hold several servers. `?user=ana` posts as someone else.

By default a thread is single-player: every entry goes to its agent. With `DIRECTOR=1`, [director.js](director.js) decides instead. An entry goes to nobody unless it @mentions an agent the thread has asked before, as `@gpt-6.1-sol@laptop`, `@gpt-6.1-sol` or `@laptop`.

A restart loses nothing. Pi commits every step before it's shown, so the server picks up where it stopped. An agent's tool call may run again after a restart; the thread it starts and the post it makes are keyed by the call, so the rerun finds them instead of making new ones. If a runner drops mid-answer, Pi's rules decide: a broken model stream is retried once the runner is back, and a running tool call fails, so the model sees the error and carries on.

Things to know:

- **No authentication:** keep the server on a trusted network.
- **Shell not confined:** file paths are confined to the runner's `--dir`, but shell commands can reach outside it.

## API

Send `x-user: name` to say who you are.

- `GET /api/server`: the server's options, and what Pi is running.
- `GET|POST /api/threads` `{"title","parent"?}`: each thread with its agent and status, in the Program Status Protocol's words: working, blocked (its runner is offline), done, error, idle.
- `GET /api/threads/:id`: the thread, Pi's docs (`pi.live`, `pi.inbox`, `pi.agent`, `pi.usage`), and every entry as `{author, to, replyTo, entry}`, plus `requestId, from, re, body` on inputs.
- `POST /api/threads/:id/entries` `{"body","to"?: {"runner","model"?,"effort"?,"dir"?} | null, "steer"?: true}`: a steer joins the answer being written.
- `POST /api/threads/:id/fork` `{"at": entryId, "title"?}`: a new thread from that entry. Pi's `conversation.parent` says where it came from.
- `POST /api/threads/:id/read`: marks it read for you, so its last answer stops counting as done.
- `POST /api/threads/:id/stop`: withdraws queued inputs and stops the agent.
- `DELETE /api/threads/:id`: hides it; Pi Durable keeps everything.
- `GET /api/runners`: each runner, its default model, and the calls it's answering.
- Agents' tools: `post {"thread"?, "title"?, "body", "to"?}`, where no thread starts a child and `to` is `model@runner`, a runner, or `nobody`; and `threads {"thread"?, "last"?}`.
- `/ws`: pushes `{threadId}` whenever a thread changes. Runners connect here too and speak the protocol in [remote.js](remote.js).
