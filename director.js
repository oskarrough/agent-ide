// The director, for multiplayer threads: an entry only gets an answer when it says who should give it.
// The server loads it with DIRECTOR=1. Without it, an entry's own `to` decides, and the client always fills one in.
//
// @codex@laptop, or just @codex, picks an agent that has answered in this thread before. A mention beats the `to`,
// so humans can talk among themselves and call in whoever they need.
export function route(posted, entries) {
  const agents = new Map();
  for (const e of entries) if (e.to) agents.set(`${e.to.harness}@${e.to.runner}`, e.to);
  const named = [...agents].reverse();
  const mention = (name) => new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w@.-])`).test(posted.body);
  return named.find(([name]) => mention(name))?.[1]
    ?? named.find(([name]) => mention(name.split('@')[0]))?.[1]
    ?? posted.to;
}
