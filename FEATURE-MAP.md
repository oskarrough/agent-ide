# Feature map

Where things live, so you open the right file first. The README says what each thing is; this says where it is.

```
bin.js                   installed executable: dispatches to server, CLI commands, or runner
server.js                the server: Pi Durable store, tasks, HTTP API, /ws, runners, settings
  Thread, Runners, Keys, Receipts   the docs it keeps (defineDoc)
  Anchor, Admit, Deliver, Shell     the tasks: own an agent, take a message in, hand it over, run `$ cmd`
  address, whom, modelOn, reach     whom a `to` asks, on which runner and model
  recipients                       director → explicit recipient → last-asked choice
  post, append, postEntry           write a message and hand it to each agent it asks
  reconfigure, newAgent, setUp      an agent switching model/thinking/runner/folder in place, or starting
  outcome, tell, restore, faulted   what a finished delivery posts back (a bot's answer asks whom direct says), or a failure says
  work, status, busiest, agentsIn   working / blocked / idle for agents, threads, runners
  threadList, threadRow, threadView, people   what GET /api/threads returns
  forkThread, seenBy                forks
  compact, compactingAt             compaction now, or early
  setTitle, setTitleIn, setTools, toolList, toolsOf   a thread's title and tools
  receipt, once                     a retried request does its work once
  routes                            every HTTP route, as the README lists them
  watch, rewatch, told, doing       /ws: a browser watching one thread and its agents' live work
  mintKey, revoke, upgrade          runner keys and the runner's socket
  saveSettings, restart, connectSelf   settings, restart, the server lending its own machine
runner.js                a runner: offers its models and folders, connects, runs agents for the server
runner-updater.js        what `curl <server>/connect-runner | sh` starts; keeps the runner up to date
remote.js                the runner protocol, both ends: createRunners (server), serveRunner (runner),
                         runnerProvider (a model over the wire), remoteEnv (tools in the runner's folder)
cli.js                   the API from a terminal
util.js                  helpers server and modules share: agentTo, writtenTo, mentioned, keyOf, speaker, said,
                         finished (task result), background (thread-owned task)
modules.js               builtIn (each module's own `on` default), agent-ide.json, MODULES, and loading each module's server/runner half
modules/
  talk.js                `post` and `threads` tools; reply sends answers back to the parent thread that asked; a bot in the
                         thread it posts to speaks there as itself (member), and so does a bot that
                         starts a thread for two or more bots (opener in server.js's post)
  auto-title.js          first-answer title generation (AutoTitle; the model sees the opening and the newest messages, `recent`), sanitizeThreadTitle, one attempt per thread; serve: a new title on request
  memory.js              memory lines (Line task), `zoom`, catch-up and compaction cut, each thread's switch (remembers, turn); render, memory
  bots.js                bots: their doc, `bot` tool, /api/bots (serve, change, remove)
  context.js             AGENTS.md, skills and the folder's path (cwd) from the runner; listed skills stay readable outside it
  director.js            the `direct` hook: @mentions ask that bot, with picks a model picks bots or nobody (decide);
                         those asked take turns (`turns`); a bot's answer @mentioning a bot asks it, resting
                         after three bot answers in a row (botTurns); tells bots to @mention, not post (section)
  web-search.js          `web_search`
  status.js              Program Status Protocol (OSC 7501) on the runner's terminal
  matrix.js              Matrix rooms as threads (MatrixSend, relay, sync)
  pi-sessions.js         conversations as pi session files: server follows each agent's conversation (push, sync, changed) and sends
                         new entries; writePiSession, the runner's `pi-session` op (remote.js serveRunner), maps them to pi's entries.
                         The other way: bring (a session's active branch into a new thread: post, newAgent, setUp), serve
                         (`/api/pi-sessions`), listPiSessions and readPiSession (the runner's `pi-session-list` and `-read`)
apps/client/             the web client, Solid 2, no build (README.md there)
  client.html            the walkthrough and the app's page; the promises every change serves
  client.js              root: just the chat, or the live system around it
  server.js              the server as the client sees it: api, watch, lists (threads, runners, bots),
                         current, openThread, fork, entries store
  thread.js              one thread on screen
    Thread               subscribes to the thread over /ws, keeps its messages, follows the bottom (follow)
    rows                 projection: messages plus each agent's turns, which run sits in which ask box,
                         live turn, compaction cuts, folded memory lines
    Asked                in a bot's home, a question another thread asked it, a received `Cross` row that opens to the question and its answer (askedHere)
    Message              one message: author, the director's pick, fork link, Body, Images; one that crossed threads is a `Cross` step row
  run.js                 an agent's turns, from its own conversation
    heard, conversations the conversation entries the socket brings
    turnsOf, cutsOf      a conversation cut into turns, and where its newest compaction cut it
    summary              a closed turn's one line ("edited 2 files · 1 command")
    Exchange             an ask's own line in the asking thread; opened, question and answer as messages
    answersIn, answerOf  a post step's answer from the thread it asked
    Turn, Step, Call, Told, Ask   a turn's line, opened into steps; Ask is the post step
    handedStep, light, litIn   the handed step as a count (none for the one message above); opened, it lights those messages
  composer.js            the box you type in
    pick, agent, askedBots, recipients   whom the next message asks, per thread
    mention, pickMention, mentionsFor   typing @ lists bots (a combobox); picking one asks it, which is how it joins
    choose, configure, toFor             model picker and runner controls changing that pick
    Composer: submit, add, typeRecipients, filled, compactNow   send, images, typed recipients, context meter
    PickerBot            bots in the picker, and as @mention options
  agent.js               agents' labels and live work (doing); client's agentTo, formatAgent, lastToolCall, modelsOf
  model-picker.js        model, thinking and folder controls (composer and settings share them)
  runner.js              runner list, a runner's agents, ConnectRunner
  bot.js                 a bot's settings, its threads row, new bot; botThreads shares its own/elsewhere lists
  thread-list.js         the thread list, its family rows
  thread-details.js      title, people, family, tools and the memory switch for the open thread;
                         a bot's threads as a page of the sheet
  agent-memory.js        memory popover and compaction view for the visible thread
  icons.js               Icon: the client's stroke icons (up, back, plus, close, next, check, again), one viewBox and weight
  title.js               defaultTitle shared by new-thread client paths, CLI and auto-title
  settings.js            server settings: modules on/off and memory's model
  system.js, wires.js    the live system diagram and the wires between boxes
  tutorial.js            walkthrough buttons wired to the real server
  panes.js, popover.js, sure.js, notice.js, dot.js   list/detail frame, popover placement,
                         two-press button, error line, status dot
  images.js, markdown.js image shrinking to pi's limits; message markdown
  base.css               tokens, reset, every control's look (buttons and their variants), popover, rows, panes, status dot
  app.css                the chat's layout: list, threads, messages, composer, sheet, picker, settings, phone
  walkthrough.css        the story page and the live system's boxes and wires, all under body:not(.chat)
scripts/
  try.js                 scratch server with a scripted bot, for clicking through
  page-spy.js            browser init script: fetches, socket frames, stalls
  replay-pi.js           replays pi sessions into a thread, to try memory
examples/lib.js          what examples share: start (owned child processes), kill (awaits the exit), server, runner, scriptedRunner, api, view, until, quiet/settled/online (wait for state, not the clock), check
examples/17-memory-compaction.js   automatic and manual cuts, memory coverage and budget at small and large windows
examples/27-watch-agents-work.js   socket snapshots, streaming entries, delivery identity and reconnects
examples/all.js          suite queue, per-example timeout and interruption cleanup
examples/92-the-server-keeps-a-log.js   the log next to the store: output, crash stack, exit code
examples/76-import-a-pi-session.js   a pi session with a branch and a compaction becomes a thread; the agent is handed it
examples/99-pi-session-files.js   the session file pi loads: tool call, model change, compaction, restart, fork
examples/93-auto-title.js          one-shot default titles, explicit titles, edits in flight, failures, a new title on request
examples/74-examples-clean-up.js   CLI checks: example exit, failure and timeout leave no server
examples/64-settings-restart-the-server.js   settings write agent-ide.json and restart in place; only the server's machine may
examples/19, 23, 86–90-*-real-model.js   bench: memory recall, deep recall, introductions, another thread's
                                 fact, side question, directed mention and web search; REAL=1 only
examples/real-model-bench.js       real runner setup, delivery settling, evidence, step budgets and the `score` line
examples/real-model-bench.md       how to run the bench and its recorded baseline
examples/91-wait-for-the-runner.js runner startup waits for ready or rejects on exit
examples/95-cli-address-options.js CLI folder/thinking flags preserve model addresses and reject bot-only names
examples/96-one-executable.js installed executable dispatch, including leading CLI options
examples/94-head-matches-get.js    HEAD on a static file matches GET: same status, headers, no body
```

Where a feature lives:

- Talk between threads: modules/talk.js (post, threads, reply), server.js append/whom, client thread.js `Cross` (a crossed message as a step row), run.js `Exchange`.
- Asking a model / switching it: composer.js pick/choose, model-picker.js, server.js whom/reconfigure.
- Live work you watch: server.js work/doing/watch, client agent.js doing, run.js Turn.
- Memory and compaction: modules/memory.js, server.js compact/compactingAt, client agent-memory.js, thread.js rows (cuts, folded lines), run.js cutsOf.
- Bots: modules/bots.js, client bot.js, composer.js PickerBot, client server.js homeBot/botAgent; a bot's colour is server.js `colorOf` (its picked `color` hue, else by the order bots were made), picked in bot.js `BotSettings` `.colors`.
- Runners and keys: remote.js, runner.js, server.js mintKey/revoke/upgrade, client runner.js.
- Forks: server.js forkThread/seenBy, client server.js fork, thread.js Message (fork link).
- `$ cmd`: server.js Shell, printed, shells.
- Status dots: server.js status/busiest, client dot.js.
- Pi session files, both ways: modules/pi-sessions.js; the runner's messages are `pi-session`, `pi-session-list` and `pi-session-read` in remote.js serveRunner, shipped with the runner through RUNNER_FILES; cli.js `import`.
- Settings and modules: modules.js, server.js saveSettings/restart, client settings.js.

## UI parts

Build from these; a new panel, row or button takes its sibling's markup and class, and adds no CSS of its own. A control (button, input, select, textarea, checkbox) gets its look only in base.css, from its element or a variant class; a rule for a place sets its layout only. Quoted names are the CSS files' section comments.

- Buttons, three variants ("Three buttons"): bordered is plain `button` (Done, Create, Copy, archive, fork, revoke); `button.ghost` has no border and gets a soft fill on hover and when `aria-pressed` or `aria-expanded` (composer bar, foot toggles, closes, backs, thinking levels); `button.primary` is filled with ink (send). `data-danger` turns any of them red on hover. One size modifier, `.small` (12px: the composer bar, row ends, Done, options, thinking levels, backs, pane closes, Copy, Create, foot toggles). Two more classes keep a look of their own: `.send`, the one round button, and `.row`, a link as wide as its list. Fields share one look (`input`, `textarea`, `select`), plus `.bare` for a name that reads as a heading and `.draft` for the composer's box.
- Popover: a `div.popover[popover]` placed by `placePopover` (popover.js), a bottom sheet on phones ("The model picker and settings"). Panes inside it (panes.js `Panes`, `.panes .pane`, "A detail covers") give it a header with a ghost close, a back and actions. Settings (settings.js), Runners (runner.js `.runner-list`) and Context (composer.js `.recall`) use it; the model picker and @mentions (composer.js `.model-picker`) are the same frame without panes.
- Popover rows: `ul.rows > li` in a popover's pane body, one per module, runner or option ("One row across"); the picker's `.model-controls .who` and `.model` share the look.
- Model controls: model-picker.js `ModelPicker`, `.model-controls` with its `.models` and the `.thinking` levels ("A runner, its models"); the composer and settings share it.
- Left aside: thread-list.js `ThreadList`, `.thread-list`; each row is `li > .row` (a link, or a button, or `form.row` for a new bot), shared with the family list `.thread-family`; its foot is `.list-foot` with `.foot-toggle`s ("The list's foot").
- Right aside: thread-details.js `ThreadDetails`, `.thread-details` with `.scrim` ("This thread's sheet"); a bot's part is bot.js `BotSettings`, `.bot`; its fields are plain inputs; a page of it has `.page-head`.
- Thread head: the pill, `h2.title > button.thread-pill` in `.thread > header` and its `.close` ("The head is no bar"); `.thread-pill` is layout only; on a phone `.app-bar` ("A phone").
- Message list: thread.js `Message` in `.thread > ul > li` ("The chat: agents write"), its body `.markdown`, its images `div.images`, compaction's `li.cut` and `li.line`.
- Tool calls: run.js `Turn`, `Exchange`, `Step`, `Call`; `li.turn` is a `<details>` whose open list is `.steps`, its tools `.tool` and its words `.said`; `.exchange` and a crossed message are a `.steps` list of thread.js `Cross` rows (`li.sent`, `li.received`). There's no thinking block: a live turn's summary says "thinking".
- Composer: composer.js `Composer`, `.thread form`: the box, `.bar` with `.icon` buttons, `.pick` (whom it asks) and `.stop`, and `ul.images` waiting to go.
- Small parts: sure.js `Sure` (`.sure`, a button that asks by changing its words), notice.js `Notice` (`.notice`, what went wrong, above the active composer's input), dot.js `Dot` (`.dot`, status).
