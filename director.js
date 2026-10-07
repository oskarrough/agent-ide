// The director, for multiplayer threads: an entry only gets an answer when it says who should give it.
// The server loads it with DIRECTOR=1. Without it, an entry with no `to` goes to the thread's agent.
//
// An agent is a model on a runner, named like gpt-6.1-sol@laptop. @gpt-6.1-sol@laptop, @gpt-6.1-sol or @laptop picks
// one the thread has asked before. A mention beats the `to`, so humans can talk among themselves and call in whoever they need.
export function route(posted, asked) {
  const agents = new Map();
  for (const { to } of asked) if (to) agents.set(`${to.model.split('/').pop()}@${to.runner}`, to);
  const named = [...agents].reverse();
  const mentioned = (name) => new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w@.-])`).test(posted.body);
  for (const part of [(name) => name, (name) => name.split('@')[0], (name) => name.split('@')[1]]) {
    const found = named.find(([name]) => mentioned(part(name)));
    if (found) return found[1];
  }
  return posted.to;
}
