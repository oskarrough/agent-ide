// <agent-memory server="http://…" thread="7">: a thread's memory, when its server runs memory.js. On top, what an
// agent reads, with a slider for how much room it has; below, the whole tree, opened from the top. A line opens on
// click into what it was made from, down to a message word for word. It follows the thread on its own.
const el = (tag, props = {}, ...children) => { const e = Object.assign(document.createElement(tag), props); e.append(...children.filter((c) => c != null && c !== false)); return e; };
const bytes = (text) => new TextEncoder().encode(text).length;
const sizeOf = (lines) => lines.reduce((s, x) => s + bytes(`${x.id}+${x.n}|${x.text}`) + 1, 0);
const unwritten = (x) => x.text.startsWith('(not summarized');

class AgentMemory extends HTMLElement {
  static observedAttributes = ['server', 'thread'];

  connectedCallback() {
    this.room = el('input', { type: 'range', min: 0, max: 100, value: 30, oninput: () => this.reads(true) });
    this.roomSize = el('span');
    this.bar = el('div', { className: 'bar' });
    this.note = el('p', { className: 'mute' });
    this.readLines = el('div');
    this.tree = el('div');
    this.replaceChildren(
      el('div', { className: 'memory reads' }, el('h3', { textContent: 'What an agent reads' }),
        el('label', { className: 'room' }, 'Room ', this.room, ' ', this.roomSize), this.bar, this.note, this.readLines),
      el('h3', { textContent: 'The whole tree' }), el('div', { className: 'memory' }, this.tree));
    this.timer = setInterval(() => this.update(), 3000);
    this.update();
  }
  disconnectedCallback() { clearInterval(this.timer); }
  attributeChangedCallback() { if (this.timer) { this.seen = ''; this.update(); } }

  api(path) { return fetch(`${this.getAttribute('server')}${path}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status)))); }
  get thread() { return Number(this.getAttribute('thread')) || null; }

  // Redraws what changed: the thread, its size, or lines still being written. A tree you've opened stays as it is.
  async update() {
    const server = this.getAttribute('server');
    if (!server) return;
    this.modules ??= (await this.api('/api/server').catch(() => ({}))).modules;
    if (!this.modules?.includes('memory')) return this.say('This server runs without memory. Start it with ', el('code', { textContent: 'MEMORY=1 MEMORY_MODEL=model@runner' }), '.');
    const id = this.thread;
    if (!id) return this.say('Load the example thread, or ask something, and its lines appear here.');
    const all = (await this.api(`/api/threads/${id}/memory`).catch(() => ({ lines: [] }))).lines;
    const T = all.length ? all.at(-1).id + all.at(-1).n : 0;
    if (!T) return this.say('No messages yet.');
    const pending = this.querySelector('.pending') !== null;
    const key = `${id} ${T}`;
    if (key === this.seen && !pending) return;
    // The slider runs from as squeezed as it gets to a line for every message, so all of its length matters.
    const top = (await this.api(`/api/threads/${id}/memory?budget=1`).catch(() => ({ lines: [] }))).lines;
    this.least = Math.max(100, sizeOf(top));
    this.full = Math.max(this.least * 2, sizeOf(all));
    this.T = T;
    this.seen = key;
    this.firstChild.hidden = false;
    await this.reads(true);
    if (this.tree.querySelector('li ul, li .whole') && !pending) return;
    const opened = await this.api(`/api/threads/${id}/memory?zoom=0,${2 ** Math.ceil(Math.log2(Math.max(T, 2)))}`).catch(() => null);
    if (opened?.lines) this.tree.replaceChildren(el('p', { className: 'mute', textContent: `${T} messages. Each line below stands for half of them; click to open it.` }), this.zoomable(opened.lines));
  }

  say(...text) {
    this.seen = '';
    this.firstChild.hidden = true;
    this.bar.replaceChildren();
    this.readLines.replaceChildren();
    this.note.replaceChildren();
    this.tree.replaceChildren(el('p', { className: 'mute' }, ...text));
  }

  // What an agent with that much room reads: old messages share lines, the latest have one each.
  async reads(fetchAgain) {
    if (!this.T) return;
    const room = Math.round(this.least * (this.full / this.least) ** (this.room.value / 100));
    this.roomSize.textContent = room < 1024 ? `${room} B` : `${(room / 1024).toFixed(room < 10240 ? 1 : 0)} KB`;
    if (!fetchAgain) return;
    const lines = (await this.api(`/api/threads/${this.thread}/memory?budget=${room}`).catch(() => ({ lines: [] }))).lines;
    const list = this.zoomable(lines);
    this.bar.replaceChildren(...lines.map((x, k) => {
      // As wide as the messages it stands for, darker the more it squeezes.
      const shade = Math.min(1, Math.log2(x.n) / 5);
      return el('span', { title: `${x.id}+${x.n}: ${x.n > 1 ? `${x.n} messages in one line` : 'one message'}`,
        style: `flex-grow:${x.n};background:hsl(215 60% ${88 - shade * 50}%)`, onclick: () => list.children[k]?.click() });
    }));
    const T = this.T, n = lines.length;
    this.note.textContent = `${n} line${n === 1 ? '' : 's'} for ${T} messages, ${sizeOf(lines).toLocaleString()} of ${room.toLocaleString()} bytes. `
      + (n === T ? 'Room for every message\'s own line.' : n <= 2 ? 'As squeezed as it gets: zoom to read more.' : 'Old messages share lines; the latest have one each.');
    this.readLines.replaceChildren(list);
  }

  // Lines that open on click: two lines below, or at n = 1 the message itself. Lines are written in the background,
  // from the messages up: a pair merges once both halves are written.
  zoomable(lines) {
    return el('ul', {}, ...lines.map(({ id, n, text }) => {
      const waiting = unwritten({ text });
      const label = !waiting ? text : id + n > this.T ? `the last ${this.T - id} messages, waiting for more before they merge` : 'being written, from the messages up';
      const li = el('li', { className: waiting ? 'pending' : '', title: n > 1 ? `messages ${id} to ${id + n - 1}` : `message ${id}` }, el('small', { textContent: `${id}+${n}` }), label);
      li.onclick = async (e) => {
        e.stopPropagation();
        const shown = li.querySelector('ul, .whole');
        if (shown) return shown.remove();
        li.classList.add('opening');
        const opened = await this.api(`/api/threads/${this.thread}/memory?zoom=${id},${n}`).finally(() => li.classList.remove('opening'));
        li.append(opened.message !== undefined ? el('div', { className: 'whole', textContent: opened.message }) : this.zoomable(opened.lines));
      };
      return li;
    }));
  }
}
customElements.define('agent-memory', AgentMemory);
