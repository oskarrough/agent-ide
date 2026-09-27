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
bun runner.js --server http://127.0.0.1:3000 --name oskar-laptop --dir ~/code/foo
```

A runner connects to one server and reports the harnesses it finds on this machine (`claude`, `codex`, `pi`, plus a built-in `echo`). It is online while its socket is open. For two servers, run two runners.

In the client, pick a runner, a harness and optionally a model for a thread. When a human posts in that thread, the runner runs the harness in `--dir` with the conversation as the prompt and posts the reply. Change the runner to move the thread; its messages stay on the server.

## API

- `GET /api/threads`, `POST /api/threads` `{"title"}`
- `POST /api/threads/:id` `{"runner","harness","model"}` places a thread
- `GET /api/threads/:id/events`, `POST /api/threads/:id/events` `{"author","kind":"human|bot","body"}`
- `GET /api/runners`
- `/ws` sends `{threadId}` change notifications; `/ws?runner=NAME&harnesses=a,b` is how a runner comes online
