import { wires } from './wires.js';
const params = new URLSearchParams(location.search);
const url = params.get('server') || 'http://127.0.0.1:3000';
const me = params.get('user') || 'you';
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => { const e = Object.assign(document.createElement(tag), props); e.append(...children.filter((c) => c != null && c !== false)); return e; };
const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// Where the four pieces live, per product. The chips move between the places; hovering one lights it up on the stage.
const PIECES = { model: 'Claude, GPT, Gemini', loop: 'Pi, Claude Code, Codex', hands: 'where tools run', memory: 'the chat history' };
const PRODUCTS = {
  chatgpt: { model: 'lab', loop: 'lab', hands: 'lab', memory: 'lab', caption: 'All four at OpenAI. Nothing to set up, and none of it yours.' },
  'claude-code': { model: 'lab', loop: 'laptop', hands: 'laptop', memory: 'laptop', caption: 'Yours, on one laptop. Close the lid and it stops.' },
  'agent-ide': { model: 'lab', loop: 'server', hands: 'anywhere', memory: 'server', caption: 'The loop and the memory on a box that stays on. The hands on any computer you lend it.' },
};
const chips = Object.fromEntries(Object.entries(PIECES).map(([piece, hint]) => [piece, el('span', { className: 'chip', title: hint, textContent: piece[0].toUpperCase() + piece.slice(1) })]));
for (const [piece, chip] of Object.entries(chips)) {
  chip.onmouseenter = () => { $('stage').dataset.focus = piece; };
  chip.onmouseleave = () => { $('stage').dataset.focus = seen; };
}
function product(name) {
  const before = new Map(Object.values(chips).map((c) => [c, c.getBoundingClientRect()]));
  for (const [piece, place] of Object.entries(PRODUCTS[name]).filter(([k]) => k in PIECES)) document.querySelector(`[data-place=${place}]`).append(chips[piece]);
  for (const place of document.querySelectorAll('.place')) place.classList.toggle('used', place.querySelector('.chip') !== null);
  // Each chip glides from where it was.
  for (const [chip, was] of before) {
    const now = chip.getBoundingClientRect();
    if (was.width) chip.animate([{ transform: `translate(${was.left - now.left}px, ${was.top - now.top}px)` }, { transform: 'none' }], { duration: 450, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
  for (const b of document.querySelectorAll('[data-product]')) b.setAttribute('aria-pressed', b.dataset.product === name);
  $('caption').textContent = PRODUCTS[name].caption;
}
for (const b of document.querySelectorAll('[data-product]')) b.onclick = () => product(b.dataset.product);
product('chatgpt');

// The section in view says what the stage should show.
let seen = 'all';
const sections = new IntersectionObserver((list) => {
  for (const e of list) if (e.isIntersecting) $('stage').dataset.focus = seen = e.target.dataset.focus;
}, { rootMargin: '-45% 0px -45% 0px' });
document.querySelectorAll('.page > section').forEach((s) => sections.observe(s));

// model:thinking@runner, as pi names a model: the last @ splits off the runner, a last :effort the thinking.
function agent(name) {
  const at = name.lastIndexOf('@');
  let model = at < 0 ? name : name.slice(0, at), effort;
  const colon = model.lastIndexOf(':');
  if (colon >= 0 && EFFORTS.includes(model.slice(colon + 1))) [model, effort] = [model.slice(0, colon), model.slice(colon + 1)];
  return { runner: at < 0 ? '' : name.slice(at + 1), ...(model && { model }), ...(effort && { effort }) };
}
const name = ({ model, effort, runner }) => `${model ?? ''}${effort ? `:${effort}` : ''}@${runner}`;
const key = (runner, model) => `${model}@${runner}`;
const same = (a, b) => a?.runner === b?.runner && a?.model === b?.model;

let up = false, runners = [], threads = [];
let current = Number(params.get('thread')) || null;
let picks = []; // whom the next message asks, the same as the text under the composer
const details = new Map(); // thread id → its entries
const live = new Map(); // `${thread} ${agent}` → what that agent is doing right now

const api = (path, body) => fetch(url + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user': me }, body: JSON.stringify(body) })
  .then(async (r) => { const json = await r.json(); if (!r.ok) throw new Error(json.error); return json; });

// The thread on screen and its family: what it forked from, the threads its agents started, and theirs.
function family() {
  if (!current) return [];
  const byId = new Map(threads.map((t) => [t.id, t]));
  const up = (id) => byId.get(id)?.parent ?? forkOf(byId.get(id));
  let root = current;
  for (let n = 0; up(root) && byId.has(up(root)) && n < 20; n++) root = up(root);
  const out = [root];
  for (let i = 0; i < out.length; i++) for (const t of threads) if (up(t.id) === out[i] && !out.includes(t.id) && !t.hidden) out.push(t.id);
  if (!out.includes(current)) out.push(current);
  return out.filter((id) => byId.has(id));
}
// Pi records where a fork came from.
const forkOf = (t) => t?.conversation?.parent?.conversationId;
const go = (id) => {
  current = id;
  const next = new URL(location.href);
  if (id) next.searchParams.set('thread', id); else next.searchParams.delete('thread');
  history.replaceState(null, '', next);
  focus = true;
  refresh();
};
let focus = false; // the next render puts the cursor in the composer
// Hides it; Pi keeps everything.
async function remove(id) {
  await fetch(`${url}/api/threads/${id}`, { method: 'DELETE', headers: { 'x-user': me } });
  if (family().includes(id)) go(null); else refresh();
}

async function ask(body, to = picks) {
  if (!to.length) return;
  if (!current) {
    const { id } = await api('/api/threads', { title: body.slice(0, 60) });
    go(id);
  }
  await api(`/api/threads/${current}/entries`, { body, to });
  refresh();
}

// The composer: what you write, and whom it asks as one editable name.
const composer = $('composer').content.cloneNode(true);
const form = composer.querySelector('form'), $to = composer.querySelector('#to');
form.onsubmit = async (e) => {
  e.preventDefault();
  const input = form.querySelector('input'), body = input.value;
  input.value = '';
  await ask(body).catch((error) => { input.value = body; alert(error.message); });
};
$to.oninput = () => {
  picks = $to.value.split(',').map((s) => s.trim()).filter(Boolean).map(agent);
  for (const { runner, ...set } of picks) chosen[runner] = set;
  render();
};
const choose = (next) => { picks = next; $to.value = picks.map(name).join(', '); render(); };

// Fetches what changed; the server says when over /ws.
let fetching = null, again = false;
async function refresh() {
  if (fetching) return void (again = true);
  fetching = (async () => {
    const [r, t] = await Promise.all([api('/api/runners').catch(() => null), api('/api/threads').catch(() => null)]);
    up = Boolean(r);
    runners = r ?? [];
    threads = t ?? [];
    // A thread that's gone, deleted here or elsewhere, leaves a new one in its place.
    if (t && current && !threads.some((x) => x.id === current)) current = null;
    const home = runners.find((x) => x.online) ?? runners[0];
    if (!picks.length && home?.model) choose([{ runner: home.name, model: home.model }]);
    await Promise.all(family().map(async (id) => details.set(id, (await api(`/api/threads/${id}`).catch(() => null))?.entries ?? details.get(id) ?? [])));
    watchAll();
    render();
  })();
  await fetching;
  fetching = null;
  if (again) { again = false; refresh(); }
}

// One socket hears that something changed; one per thread on screen streams what its agents are doing.
function pulse() {
  const socket = new WebSocket(`${url.replace(/^http/, 'ws')}/ws`);
  socket.onopen = refresh;
  socket.onmessage = refresh;
  socket.onclose = () => { up = false; render(); setTimeout(pulse, 1000); };
}
const watchers = new Map();
function watchAll() {
  const shown = new Set(family());
  for (const [id, socket] of watchers) if (!shown.has(id)) { socket.onclose = null; socket.close(); watchers.delete(id); }
  for (const id of shown) {
    if (watchers.has(id)) continue;
    const socket = new WebSocket(`${url.replace(/^http/, 'ws')}/ws`);
    socket.onopen = () => socket.send(JSON.stringify({ watch: id }));
    socket.onmessage = (m) => {
      const { thread, agent: who, events } = JSON.parse(m.data);
      if (!who || !events) return;
      for (const e of events) live.set(`${thread} ${who}`, step(live.get(`${thread} ${who}`) ?? { run: false, message: null, tools: [] }, e));
      render();
    };
    socket.onclose = () => { watchers.delete(id); };
    watchers.set(id, socket);
  }
}

// Pi's agent events, down to what this page shows: the reply being written and the tool calls of this run.
function step(state, e) {
  const tool = (id, change) => {
    const old = state.tools.find((t) => t.callId === id) ?? { callId: id, name: e.toolName };
    return { ...state, tools: [...state.tools.filter((t) => t !== old), { ...old, ...change }] };
  };
  switch (e.type) {
    case 'snapshot': return { run: Boolean(e.run), message: e.generation?.message ?? null, tools: e.tools ?? [] };
    case 'run_start': return { ...state, run: true };
    case 'run_end': return { run: false, message: null, tools: [] };
    case 'message_start': return e.message.role === 'assistant' ? { ...state, message: e.message } : state;
    case 'message_update': return state.message ? { ...state, message: e.changes.reduce(changed, structuredClone(state.message)) } : state;
    case 'message_end': return { ...state, message: null };
    case 'tool_execution_start': return tool(e.toolCallId, { args: e.args, status: 'running' });
    case 'tool_execution_end': return tool(e.toolCallId, { status: 'done' });
    default: return state;
  }
}
function changed(message, c) {
  const blocks = message.content;
  if (c.type === 'message') return structuredClone(c.message);
  if (c.type.endsWith('_start')) blocks.splice(c.contentIndex, 0, structuredClone(c.block));
  else if (c.type === 'block') blocks[c.contentIndex] = structuredClone(c.block);
  else if (c.type === 'text_delta') blocks[c.contentIndex].text += c.delta;
  else if (c.type === 'thinking_delta') blocks[c.contentIndex].thinking += c.delta;
  return message;
}
const text = (message) => (message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
const handsOf = (state) => {
  const t = state?.run && state.tools.at(-1);
  if (!t) return '';
  const a = t.args ?? {};
  return `${t.name} ${a.command ?? a.path ?? a.pattern ?? a.query ?? a.body ?? ''}`.trim();
};

// One box per thread on screen; the composer sits in the current one.
const boxes = new Map();
function threadBox(id) {
  const t = threads.find((x) => x.id === id);
  let box = boxes.get(id);
  if (!box) {
    // A thread that isn't current shows a box to write in all the same; clicking it brings the composer.
    const write = el('form', { className: 'elsewhere' }, el('input', { placeholder: 'Write here', onfocus: () => go(id) }));
    box = el('div', { className: 'thread' }, el('header', { onclick: () => current !== id ? go(id) : form.querySelector('input').focus() }, el('span'), el('span', { className: 'dot' })),
      el('nav', { className: 'from' }), el('ul'), write);
    boxes.set(id, box);
  }
  box.classList.toggle('current', id === current);
  const [title, dot] = box.querySelector('header').children;
  title.textContent = t?.title || 'untitled';
  dot.className = `dot${t?.status === 'working' ? ' working' : t?.status === 'blocked' ? ' blocked' : ''}`;
  // Where it came from, as a link: a fork's thread, or the thread whose agent started it.
  const origin = forkOf(t) ?? t?.parent;
  const from = box.querySelector('nav.from');
  const fromSig = JSON.stringify([origin, titleOf(origin)]);
  if (from.dataset.sig !== fromSig) {
    from.dataset.sig = fromSig;
    from.replaceChildren(...(origin ? [link(origin, `← ${forkOf(t) ? 'forked from' : 'asked from'} ${titleOf(origin)}`)] : []));
  }
  box.querySelector('form.elsewhere').hidden = id === current;
  // Messages, then any reply still being written; the list keeps its place unless it was at the bottom.
  const list = box.querySelector('ul');
  const writing = (t?.agents ?? []).map((a) => [a.name, text(live.get(`${id} ${a.name}`)?.message)]).filter(([, s]) => s);
  const entries = (details.get(id) ?? []).filter((x) => x.kind === 'agent-ide.message');
  // Forks made from a message, as links under it.
  const forksAt = new Map();
  for (const f of threads) if (forkOf(f) === id && !f.hidden) forksAt.set(f.conversation.parent.at, [...forksAt.get(f.conversation.parent.at) ?? [], f]);
  const sig = JSON.stringify([entries.map((x) => x.id), writing, [...forksAt].map(([at, fs]) => [at, fs.map((f) => [f.id, f.title, f.status])])]);
  if (list.dataset.sig !== sig) {
    list.dataset.sig = sig;
    const grew = entries.length + writing.length > list.children.length;
    const stuck = grew || list.scrollTop + list.clientHeight >= list.scrollHeight - 4;
    list.replaceChildren(
      ...entries.map(({ id: at, data }) => el('li', {},
        el('small', {}, data.author, ...(data.from && data.from !== id && data.from !== origin ? [' · ', link(data.from, `from ${titleOf(data.from)} →`)] : [])), data.body,
        ...(forksAt.get(at) ?? []).map((f) => el('div', { className: 'links' }, link(f.id, `forked → ${f.title}`))),
        el('button', { className: 'fork', textContent: 'fork', title: 'A new thread from this message', onclick: () => fork(id, at) }))),
      ...writing.map(([who, s]) => el('li', { className: 'writing' }, el('small', { textContent: `${who} · writing` }), s)));
    if (stuck) list.scrollTop = list.scrollHeight;
  }
  if (id === current && form.parentNode !== box) box.append(form, $to);
  return box;
}
const titleOf = (id) => threads.find((t) => t.id === id)?.title || `thread ${id}`;
// A link to another thread, with its light.
function link(id, label) {
  const t = threads.find((x) => x.id === id);
  return el('a', { href: `?${new URLSearchParams({ ...Object.fromEntries(params), thread: id })}`, className: 'thread-link', onclick: (e) => { e.preventDefault(); go(id); } },
    el('span', { className: `dot${t?.status === 'working' ? ' working' : t?.status === 'blocked' ? ' blocked' : ''}` }), label);
}
async function fork(id, at) {
  go((await api(`/api/threads/${id}/fork`, { at })).id);
}

const w = wires($('canvas'));
let blankBox;
function render() {
  $('server').classList.toggle('off', !up);
  $('server').querySelector('.dot').classList.toggle('on', up);
  $('server').querySelector('code').textContent = url;
  // Another machine can't reach localhost; it needs the server's name on the network.
  const reachable = /^https?:\/\/(localhost|127\.|\[::1\])/.test(url) ? url.replace(/\/\/[^:/]+/, '//yourbox') : url;
  $('lend').textContent = `curl -fsSL ${reachable}/connect-runner | sh -s -- --dir ~/code`;

  const shown = family();
  const shownThreads = shown.map((id) => threads.find((t) => t.id === id)).filter(Boolean);
  blankBox ??= el('div', { className: 'thread current' }, el('header', {}, el('span', { textContent: 'a new thread' })));
  const blank = !current && blankBox;
  if (blank && form.parentNode !== blank) blank.append(form, $to);
  // Moved only when they change: taking a box out and back would lose the cursor in it.
  const next = [...shown.map(threadBox), ...(blank ? [blank] : [])];
  if (next.length !== $('threads').children.length || next.some((b, i) => $('threads').children[i] !== b)) $('threads').replaceChildren(...next);
  if (focus && (!current || details.has(current))) { focus = false; form.querySelector('input').focus(); }
  // Every thread on the server, newest first; a new one always on top.
  const familyOf = new Set(shown);
  $('list').replaceChildren(
    el('button', { className: `new${current ? '' : ' current'}`, textContent: '+ New thread', onclick: () => go(null) }),
    el('ul', {}, ...threads.filter((t) => !t.hidden && !threads.some((p) => p.id === t.parent)).map((t) => el('li', {
      className: `${t.id === current ? 'current' : familyOf.has(t.id) ? 'kin' : ''}`, title: t.title, onclick: () => go(t.id),
    }, el('span', { className: `dot${t.status === 'working' ? ' working' : t.status === 'blocked' ? ' blocked' : t.status === 'done' ? ' on' : ''}` }),
    el('span', { textContent: t.title || 'untitled' }),
    el('button', { textContent: 'delete', title: 'Delete this thread', onclick: (e) => { e.stopPropagation(); remove(t.id); } })))));

  // A runner is one card: click it to ask it, shift-click to ask it too. Its model and thinking are set on the card.
  const asked = shownThreads.flatMap((t) => t.agents.map((a) => ({ ...a, thread: t.id })));
  const sig = JSON.stringify([runners.map((r) => [r.name, r.online, r.dir, r.model, r.offers]), picks, chosen, asked.map((a) => [a.thread, a.name, a.status]),
    asked.map((a) => handsOf(live.get(`${a.thread} ${a.name}`)))]);
  if ($('runners').dataset.sig !== sig) {
    $('runners').dataset.sig = sig;
    $('runners').replaceChildren(...runners.map((r) => runnerCard(r, asked)));
  }

  // Only the connections live here; wires owns their geometry.
  const down = { fromSide: 'bottom', toSide: 'top', fromAt: 'to' };
  const row = (runner, model) => $('runners').querySelector(`[data-agent="${CSS.escape(key(runner, model))}"]`);
  const state = (s) => !s || s === 'idle' ? '' : s;
  const connections = [{ from: $('client'), to: $('server'), fromSide: 'right', toSide: 'left', fromAt: 18, toAt: 18, className: up ? '' : 'off' }];
  // A runner a thread wires to needs no wire of its own from the server: the thread's is that connection.
  const reached = new Set([...picks.map((p) => p.runner), ...shownThreads.flatMap((t) => t.agents.map((a) => a.to.runner))]);
  for (const r of runners) if (!reached.has(r.name)) connections.push({ ...down, from: $('server'), to: $(`runner-${r.name}`), toAt: 40, className: up && r.online ? '' : 'off' });
  for (const t of shownThreads) {
    const from = boxes.get(t.id);
    for (const a of t.agents) {
      if (t.id === current && picks.some((p) => same(p, a.to))) continue;
      connections.push({ ...down, from, to: row(a.to.runner, a.to.model), toAt: -20, className: state(a.status) });
    }
  }
  const mine = shownThreads.find((t) => t.id === current)?.agents ?? [];
  for (const p of picks) connections.push({ ...down, from: $to, to: row(p.runner, p.model), toAt: -20, className: state(mine.find((a) => same(a.to, p))?.status) || 'route' });
  w.draw(connections);
}

// What each runner's card is set to: the model and thinking it asks with, kept when it's not picked.
const chosen = {};
const setting = (r) => {
  const p = picks.find((x) => x.runner === r.name);
  return p ? { model: p.model, effort: p.effort } : chosen[r.name] ?? { model: r.model };
};
function tune(r, change) {
  const next = Object.fromEntries(Object.entries({ ...setting(r), ...change }).filter(([, v]) => v));
  chosen[r.name] = next;
  if (picks.some((p) => p.runner === r.name)) choose(picks.map((p) => p.runner === r.name ? { runner: r.name, ...next } : p));
  else render();
}
function toggle(r, also) {
  const self = { runner: r.name, ...setting(r) };
  const on = picks.some((p) => p.runner === r.name);
  if (!also) return choose([self]);
  if (!on) return choose([...picks, self]);
  if (picks.length > 1) choose(picks.filter((p) => p.runner !== r.name));
}

// One runner: its light, its folder, the model it asks with and how hard it thinks, and what its hands are doing.
// Agents the threads asked here with another model get a quiet row of their own, for their wire and light.
function runnerCard(r, asked) {
  const set = setting(r);
  const on = picks.some((p) => p.runner === r.name);
  const here = asked.filter((a) => a.to.runner === r.name);
  const light = (list) => {
    const s = list.map((a) => a.status);
    return s.includes('working') ? 'working' : s.includes('blocked') ? 'blocked' : s.length ? 'idle' : null;
  };
  const row = (model, ...children) => {
    const list = here.filter((a) => a.to.model === model), busy = light(list);
    const hands = list.map((a) => handsOf(live.get(`${a.thread} ${a.name}`))).find(Boolean);
    const li = el('li', {}, ...children, busy && el('span', { className: `dot${busy === 'idle' ? '' : ` ${busy}`}`, title: busy }),
      hands && el('span', { className: 'hands', textContent: hands, title: hands }));
    li.dataset.agent = key(r.name, model);
    return li;
  };
  const stop = (e) => e.stopPropagation();
  const models = [...new Set([set.model, r.model, ...(r.offers ?? [])].filter(Boolean))];
  const swap = el('select', { className: 'swap', title: 'model', onclick: stop, onchange: () => tune(r, { model: swap.value }) }, ...models.map((o) => new Option(o, o)));
  swap.value = set.model ?? '';
  // How hard it thinks: a slider from the runner's default up to max.
  const knob = el('input', { type: 'range', min: 0, max: EFFORTS.length, value: EFFORTS.indexOf(set.effort) + 1, title: set.effort || 'default thinking', onclick: stop });
  knob.onchange = () => tune(r, { effort: knob.value > 0 ? EFFORTS[knob.value - 1] : undefined });
  const others = [...new Set(here.map((a) => a.to.model))].filter((m) => m !== set.model);
  return el('div', {
    className: `node card${r.online ? '' : ' off'}${on ? ' routed' : ''}`, id: `runner-${r.name}`,
    title: on ? 'Shift-click to stop asking it' : 'Click to ask it; shift-click to ask it too',
    onclick: (e) => toggle(r, e.shiftKey || e.metaKey || e.ctrlKey),
  },
  el('b', {}, el('span', { className: `dot${r.online ? ' on' : ''}` }), r.name),
  el('small', { textContent: r.dir }),
  !models.length && el('small', { textContent: 'No models here yet: run pi there and /login.' }),
  el('ul', { className: 'models' }, models.length && row(set.model, swap, knob), ...others.map((m) => row(m, el('span', { className: 'name', textContent: m })))));
}

// The buttons in the text set the stage up and press go.
const defaults = () => runners.filter((r) => r.online && setting(r).model).map((r) => ({ runner: r.name, ...setting(r) }));
const fresh = () => { if (current) go(null); };
const TRIES = {
  hands: () => { fresh(); choose(defaults().slice(0, 1)); return ask('Which file in this folder is biggest? Look, don\'t guess. One line.'); },
  friend: async () => {
    if (!current) go((await api('/api/threads', { title: 'A thread for two' })).id);
    const link = new URL(location.href);
    link.searchParams.set('thread', current);
    link.searchParams.set('user', 'Ana');
    open(link, '_blank');
  },
  two: () => { fresh(); choose(defaults()); return ask('What machine are you on, and in which folder? One line.'); },
  talk: () => {
    fresh();
    const [first, second = first] = defaults();
    choose([first]);
    return ask(`Use your post tool to start a thread asking ${name(second)} what is in its folder. Wait for its answer, then tell me in one line.`);
  },
};
for (const b of document.querySelectorAll('[data-try]')) b.onclick = () => {
  if (matchMedia('(max-width: 1000px)').matches) $('stage').scrollIntoView({ behavior: 'smooth' });
  TRIES[b.dataset.try]().catch((error) => alert(error.message));
};

pulse();
setInterval(refresh, 5000);
