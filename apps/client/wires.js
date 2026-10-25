// Wires between elements: wires(container).draw([{from, to, fromSide?, toSide?, fromAt?, toAt?, className?}]) replaces them all,
// and they follow along on resize, scroll and layout changes.
// Offsets: 0..1 is a fraction, other numbers are pixels (negative from the end); fromAt: 'to' aligns with the target.
export function wires(container) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), position = container.style.position;
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  svg.setAttribute('class', 'wires');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible;fill:none';
  container.prepend(svg);
  let edges = [], frame = 0, observed = new Set();
  const directions = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };
  const point = (r, side, at = .5) => {
    const horizontal = side === 'left' || side === 'right', size = horizontal ? r.height : r.width;
    const offset = at === 'to' ? size / 2 : at >= 0 && at <= 1 ? at * size : at < 0 ? size + at : at;
    return horizontal ? [side === 'left' ? r.left : r.right, r.top + offset] : [r.left + offset, side === 'top' ? r.top : r.bottom];
  };
  // Intersect every clipping ancestor, including nested scrolling lists.
  const visible = (node) => {
    if (!node?.isConnected) return false;
    let { left, right, top, bottom, width, height } = node.getBoundingClientRect();
    if (!width || !height) return false;
    for (let p = node.parentElement; p; p = p.parentElement) {
      const style = getComputedStyle(p), r = p.getBoundingClientRect();
      if (style.overflowX !== 'visible') { left = Math.max(left, r.left + p.clientLeft); right = Math.min(right, r.left + p.clientLeft + p.clientWidth); }
      if (style.overflowY !== 'visible') { top = Math.max(top, r.top + p.clientTop); bottom = Math.min(bottom, r.top + p.clientTop + p.clientHeight); }
    }
    return right > left && bottom > top;
  };
  const redraw = () => {
    frame = 0;
    const origin = svg.getBoundingClientRect(), paths = [];
    for (const edge of edges) {
      if (!visible(edge.from) || !visible(edge.to)) continue;
      const a = edge.from.getBoundingClientRect(), b = edge.to.getBoundingClientRect();
      const dx = b.left + b.width / 2 - a.left - a.width / 2, dy = b.top + b.height / 2 - a.top - a.height / 2;
      const horizontal = Math.abs(dx) / (a.width + b.width) >= Math.abs(dy) / (a.height + b.height);
      const fromSide = edge.fromSide ?? (horizontal ? dx >= 0 ? 'right' : 'left' : dy >= 0 ? 'bottom' : 'top');
      const toSide = edge.toSide ?? (horizontal ? dx >= 0 ? 'left' : 'right' : dy >= 0 ? 'top' : 'bottom');
      const start = point(a, fromSide, edge.fromAt), end = point(b, toSide, edge.toAt);
      if (edge.fromAt === 'to') start[fromSide === 'left' || fromSide === 'right' ? 1 : 0] = end[fromSide === 'left' || fromSide === 'right' ? 1 : 0];
      const control = (p, side) => directions[side].map((d, i) => p[i] + d * Math.max(12, Math.abs(end[i] - start[i]) / 2));
      const coords = (p) => `${p[0] - origin.left},${p[1] - origin.top}`;
      const path = document.createElementNS(svg.namespaceURI, 'path');
      path.setAttribute('d', `M${coords(start)} C${coords(control(start, fromSide))} ${coords(control(end, toSide))} ${coords(end)}`);
      if (edge.className) path.setAttribute('class', edge.className);
      paths.push(path);
    }
    svg.replaceChildren(...paths);
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(redraw); };
  const observer = new ResizeObserver(schedule);
  const changes = new MutationObserver((records) => { if (records.some(({ target }) => !svg.contains(target))) schedule(); });
  changes.observe(container, { subtree: true, childList: true, attributes: true, characterData: true });
  addEventListener('resize', schedule);
  document.addEventListener('scroll', schedule, true);
  return {
    draw(next) {
      edges = next;
      const nodes = new Set([container]);
      for (const { from, to } of edges) for (let node of [from, to]) for (; node; node = node.parentElement) nodes.add(node);
      for (const node of observed) if (!nodes.has(node)) observer.unobserve(node);
      for (const node of nodes) if (!observed.has(node)) observer.observe(node);
      observed = nodes;
      schedule();
    },
    destroy() {
      cancelAnimationFrame(frame);
      observer.disconnect();
      changes.disconnect();
      removeEventListener('resize', schedule);
      document.removeEventListener('scroll', schedule, true);
      svg.remove();
      container.style.position = position;
    },
  };
}
