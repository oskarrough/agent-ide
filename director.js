// The director, for multiplayer threads: an entry only gets an answer when it says who should give it.
// The server loads it with DIRECTOR=1. Without it, an entry with no `to` goes to the thread's last agent.
//
// @codex@laptop, or just @codex, picks an agent that has been asked in this thread before. A mention beats the `to`,
// so humans can talk among themselves and call in whoever they need.
export function route(posted, posts) {
  const agents = new Map();
  for (const post of posts) if (post.to) agents.set(`${post.to.harness}@${post.to.runner}`, post.to);
  const named = [...agents].reverse();
  const mention = (name) => new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w@.-])`).test(posted.body);
  return named.find(([name]) => mention(name))?.[1]
    ?? named.find(([name]) => mention(name.split('@')[0]))?.[1]
    ?? posted.to;
}
