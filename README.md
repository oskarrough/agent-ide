# agent-ide

A small agent IDE on [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable), built to show how little it takes. One server keeps every thread. Runners on your machines lend it their model logins and a folder. Runs with bun or Node.js 24+, no build step.

What it promises, the words it uses, how it fits together, its principles and what's decided: [docs/concepts.html](docs/concepts.html), which every server also serves at `/concepts`. The code is the truth, and [examples/](examples) shows each idea working.

## Try it

In two terminals:

```sh
bun install
bun server.js
```

```sh
bun runner.js --name laptop --dir ~/code
```

On another machine, nothing to clone: `curl -fsSL http://yourbox:3000/runner.sh | sh -s -- --name desk --dir ~/code`.

Open http://127.0.0.1:3000 and:

1. Click **New thread**.
2. Pick `laptop` and the model `echo/echo`. Send `hello`. Echo answers at once, which proves the loop works.
3. Pick the default model, pi's own on that runner, and ask something real. Run `pi` and `/login` on the runner once if you haven't. **+ agent** asks a second one.
4. Send `$ ls` to run a command in the runner's folder.
5. Tick **Show structure** to see the JSON behind it all.

Or read [examples/](examples): one file per idea, each starting its own server and runner, checking what it claims. `bun run examples` runs them all, `bun examples/05-fork.js` one. Those named `real-model` use a real model through your pi login, so they only run on their own or with `REAL=1 bun run examples`.

## Running it

```sh
bun server.js                          # http://127.0.0.1:3000, stored in agent-ide-3000.sqlite
HOST=0.0.0.0 PORT=3001 bun server.js   # reachable from other machines
RUNNER=~/code bun server.js            # lends this machine too: its own runner, which stops with the server
TALK=0 STATUS=0 CONTEXT=0 bun server.js   # the core alone, without the modules on by default:
#   talk.js: agents' post and threads tools · status.js: runners report to their terminal
#   context.js: each agent gets its folder's AGENTS.md and skills, as pi reads them
DIRECTOR=1 bun server.js               # director.js asks the agents a message @mentions
MEMORY=1 MEMORY_MODEL=haiku@laptop bun server.js   # memory.js: threads that never end
SEARCH=1 bun server.js                 # search.js: agents' web_search, through Exa's free search
MATRIX=1 MATRIX_TOKEN=… MATRIX_ROOMS=… bun server.js   # matrix.js: Matrix rooms as threads; its top says how
bun scripts/replay-pi.js ~/.pi/agent/sessions/FOLDER   # pi sessions, or one .jsonl, as one long thread
DB_PATH=other.sqlite bun server.js     # another store; only one server may use a file

bun runner.js --server http://127.0.0.1:3000 --name laptop [--alias "Oskar's laptop"] --dir ~/code [--owner oskar [--allow ana --allow @desktop]] [--read-only]
curl -fsSL http://127.0.0.1:3000/runner.sh | sh -s -- [the same options] [--no-update]   # into ~/.agent-ide, kept up to date

bun cli.js send "hello" --to sonnet@laptop --to desk --effort high   # a new thread; answers print as they land
bun cli.js send "and you?" --thread 3                               # asks whom thread 3 last asked
bun cli.js threads | runners | read 3 [--last 5] | stop 3          # runner.js and cli.js both read AGENT_IDE_SERVER=url, or --server
```

The client is served at `/`, or by `bun client.html` with live reload; [cli.js](cli.js) is the same API from a terminal. It can hold several servers. `?user=ana` posts as someone else. There is no authentication: anyone who can reach the server can claim any name, so keep it on a trusted network.

## API

Send `x-user: name` to say who you are. The two POSTs that make something, a thread and an entry, take an optional `"requestId"` (a string of up to 128 characters, such as `crypto.randomUUID()`): send the same one again after a dropped response and you get the first result back, whatever else changed. A thread entry is Pi's own, `{id, kind: "agent-ide.message", data}`, and `data` is a message:

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
- `GET /api/threads/:id/memory?zoom=id,n`: with memory, the thread's memory as `{lines: [{id, n, text}]}`, or with `zoom` what a line was made from.
- `GET /api/conversations/:id`: any Pi conversation's view as Pi gives it, such as an agent's: its entries and docs.
- `GET /api/runners`: each runner, its `owner` and whom it `allow`s, its default model or `modelError` when pi's default doesn't resolve, the models it `offers` from pi's enabled models, the models it has resolved, and the calls it's answering.
- Agents' tools, with talk: `post {"thread"?, "title"?, "body", "to"?}`, where no thread starts a child and `to` is `model@runner`, a runner, or `nobody`; and `threads {"thread"?, "agent"?, "last"?, "query"?}`, where `agent` reads that agent's own work in the thread, its tool calls and what they printed; with memory, `zoom {"id","n","at"?}`, where a long message comes in pages from character `at`.
- `/ws`: pushes `{}` whenever something changes. Send `{"watch": threadId}` (or `null`) to watch one: `{thread, events}` for its conversation and `{thread, agent, events}` for each agent's, Pi's `watchEvents` stream, snapshot first. Runners connect here too and speak the protocol in [remote.js](remote.js).
