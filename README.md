# agent-ide

Threads live on servers. Replies come from runners. No dependencies or build step. Runs with bun (or Node.js 24+).

```
client.html ──▶ server.js (threads, messages, which runners are online)
                   ▲
                   └── runner.js dials out; replies in threads placed on it using claude, codex, pi or echo
```

## Server

```sh
bun server.js                              # http://127.0.0.1:3000
HOST=0.0.0.0 PORT=3001 bun server.js       # reachable from other machines; prints every address
```

Each server has its own SQLite file (`DB_PATH`, default `threads.db`), threads, and runners. Nothing crosses between servers.

## Client

`bun client.html` serves it with live reload. Any server also serves it at `/`, and then adds itself. Add one or more server URLs; they are kept in localStorage. Add `?user=ana` to the URL to post as someone else. The server has no authentication, so use it on a trusted network.

## Runner

```sh
bun runner.js --server http://127.0.0.1:3000 --name oskar-laptop --dir ~/code/foo [--owner oskar]
```

A runner connects to one server, reports the harnesses it finds (`claude`, `codex`, `pi`, plus a built-in `echo`) and waits. It never decides when to act; it does the `reply` and `exec` jobs the server hands it, in a folder under `--dir`. It belongs to `--owner` (default: the OS user), and only the owner or people they allow can send it work. The server checks that; the runner doesn't.

## Policy lives in callers

Everything below uses only the public API, so each is swappable.

- `director.js --server URL [--bot codex=laptop:codex --bot claude=box:claude:haiku]` replies when a human posts: an @mention picks the bot, otherwise bots take turns. Without `--bot` it uses the thread's default runner and harness. Stop it and threads stay silent.
- `delegate.js --server URL --parent T --runner laptop --harness codex --dir proj "task"` is a coding run: a child thread, a `reply` there, one line back in the parent.

## API

Send `x-user: name` to say who you are (fake identity).

- `GET /api/threads`, `POST /api/threads` `{"title","parent"?}`
- `POST /api/threads/:id` `{"runner","harness","model"}` sets the thread's defaults
- `GET /api/threads/:id/events`, `POST /api/threads/:id/events` `{"author","kind":"human|bot","body"}`
- `POST /api/threads/:id/reply` `{"bot","runner","harness"?,"model"?,"dir"?}` makes the runner reply as the bot; answers with the entry
- `POST /api/threads/:id/exec` `{"runner","command","dir"?}` runs a command; the output lands in the thread as an `exec` entry
- `GET /api/runners`, `POST /api/runners/:name/allow` `{"user","allowed"?}` (owner only)
- `/ws` sends `{threadId}` change notifications. Runners connect with `/ws?runner=NAME&owner=…&harnesses=…`, receive `{job}` and answer at `POST /api/jobs/:id`.

A runner that is offline, unknown or not lent to you fails fast, with a note in the thread. A runner that drops mid-job leaves a note too; if it reconnects and finishes, the late answer still lands.
