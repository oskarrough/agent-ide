# agent-ide

agent-ide is yet another chat app for working with agents.

Threads live on a server you own, and agents run on your own machines, in folders you choose. Built on [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable), so a restart or crash loses nothing.

So, what's different about this one? Not much, but it adds patterns I've found to prove themselves useful enough to write here:

Bots aka agents with a name, instructions and a hands-off home thread. Agents and bots can message each other. Bots remember long threads as short summary lines they can zoom back into. Threads are multiplayer and group chats as well, invite your bots.

## Try it

You need Node.js 24+ and [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) logged in: run `pi` and `/login` once with any provider. Then, in the folder you want agents to work in:

```sh
npx github:oskarrough/agent-ide
```

Open the server's URL for a walkthrough and the chat app. That's it.

## Another machine

The other machine needs to reach the server. To let it connect over your network, start the server with:

```sh
HOST=0.0.0.0 npx github:oskarrough/agent-ide
```

Click "Add runner" on the page, or run this on the server's machine:

```sh
npx github:oskarrough/agent-ide key laptop
```

Either gives you a command to run on the other machine, in the folder agents should work in. Keep it private: it holds the runner's key.

There are no accounts: anyone who can reach the server can read, post as anyone, and put its runners to work. Keep it on a trusted network. To use [Tailscale](https://tailscale.com) instead:

```sh
npx github:oskarrough/agent-ide
tailscale serve 3000
```

Open `https://<your-machine>.<your-tailnet>.ts.net` on the other machine or your phone.

## Settings

Settings live in `agent-ide.json` in the folder you start in. For example, to turn web search on and talk off:

```json
{
	"modules": ["+web-search", "-talk"]
}
```

Use `+` and `-` to change the defaults; a list of bare names replaces them.

The server's address, working folder and data path are set in the environment, not the file:

```sh
HOST=0.0.0.0 npx github:oskarrough/agent-ide  # open the printed address on your phone or another machine
PORT=3001 npx github:oskarrough/agent-ide     # a fixed port; otherwise the first free one from 3000
RUNNER=~/code npx github:oskarrough/agent-ide # agents work here instead of the folder you start in
RUNNER=0 npx github:oskarrough/agent-ide      # don't connect this machine as a runner
DB_PATH=other.sqlite npx github:oskarrough/agent-ide
```

These win over the file; leave them unset to choose from the page.

```sh
MODULES=+web-search,-talk npx github:oskarrough/agent-ide
MEMORY_MODEL=sonnet@laptop npx github:oskarrough/agent-ide
```

From a clone, use `node server.js` in place of `npx github:oskarrough/agent-ide`.

Threads and conversations live in `agent-ide.sqlite` in the folder you start in, with the server's output in `agent-ide.log` beside it. `DB_PATH` moves both: `other.sqlite` logs to `other.log`.

## Modules

Everything is a module that you can turn on and off.

On by default: talk, status, context, bots, director, memory and auto-title.  
Off: web-search, matrix and pi-sessions.

- **talk** gives agents `post` and `threads`, to ask other threads and read them. A thread answers the thread that started it on its own; anywhere else, an agent answers with `post`.
- **memory** summarizes messages so agents can keep working in long threads. It's used by default in threads with bots; you can switch it on or off for any thread.
- **director** asks the bots a message @mentions, one after another. It can also pick who answers when nobody's named.
- **bots** lets you create named bots and give them instructions and a colour. A bot without a picked colour (`color`, a hue) gets one from the order bots were made.
- **context** hands agents the AGENTS.md and skills in their folder, and the folder itself, the way pi does.
- **status** shows what agents are doing on a runner's terminal.
- **auto-title** turns a thread's first message into a short title once it's answered. `POST /api/threads/:id/auto-title` writes a new one whenever you ask and answers with it, or with why it couldn't; a rename in the meantime wins.
- **web-search** gives agents a `web_search` tool.
- **matrix** makes Matrix rooms into threads.
- **pi-sessions** moves threads to and from pi. Each agent's conversation is written as a pi session file on its runner, in the folder where pi keeps sessions for the agent's folder (`PI_CODING_AGENT_SESSION_DIR`, or `~/.pi/agent/sessions/`), so `pi --resume` there lists it and carries on. A file only grows, as the conversation does; a runner that was offline writes what it missed when it's back, and a read-only runner writes nothing. A fork gets a file of its own once someone writes in it. The other way, `node cli.js import <runner>` lists the pi sessions in the runner's folder and `import <runner> <session>` starts a new thread from one (`GET` and `POST /api/pi-sessions`): its active branch is copied, its last model and thinking become the thread's agent, and the thread says which file it came from. Nothing syncs: whatever you add to a file in pi never reaches agent-ide, and importing a session again after more work in pi makes another thread. Runners with an owner aren't listed, since the request doesn't say who asks.

For each module's settings, see the top of its file in [modules/](modules). A module there with `export const on = true` is on by default; a new file there is a new module.

## What's what

- **Server**: the one process you start. It keeps every thread and every agent's conversation in one SQLite file.
- **Runner**: connects a machine to the server, offering its folders and the model logins pi has there. Agents reach nothing outside those folders. The server holds no logins.
- **Agent**: a model, how hard it thinks, and the runner it works on, written `sonnet:high@laptop`. Every part is optional; `laptop` alone is that runner's default model. Each thread has one. Change its model or runner whenever you like and it keeps the conversation. It has no name.
- **Thread**: what people, one agent and any bots write to each other. _Hands off_ prevents its agents from editing files or running commands.
- **Bot**: one name in many threads, with a home thread, the agent it joins as, and instructions. Only bots have names.
- **Conversation**: what one agent has read, its tool calls and its answers.
- **Client**: the web page, the CLI or a Matrix room you use to read and write in threads; the server keeps the data.
- **Module**: a feature you can switch on or off. Each module file's first lines say what it does and how to set it.

## The API

Everything the page does, you can do with a few requests. Say who you are with `x-user`:

```sh
api() { curl -s -H 'x-user: oskar' -H 'content-type: application/json' "localhost:3000/api/$1" ${2:+-d "$2"}; }

api threads '{"title": "hello"}' # → {"id": 3}
api threads/3/entries '{"body": "what machine is this?", "to": "sonnet@laptop"}'
api threads/3 # the thread and its messages so far
api threads/3/entries '{"body": "and now?", "to": "opus:high@laptop"}' # same agent, new model
api threads/3/fork '{"at": 5}' # a new thread from message 5
api threads/3/stop '{}'
```

A message's `to` says whom it asks: an agent like `sonnet@laptop`, a bot's name, or `null` for nobody. Leave it out and it asks whoever the thread asked last. A body starting with `$ ` runs that command on the runner instead.

To watch a thread live, open `/ws` and send `{"watch": 3}`. You get new messages and each agent's work as it happens; a bare `{}` means "fetch the list again".

```
GET    /api/server                     modules, settings, whether you may add runners
GET    /api/runners
POST   /api/runners {name}             a key, and the command that connects it
DELETE /api/runners/:name
GET    /api/threads
POST   /api/threads {title, parent?, tools?}
GET    /api/threads/:id
GET    /api/threads/archived
POST   /api/threads/:id/archive {archived}
POST   /api/threads/:id/entries {body, to?, images?, steer?}
POST   /api/threads/:id/fork {at, title?}
POST   /api/threads/:id/title {title}
POST   /api/threads/:id/tools {tools}  as pi --tools takes them
POST   /api/threads/:id/read
POST   /api/threads/:id/stop
POST   /api/threads/:id/compact
GET    /api/conversations/:id          an agent's own conversation, tool calls and all
```

Modules add their own routes under `/api/<module>`. The routes are in `server.js`, the runner protocol in [remote.js](remote.js).

The CLI is the same API from a terminal:

```sh
node cli.js post "hello" --to sonnet@laptop    # prints the answer as it lands
node cli.js threads
node cli.js read 3
node cli.js wait 3                             # waits for its agents, then prints the answers
node cli.js stop 3
```

Run from an agent's own shell, `post` writes as that agent (its model and thinking, like `sonnet:high`), whatever its model; anywhere else it writes as you.

A new thread prints `thread N` on stdout, followed by any answers; progress and errors go to stderr. To capture just its id without waiting:

```sh
thread=$(node cli.js post "hello" --to sonnet@laptop --no-wait)
node cli.js wait "${thread#thread }"
```

`node cli.js --help` has the rest.
