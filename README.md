# agent-ide

A small agent IDE on [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable), built to show how little it takes. One server keeps every thread. Runners on your machines lend it their model logins and a folder. Runs with bun or Node.js 24+, no build step.

What it promises, the words it uses, how it fits together, its principles and what's decided: [docs/concepts.html](docs/concepts.html), which every server also serves at `/concepts`. The code is the truth, and [examples/](examples) shows each idea working.

## Try it

```sh
npx github:oskarrough/agent-ide
```

It lends the folder it starts in to its agents, as a runner named after this machine. From a clone, `bun install && bun server.js` does the same. On another machine, nothing to clone: `bun cli.js key desk` on the server prints the line that connects it, `curl -fsSL http://yourbox:3000/connect-runner | AGENT_IDE_KEY=air_… sh -s -- --name desk --dir ~/code`.

Open http://127.0.0.1:3000 and:

1. Click **New thread**.
2. Pick this machine's runner and the model `echo/echo`. Send `hello`. Echo answers at once, which proves the loop works.
3. Pick the default model, pi's own on that runner, and ask something real. Run `pi` and `/login` on the runner once if you haven't. **+ agent** asks a second one.
4. Send `$ ls` to run a command in the runner's folder.
5. Tick **Show structure** to see the JSON behind it all.

Or read [examples/](examples): one file per idea, each starting its own server and runner, checking what it claims. `bun run examples` runs them all, `bun examples/05-fork.js` one. Those named `real-model` use a real model through your pi login, so they only run on their own or with `REAL=1 bun run examples`.

## Running it

```sh
bun server.js                          # http://127.0.0.1:3000, stored in agent-ide-3000.sqlite
HOST=0.0.0.0 PORT=3001 bun server.js   # reachable from other machines
RUNNER=~/code bun server.js            # lends this machine another folder than the one it starts in; RUNNER=0 lends none
MODULES=-talk,-status,-context bun server.js   # modules are picked as Pi picks tools: +name and -name change the defaults, names alone replace them, a path is a module of your own
MODULES=+director bun server.js        # director.js asks the agents a message @mentions by name, as @echo/echo@laptop or @reviewer
MODULES=+memory MEMORY_MODEL=haiku@laptop bun server.js   # memory.js: threads that never end
MODULES=+search bun server.js          # search.js: agents' web_search, through Exa's free search
MODULES=+matrix MATRIX_TOKEN=… MATRIX_ROOMS=… bun server.js   # matrix.js: Matrix rooms as threads; its top says how
MODULES=+bots bun server.js            # bots.js: one name in many threads, made from its home thread's agent
echo '{"modules": ["+memory", "+../mine.js"]}' > agent-ide.json   # the same, in the folder it starts in; MODULES then changes what the file picked
bun scripts/replay-pi.js ~/.pi/agent/sessions/FOLDER   # pi sessions, or one .jsonl, as one long thread
DB_PATH=other.sqlite bun server.js     # another store; only one server may use a file

bun cli.js key laptop                  # a new key for runner laptop, replacing its old one, and the lines that connect it
bun cli.js revoke laptop               # takes its key away: it goes offline and stays out
AGENT_IDE_KEY=air_… bun runner.js --server http://127.0.0.1:3000 --name laptop [--alias "Oskar's laptop"] --dir ~/code [--owner oskar [--allow ana --allow @desktop]] [--read-only]
curl -fsSL http://127.0.0.1:3000/connect-runner | AGENT_IDE_KEY=air_… sh -s -- [the same options] [--no-update]   # into ~/.agent-ide, kept up to date; the key goes in ~/.config/agent-ide/key

bun cli.js post "hello" --to sonnet@laptop --to desk --thinkingLevel high   # a new thread; answers print as they land
bun cli.js post "and you?" --thread 3                               # asks whom thread 3 last asked
bun cli.js threads | runners | read 3 [--last 5] | stop 3 | retry 3         # runner.js and cli.js both read AGENT_IDE_SERVER=url, or --server
```

The client is served at `/`, or by `bun apps/client/client.html` with live reload and `?server=http://…` pointing at a server; [cli.js](cli.js) is the same API from a terminal. `?user=ana` posts as someone else. [apps/matrix-sync](apps/matrix-sync) files GitHub issues from a Matrix mention, without anyone opening the IDE. A runner needs its key to connect, so nobody can take its name, and a revoked one stays out. People have no keys yet: anyone who can reach the server can claim any name, and mint a key, so keep it on a trusted network.

## API

Send `x-user: name` to say who you are. The two POSTs that make something, a thread and an entry, take an optional `"requestId"` (a string of up to 128 characters, such as `crypto.randomUUID()`): send the same one again after a dropped response and you get the first result back, whatever else changed. A thread entry is Pi's own, `{id, kind: "agent-ide.message", data}`, and `data` is a message:

```
{ author, body, to?: [{runner, model, thinkingLevel?, dir?}], from?: threadId, re?: [entryId],
  answer?: {conversation, entry}, error?: true, shell?: {runner, code, stdout, stderr} }
```

- `GET /api/server`: the server's options, its modules, and what Pi is running.
- `GET|POST /api/threads` `{"title","parent"?,"tools"?,"requestId"?}`: each thread with its agents, status, running commands and Pi conversation record.
- `GET /api/threads/:id`: the thread's row, its `agents` as `{name, conversation, to, status}`, the `people` who wrote or read there, and every entry.
- `POST /api/threads/:id/entries` `{"body","to"?: agent | [agent] | null, "steer"?: true, "requestId"?}`, an agent being `{"runner","model"?,"thinkingLevel"?,"dir"?,"name"?}` and its model anything `pi --model` takes, or an agent's name as a string: a steer joins the answer being written. An agent's name in the thread is its `name`, else `model@runner`; a recipe makes the agent once, and after that its name reaches it as it was made. A message stores the names it asks. A runner that doesn't take work from you answers 403.
- `POST /api/threads/:id/tools` `{"tools"}`: the tools of every agent in the thread, as `pi --tools` takes them: names enable exactly those, `-name` and `+name` change the default, every tool; `null` is the default. `["-write","-edit","-bash"]` makes a thread hands off: its agents read and ask others, whose child threads do the work. A fork keeps them, a child doesn't.
- `POST /api/threads/:id/fork` `{"at": entryId, "title"?}`: a new thread from that entry.
- `POST /api/threads/:id/read`: marks it read for you, so its last answer stops counting as done.
- `POST /api/threads/:id/stop`: stops its agents, deliveries and commands, and withdraws their queued inputs.
- `POST /api/threads/:id/retry`: runs again the deliveries and commands that crashes left parked: a thread whose `status` is `parked`, whose work crashes cut off five times in a row.
- `DELETE /api/threads/:id`: hides it; Pi Durable keeps everything.
- `POST /api/threads/:id/bots` `{"name","instructions"?}`: with bots, this thread is the bot's home, and the bot's instructions are these. Asked by name in another thread, an agent of that name joins there, made from the home agent's recipe; `name=model@runner` gives it another model. Every agent of that name reads the instructions before each request and is told its other threads. `GET` lists the bots.
- `GET /api/threads/:id/memory?zoom=id,n&budget=bytes`: with memory, the thread's memory as `{lines: [{id, n, text}]}`, the lines an agent with `budget` bytes of room reads, or with `zoom` what a line was made from.
- `GET /api/conversations/:id`: any Pi conversation's view as Pi gives it, such as an agent's: its entries and docs.
- `GET /api/runners`: each runner, its `owner` and whom it `allow`s, its default model or `modelError` when pi's default doesn't resolve, the models it `offers` from pi's enabled models, the models it has resolved, and the calls it's answering.
- Agents' tools, with talk: `post {"thread"?, "title"?, "body", "to"?}`, where no thread starts a child and `to` is an agent's name, `thread/name`, `model@runner` or `name=model@runner`, a runner, or `nobody`; and `threads {"thread"?, "agent"?, "last"?, "query"?}`, where `agent` reads that agent's own work in the thread, its tool calls and what they printed; with memory, `zoom {"id","n","at"?}`, where a long message comes in pages from character `at`.
- `/ws`: pushes `{}` whenever something changes. Send `{"watch": threadId}` (or `null`) to watch one: `{thread, events}` for its conversation and `{thread, agent, events}` for each agent's, Pi's `watchEvents` stream, snapshot first. Runners connect here too and speak the protocol in [remote.js](remote.js).
