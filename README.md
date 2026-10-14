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

Or read [examples/](examples): one file per idea, each starting its own server and runner, checking what it claims. `bun run examples` runs them all, `bun examples/05-fork.js` one. Those named `real-model` use a real model through your pi login, so they only run on their own or with `REAL=1 bun run examples`.

## The machine

```
client.html ──▶ server.js   one Pi Durable harness: threads, and each agent's conversation in them
                   ▲  model streams, file and shell calls
                   └── runner.js   on your machine: its pi logins, its folder
```

1. The server keeps everything in one Pi Durable harness over one SQLite file: each thread is a Pi conversation, and what agent-ide adds, like a title, a parent, read markers and its agents, is a Pi doc beside it.
2. A runner is a process on someone's machine that connects to the server's WebSocket and lends it its pi logins and a folder; it stores nothing.
3. The server registers each runner as a Pi model provider, `runner:NAME`, whose streams run on the runner, and as the execution environment of every conversation whose model is on it: Pi's whole `ExecutionEnv`, called over the socket and working in the runner's folder.
4. Calls to an offline runner wait for it.
5. An agent is a model on a runner, named `provider/id@runner`.
6. The runner resolves the model the way `pi --model` does, with pi's own resolver, settings and logins: a pattern, a `:thinking` suffix, or nothing for pi's default.
7. The server keeps each model a runner resolved, without credentials, and an offline runner takes only those.
8. A runner also tells the server, each time it connects, the models pi has enabled there, expanded as `pi --models` does, which the client suggests and which are not resolved until asked.
9. `echo/echo` is pi-ai's faux provider, for testing: it answers `echo@RUNNER heard: ` and the last user text.
10. A thread never runs: every entry in it is a passive message with its `author` and `body`, and `to`, `from`, `re`, `answer`, `error` or `shell` when it has them, or, with memory, a line.
11. Each agent in a thread answers from its own Pi conversation, made the first time it is asked there and owned by an Anchor task in the thread.
12. The thread's doc maps the agent's name to that conversation, and a doc on the conversation names its thread, the agent's name there, and the messages it hasn't been given.
13. Having no thread doc, an agent's conversation never shows up as a thread.
14. Every message in a thread is unseen by each of its agents but its own: those with its name and no `from`.
15. A new agent hasn't seen anything.
16. Posting a message is one Pi commit that appends it and creates a Deliver task for each agent its `to` asks, holding all that agent's unseen messages.
17. No `to` asks whom the thread last asked; `to: null` asks nobody.
18. A Deliver task waits for its runner, then submits its messages as one input to the agent's conversation, an `agent-ide.delivery` entry whose `held` names them, each written as `author: body`, or `author, writing from thread N: body` (`answering` for a message with `re`) when it came from another thread.
19. The request id is made from the Deliver task's id, so a rerun finds the input it made.
20. When the input settles, the commit that ends the task copies the agent's final answer into the thread with `re`, the messages it held that asked the agent, and `answer`, the entry it came from.
21. Several inputs can share one answer, and the first speaks for all.
22. An input with no answer posts an `error` message instead.
23. A child thread reports each answer or error to its parent as a message with `from`.
24. Other agents never see an agent's tool calls.
25. A stopped input posts and reports nothing.
26. If a stopped input was withdrawn before Pi placed it, its messages are unseen again, for the next delivery.
27. `$ cmd` creates a Shell task for the first agent's runner.
28. A Shell task commits that it began, runs in the runner's folder, then posts what it printed.
29. A stopped Shell task posts what it printed by then.
30. A Shell task a restart cut short posts that it was interrupted.
31. Pi resumes unfinished tasks after a restart, and every write a task makes lands in the commit that ends it or moves it on, so nothing repeats.
32. Several agents can work in one thread at once.
33. An agent is working while a delivery to it is live.
34. Stopping a thread is Pi's abort of its conversation, which reaches its tasks and, through each Anchor, its agents' runs and queued inputs.
35. A fork is Pi's own fork of the thread at an entry, plus a fork of each agent's conversation at its last answer up to there, all in one commit.
36. The forked agent's unseen messages are those up to there that none of its inputs placed by that answer held.
37. An agent asked up to there with no answer yet gets a new conversation in the fork, in the same commit, having seen nothing.
38. A fork reports nowhere.
39. A thread's status for a reader is one of the [Program Status Protocol](https://www.superlogical.com/rex/docs/build/program-status)'s five words: working, or blocked when its working agents' runners are offline, from its live tasks; done or error for a result newer than the reader's read marker; otherwise idle.
40. Optional behaviour lives in modules, one file each, switched by an env var of its name.
41. [talk.js](talk.js) (on, `TALK=0`) gives agents `post` and `threads` tools, and `threads` with a `query` finds the messages of a thread, their own by default, that contain it.
42. [status.js](status.js) (on, `STATUS=0`) has runners report to their terminal with OSC 7501, a record for the runner and one per thread by its id.
43. [director.js](director.js) (`DIRECTOR=1`) has a message ask the agents it @mentions.
44. [memory.js](memory.js) (`MEMORY=1`, with `MEMORY_MODEL=model@runner`) gives each thread a memory.
45. [matrix.js](matrix.js) (`MATRIX=1`, with `MATRIX_TOKEN` and `MATRIX_ROOMS`, and optionally `MATRIX_USERS`, `MATRIX_AGENT=model@runner`, `MATRIX_JOB` and `MATRIX_HOMESERVER`, matrix.org's by default) mirrors Matrix rooms into threads, where without `MATRIX_USERS` nothing from Matrix asks anyone; its top says how to set it up.
46. With talk, an agent's `post` is one commit, keyed by its tool call so a replay finds it.
47. When an agent answers posts from another thread, the answer goes back to that thread instead of a report, as a message with `from` and `re`.
48. That answer asks every agent who posted, and steers into their work if they're busy.
49. A reply to that answer sends nothing back, so the exchange ends there, like email.
50. With memory, each message in a thread gets a line: itself when it fits in 512 bytes, or else written by `MEMORY_MODEL` from its text and the thread's memory before it, asked again up to five times while over 512 bytes, the shortest it wrote kept.
51. A line request that fails for a rate limit or a dropped connection waits and tries again, by pi-ai's `retryAssistantCall`.
52. Neighbouring lines merge in pairs up a binary tree, a pair that fits being its own line.
53. Each line is an `agent-ide.line` entry `{l, i, text, size}` in the thread, written once by a background Line task that the post's commit creates, so stopping a thread never cuts its memory short.
54. A fork reads its source's lines through for ranges that end before the fork point.
55. When Pi compacts an agent's conversation, memory writes Pi's summary instead of the agent's model: the thread's lines up to the last message the agent was given before the cut.
56. That memory merges the most due pair first, `(T - last) / 2^l`, into their line, pairs whose line is built before those whose line is not, until it fits in the agent's budget, as many bytes as its model has tokens of context, and writes each line `id+n|text`, `id` being the position of its first message and `n` how many it covers.
57. A message or pair whose line is not built yet shows there as `(not summarized yet: zoom it)`.
58. With memory, a Deliver task's input holds its newest messages whole up to the agent's budget, at least the last, and the older ones as the thread's memory over their range, also within it.
59. With memory, an agent has `zoom {id, n}`, which opens a line into the two it was made from, or into the message whole when `n` is 1.
60. A prompt section tells it the lines are its memory, and to zoom before it guesses.
61. With matrix, every text message in `MATRIX_ROOMS` is posted once into each thread it belongs to, as its sender: a top-level one into the thread kept for its room, and one in a Matrix thread into the thread kept for that, which opens with `MATRIX_JOB`, the room's thread id and the Matrix thread's first message.
62. A message from one of `MATRIX_USERS` that mentions the bot by name, or by `m.mentions`, asks `MATRIX_AGENT` if set, waiting for its runner if it never connected; a top-level one asks nobody in its room's thread and starts a Matrix thread under itself, where it asks and the answer goes.
63. Their other messages ask whom their thread last asked, and anyone else's ask nobody; everything from Matrix posts as a steer, and nothing unfollows a thread.
64. What the bridge itself sent and edits are skipped, and what comes in loses its terminal escapes and bidi overrides.
65. Each message is posted in a commit that notes its event, after a commit of its own that opens its thread, and the sync's position lands last, so a restart neither drops nor repeats one.
66. The first sync only takes its position, so nothing said before the bridge asks anyone.
67. A sync that Matrix cut short is paged back to the last position first, and one silent for 40 seconds is asked again.
68. An agent's answer or error in a thread kept for a room or a Matrix thread goes back there by a background MatrixSend task the post's commit creates, under a transaction id made from its entry and a salt the store keeps, so the homeserver drops a resend; a fork belongs to no room, so it sends nothing.
69. A MatrixSend waits, by Pi's task wait, until the room's send before it is done, and as long as a rate limit asks, so a room's answers land in the order they were written, even across a restart.
70. Nothing from Matrix asks in a room's thread until someone asks there from the client; then that agent hears the whole room (rule 15) and follows it (63), so do that with memory on.
71. [examples/](examples) defines the rest and checks all of it: the HTTP API, the runner end's interface (`serveRunner` in [remote.js](remote.js)), and each sentence above.

## What it promises

1. **Threads with many authors.** Humans and agents talk in one thread, and each agent answers from its own conversation.
2. **Runners.** Tool calls run on a machine you choose, in a folder you choose, with that machine's logins.
3. **Models of your choice.** Any model pi can name, named the way pi names it.
4. **Stable messaging.** A message between threads arrives once and its answer comes back once, even across restarts and stops.
5. **Forks.** Fork a thread at any entry, with each agent in it, to try another path from the same point.
6. **Memory** (under exploration). A thread never has to end, and anything said in it can be found again, word for word.

## Running it

```sh
bun server.js                          # http://127.0.0.1:3000, stored in agent-ide-3000.sqlite
HOST=0.0.0.0 PORT=3001 bun server.js   # reachable from other machines
DIRECTOR=1 bun server.js               # multiplayer
TALK=0 STATUS=0 bun server.js          # the core alone
MEMORY=1 MEMORY_MODEL=haiku@laptop bun server.js   # threads that never end
MATRIX=1 MATRIX_TOKEN=… MATRIX_ROOMS=… bun server.js   # Matrix rooms as threads; see matrix.js and apps/matrix-sync
bun scripts/replay-pi.js ~/.pi/agent/sessions/FOLDER   # pi sessions, or one .jsonl, as one long thread
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
- `POST /api/threads/:id/entries` `{"body","to"?: agent | [agent] | null, "steer"?: true}`, an agent being `{"runner","model"?,"effort"?,"dir"?}` and its model anything `pi --model` takes: a steer joins the answer being written.
- `POST /api/threads/:id/fork` `{"at": entryId, "title"?}`: a new thread from that entry.
- `POST /api/threads/:id/read`: marks it read for you, so its last answer stops counting as done.
- `POST /api/threads/:id/stop`: stops its agents, deliveries and commands, and withdraws their queued inputs.
- `DELETE /api/threads/:id`: hides it; Pi Durable keeps everything.
- `GET /api/threads/:id/memory?zoom=id,n`: with memory, the thread's memory within 64 KB as `{lines: [{id, n, text}]}`, or with `zoom` the two lines that line was made from, or `{message}` whole when `n` is 1; the client shows it as a panel.
- `GET /api/conversations/:id`: any Pi conversation's view as Pi gives it, such as an agent's: its entries and docs.
- `GET /api/runners`: each runner, its default model, the models it `offers` from pi's enabled models, the models it has resolved, and the calls it's answering.
- Agents' tools, with talk: `post {"thread"?, "title"?, "body", "to"?}`, where no thread starts a child and `to` is `model@runner`, a runner, or `nobody`; and `threads {"thread"?, "last"?, "query"?}`; with memory, `zoom {"id","n"}`.
- `/ws`: pushes `{threadId}` whenever a thread changes. Runners connect here too and speak the protocol in [remote.js](remote.js).
