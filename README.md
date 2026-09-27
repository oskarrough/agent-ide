# agent-ide

Threads live on servers. Replies come from runners. No dependencies or build step. Runs with bun (or Node.js 24+).

```
client.html ──▶ server.js (threads, bots, which runners are online)
                   ▲
                   └── runner.js dials out; does the reply and exec jobs it is handed, using claude, codex, pi or echo
```

A thread is a conversation between humans and bots, and it lives nowhere. A bot is a name and a soul, plus the runner, coding agent CLI (`cli`) and folder its replies come from, so one thread can hold bots from several machines. A job is a child thread pinned to a runner, cli and folder; everything said there runs there, so steering a job is just posting in it.

## Server

```sh
bun server.js                              # http://127.0.0.1:3000
HOST=0.0.0.0 PORT=3001 bun server.js       # reachable from other machines; prints every address
```

Each server has its own SQLite file (`DB_PATH`, default `threads-PORT.db`), threads, and runners. Nothing crosses between servers, and two can't share a file.

## Client

`bun client.html` serves it with live reload. Any server also serves it at `/`, and then adds itself. Add one or more server URLs; they are kept in localStorage, each with an optional alias that only this client sees. Add `?user=ana` to the URL to post as someone else. The server has no authentication, so use it on a trusted network.

The sidebar shows each server's runners (whose, which clis, who they're lent to), bots (where they live) and threads (jobs and who is working). Bots are server-wide, so you add them in the sidebar: a name, a soul, and the runner, cli, model and folder they work in. Their owner can edit them there too.

In a thread, the header lists who's in it, and Ask makes a bot reply, with no director needed. `@bot` in a message routes only while `director.js` runs. A plain thread can start a job: pick a bot and a task, and optionally another runner, cli or folder; the child thread is pinned there and the bot answers in it. A job's header shows its pin, and `$ command` runs there. In a plain thread, `$` is refused: it runs nowhere.

## Runner

```sh
bun runner.js --server http://127.0.0.1:3000 --name oskar-laptop [--alias "Oskar's laptop"] --dir ~/code/foo [--owner oskar]
```

A runner connects to one server, reports the coding agent CLIs it finds (`claude`, `codex`, `pi`, plus a built-in `echo`) and waits. It never decides when to act; it does the `reply` and `exec` jobs the server hands it, in a folder under `--dir`. The name is its key; `--alias` is a human-readable name the client shows instead, set on the machine so it survives a server restart. It belongs to `--owner` (default: the OS user), and only the owner or people they allow can send it work. The server checks that; the runner doesn't.

## Policy lives in callers

Everything below uses only the public API, so each is swappable.

- `director.js --server URL` replies when a human posts: every @mentioned bot answers, in order; otherwise the last bot to speak does. Stop it and threads stay silent.
- `delegate.js --server URL --parent T --bot coder [--runner laptop --cli codex --dir proj] "task"` is a coding run: a child thread pinned to where the bot works (or the overrides), and a `reply` from the bot there; the server posts the result to the parent. The client's Start job does the same.

## API

Send `x-user: name` to say who you are (fake identity).

- `GET /api/threads`, `POST /api/threads` `{"title","parent"?}`; add `"runner","cli"?,"model"?,"dir"?` to make it a job
- `GET /api/bots`, `POST /api/bots` `{"name","runner","cli"?,"model"?,"dir"?,"soul"?}`, `DELETE /api/bots/:name` (owner only); posting an existing name overwrites it (owner only)
- `GET /api/threads/:id/events`, `POST /api/threads/:id/events` `{"author","kind":"human|bot","body"}`
- `POST /api/threads/:id/reply` `{"bot","runner"?,"cli"?,"model"?,"dir"?}` makes a runner reply as the bot; answers with the entry. Fields you pass win, then the job's, then the bot's.
- `POST /api/threads/:id/exec` `{"command"}` runs a command on the job's runner, in its folder; the output lands in the thread as an `exec` entry. A thread that isn't a job answers 409.
- `GET /api/runners` (each with `name`, `alias`, `owner`, `clis`, `allowed`, `online`), `POST /api/runners/:name/allow` `{"user","allowed"?}` (owner only)
- `/ws` sends `{threadId}` change notifications. Runners connect with `/ws?runner=NAME&alias=…&owner=…&clis=…`, receive `{job}` and answer at `POST /api/jobs/:id`.

A runner that is unknown or not lent to you fails fast, with a note in the thread. An offline runner fails fast in a plain thread, where the conversation moves on without that bot. In a job thread the work waits instead: the thread says so, it starts when the runner reconnects, and whoever asked (or the runner's owner) can cancel it with `DELETE /api/jobs/:id`. Waiting work lives in memory, so a server restart drops it. A runner that drops mid-job leaves a note too; if it reconnects and finishes, the late answer still lands.

When a reply in a job thread finishes, the server posts a one-line result to the parent thread, so nobody has to stay connected for it.
