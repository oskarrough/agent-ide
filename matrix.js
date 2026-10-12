// Matrix rooms as agent-ide threads. In: matrixSync reads MATRIX_ROOMS and posts every message, as its sender, into the
// thread kept for its room or its Matrix thread. A mention of the bot by one of MATRIX_USERS asks MATRIX_AGENT, and
// their later messages there ask whom it last asked. Out: the `posted` hook sends an agent's answer or error in a kept
// thread back to its room or Matrix thread by a MatrixSend task.
//
// Setting it up:
//   1. Give the bot its own account on any homeserver, and get a token for it:
//        curl -s https://matrix-client.matrix.org/_matrix/client/v3/login -d '{"type":"m.login.password",
//          "identifier":{"type":"m.id.user","user":"BOT"},"password":"PASSWORD"}'
//      Its `access_token` is MATRIX_TOKEN.
//   2. Invite it to a room without end-to-end encryption, which the bridge can't read.
//   3. MATRIX=1 MATRIX_TOKEN=… MATRIX_ROOMS='#room:matrix.org' MATRIX_USERS='@you:matrix.org' \
//        MATRIX_AGENT=sonnet@laptop MATRIX_JOB='File it with `gh issue create`; answer with the link.' bun server.js
//      ROOMS and USERS take several, comma-separated. AGENT is model@runner, or a runner for its default model.
//      Without USERS nothing from Matrix asks anyone. MATRIX_HOMESERVER is matrix.org's unless set.
//   4. Write `@BOT …` in the room. Its thread shows up in the client, titled `matrix #room:matrix.org: …`.
import { defineDoc, defineExtension, defineTask } from '@earendil-works/pi-durable';

// The thread kept for each room by its id and each Matrix thread by its root event, as `{thread, room, root}`, root ''
// for a room's own; the last send into each room, and a salt for this store's transaction ids; how far the sync has
// read, and the events posted since. A fork is kept for nothing.
const MatrixBridge = defineDoc({ kind: 'agent-ide.matrix.bridge', version: 1, scope: 'session', initial: () => ({ since: '', done: [], threads: {}, last: {}, salt: '' }) });
const finished = (status = 'completed') => ({ status: 'terminal', outcome: { status, result: null } });
const background = (threadId) => ({ ownership: { kind: 'conversation' }, conversationId: threadId, background: true });
const matrixEnvList = (name) => (process.env[name] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const sleep = (ms, signal) => new Promise((r) => { const t = setTimeout(r, ms); signal?.addEventListener('abort', () => (clearTimeout(t), r())); });
// A homeserver's no, which asking again won't change.
const matrixRefused = (error) => error.status >= 400 && error.status < 500 && error.status !== 429;
// Anyone in a room can write: no terminal escapes, control characters or bidi overrides get through to an agent.
const matrixCleanText = (text) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');

export function server(core) {
  const { MATRIX_HOMESERVER: home = 'https://matrix-client.matrix.org', MATRIX_TOKEN: token, MATRIX_AGENT: agent, MATRIX_JOB: job } = process.env;
  const names = matrixEnvList('MATRIX_ROOMS');
  const users = new Set(matrixEnvList('MATRIX_USERS'));
  if (!token || !names.length) throw new Error('MATRIX=1 needs MATRIX_TOKEN and MATRIX_ROOMS: see matrix.js');

  async function matrixRequest(method, route, body, signal) {
    const res = await fetch(`${home.replace(/\/$/, '')}/_matrix/client${route}`, { method, signal, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    if (!res.ok) {
      const text = await res.text();
      const retryAfter = res.status === 429 ? JSON.parse(text || '{}').retry_after_ms : undefined;
      throw Object.assign(new Error(`Matrix ${method} ${route.split('?')[0]}: ${res.status} ${text}`), { status: res.status, retryAfter });
    }
    return res.json();
  }

  // Waits, as a Pi task wait, until the room's send before it is done, so a room's answers land in the order they were
  // written, even across a restart. Then tries until the homeserver takes it or refuses it, waiting as long as a rate
  // limit asks, under a transaction id made from the entry and the store's salt, so the homeserver drops a resend.
  const MatrixSend = defineTask({
    name: 'agent-ide.matrix.send', version: 1, initial: ({ after }) => ({ phase: after ? 'wait' : 'send' }),
    phases: {
      wait: ({ input: { after } }, rt, ctx) => rt.commit(() => ({ status: 'waiting', checkpoint: { phase: 'send' }, on: [after], policy: 'allSettled' }), ctx),
      async send({ input: { room, root, txn, body } }, rt, ctx) {
        const content = { msgtype: 'm.text', body: body.slice(0, 30000), ...(root ? { 'm.relates_to': { rel_type: 'm.thread', event_id: root, is_falling_back: true, 'm.in_reply_to': { event_id: root } } } : {}) };
        for (let wait = 1000; !rt.signal.aborted; wait = Math.min(wait * 2, 60000)) {
          try {
            const signal = AbortSignal.any([rt.signal, AbortSignal.timeout(60000)]);
            await matrixRequest('PUT', `/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/${txn}`, content, signal);
            break;
          } catch (error) {
            console.error(`matrix send: ${error.message}`);
            if (matrixRefused(error)) break;
            await sleep(error.retryAfter ?? wait, rt.signal);
          }
        }
        await rt.commit(() => finished(), ctx);
      },
    },
    abort: (task, rt, ctx) => rt.commit(() => finished('aborted'), ctx),
  });

  // Out: an agent's answer or error in a kept thread goes to its Matrix thread, or top-level from a room's thread.
  async function posted(tx, threadId, { id, data }) {
    if (!data.answer && !data.error) return;
    const bridge = await tx.doc(MatrixBridge);
    const { room, root } = Object.values(bridge.threads).find((t) => t.thread === threadId) ?? {};
    if (!room) return;
    bridge.salt ||= crypto.randomUUID();
    bridge.last[room] = await tx.createTask(MatrixSend, { room, root, txn: `agent-ide-${bridge.salt}-${threadId}-${id}`, body: data.body, after: bridge.last[room] }, background(threadId));
  }

  /**
   * @typedef {{ id: string, room: string, root: string, author: string, body: string, asks: boolean }} MatrixMessage
   *   A text message in MATRIX_ROOMS, not an edit and not one the bridge sent, its body cleaned. `root` is its Matrix
   *   thread's first event, or its own. It `asks` when it's from MATRIX_USERS, mentions the bot, and there is an agent.
   */
  let me, mentioned, rooms, to;
  const matrixState = () => core.commit(async (tx) => JSON.parse(JSON.stringify(await tx.doc(MatrixBridge))));

  // Matrix shows a sender its own transaction ids, so this skips what the bridge itself sent, even if its account is one
  // of MATRIX_USERS.
  /** @returns {MatrixMessage | null} */
  function matrixMessageOf(room, e) {
    const relation = e.content?.['m.relates_to'];
    if (e.type !== 'm.room.message' || typeof e.content.body !== 'string' || relation?.rel_type === 'm.replace' || e.unsigned?.transaction_id) return null;
    const mentions = e.content['m.mentions']?.user_ids?.includes(me) || mentioned.test(e.content.body);
    return {
      id: e.event_id, room, author: e.sender, body: matrixCleanText(e.content.body),
      root: relation?.rel_type === 'm.thread' ? relation.event_id : e.event_id, asks: Boolean(agent && mentions && users.has(e.sender)),
    };
  }

  // What a sync batch brought since `since`. A room's timeline that came `limited` is paged back to there first.
  /** @returns {Promise<MatrixMessage[]>} */
  async function matrixReadBatch(batch, since) {
    const messages = [];
    for (const [room, { timeline = {} }] of Object.entries(batch.rooms?.join ?? {}).filter(([room]) => rooms[room])) {
      const events = [...timeline.events ?? []];
      for (let from = timeline.limited && timeline.prev_batch; from;) {
        const page = await matrixRequest('GET', `/v3/rooms/${encodeURIComponent(room)}/messages?dir=b&limit=100&from=${encodeURIComponent(from)}&to=${encodeURIComponent(since)}`);
        events.unshift(...page.chunk.reverse());
        from = page.chunk.length && page.end;
      }
      messages.push(...events.map((e) => matrixMessageOf(room, e)).filter(Boolean));
    }
    return messages;
  }

  // A Matrix thread's first message, which may be older than the bridge. One the homeserver won't show opens without it.
  const matrixRoot = ({ room, root }) => matrixRequest('GET', `/v3/rooms/${encodeURIComponent(room)}/event/${encodeURIComponent(root)}`)
    .then((e) => matrixMessageOf(room, e), (error) => { if (matrixRefused(error)) return null; throw error; });

  // Keeps a new thread for a room, or a Matrix thread in it, inside the caller's commit.
  async function matrixKeep(tx, bridge, key, room, root, title) {
    const thread = await core.startThread(tx, 'matrix', title, null);
    bridge.threads[key] = { thread, room, root };
    return thread;
  }

  // Posts a message into the thread kept for its room, or its Matrix thread, in a commit that notes it so a restart's
  // second read skips it. A top-level one that asks starts its own Matrix thread, and lands in the room's thread too,
  // asking nobody. A thread not kept yet is opened first, in a commit of its own: a Matrix thread's with the job, the
  // room's thread id and its first message.
  /** @param {MatrixMessage} message */
  async function matrixRelay(message) {
    const { id, room, root, author, body, asks } = message;
    const key = root !== id || asks ? root : room;
    const { threads, done } = await matrixState();
    if (done.includes(id)) return;
    if (!threads[key]) {
      const first = root !== id && await matrixRoot(message);
      await core.commit(async (tx) => {
        const bridge = await tx.doc(MatrixBridge);
        const roomThread = bridge.threads[room]?.thread ?? await matrixKeep(tx, bridge, room, room, '', `matrix ${rooms[room]}`);
        if (key === room) return;
        if (root === id) await core.post(tx, roomThread, { author, body });
        const thread = await matrixKeep(tx, bridge, key, room, root, `matrix ${rooms[room]}: ${(first || message).body.slice(0, 60)}`);
        await core.post(tx, thread, { author: 'matrix', body: [job, `This is a Matrix thread in ${rooms[room]}, whose own chat is thread ${roomThread}.`].filter(Boolean).join('\n\n') });
        if (first) await core.post(tx, thread, { author: first.author, body: first.body });
      });
    }
    const asked = asks ? [to ??= await matrixAgent()] : users.has(author) ? await core.lastAsked((await matrixState()).threads[key].thread) : [];
    await core.commit(async (tx) => {
      const bridge = await tx.doc(MatrixBridge);
      await core.post(tx, bridge.threads[key].thread, { author, body, ...(asked.length ? { to: asked } : {}) }, { steer: true });
      bridge.done.push(id);
    });
  }

  // A runner that never connected can't name its model yet, so this waits for it, as a Deliver task does.
  async function matrixAgent() {
    const at = agent.lastIndexOf('@');
    const asked = { runner: agent.slice(at + 1), model: at < 0 ? '' : agent.slice(0, at) };
    return core.address(asked).catch(async () => (await core.runners.online(asked.runner), core.address(asked)));
  }

  async function matrixRetry(what, fn) {
    for (;;) {
      try {
        return await fn();
      } catch (error) {
        console.error(`matrix ${what}: ${error.message}`);
        await sleep(5000);
      }
    }
  }

  // In, forever: who the bot is and its rooms, once; then each batch Matrix's /sync brings → matrixReadBatch →
  // matrixRelay each, then commit its position. The first batch only takes its position. A sync that stays silent past
  // its long poll is asked again.
  async function matrixSync() {
    me = (await matrixRetry('whoami', () => matrixRequest('GET', '/v3/account/whoami'))).user_id;
    // `@bot` mentions it, but `@bottle` doesn't.
    const local = me.split(':')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    mentioned = new RegExp(`${local}(?![\\w-])`);
    rooms = {};
    for (const name of names) rooms[(await matrixRetry('join', () => matrixRequest('POST', `/v3/join/${encodeURIComponent(name)}`, {}))).room_id] = name;
    const filter = encodeURIComponent(JSON.stringify({ presence: { types: [] }, account_data: { types: [] }, room: { rooms: Object.keys(rooms), timeline: { types: ['m.room.message'] }, state: { types: [] }, ephemeral: { types: [] } } }));
    let { since } = await matrixState();
    for (;;) since = await matrixRetry('sync', async () => {
      const batch = await matrixRequest('GET', `/v3/sync?timeout=30000&filter=${filter}${since ? `&since=${encodeURIComponent(since)}` : ''}`, undefined, AbortSignal.timeout(40000));
      const messages = since ? await matrixReadBatch(batch, since) : [];
      for (const message of messages) await matrixRelay(message);
      if (!since || messages.length) await core.commit(async (tx) => Object.assign(await tx.doc(MatrixBridge), { since: batch.next_batch, done: [] }));
      return batch.next_batch;
    });
  }
  matrixSync();

  return { extension: defineExtension({ name: 'agent-ide.matrix', tasks: [MatrixSend] }), posted };
}
