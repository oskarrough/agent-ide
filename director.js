// The director, for multiplayer threads: an entry is answered only by an agent it @mentions, so humans can talk among
// themselves and call in whoever they need. Off by default; DIRECTOR=1 turns it on.
// Its one hook, route, gets the entry and the thread's past inputs and returns who answers: the first agent mentioned,
// as @gpt-6.1-sol@laptop, @gpt-6.1-sol or @laptop, among those the thread has asked; else the entry's own `to`, or nobody.
export const server = () => ({ route });

function route({ body, to }, asked) {
  const agents = new Map();
  for (const input of asked.toReversed()) {
    if (!input.to) continue;
    const model = input.to.model.split('/').pop();
    for (const name of [`${model}@${input.to.runner}`, model, input.to.runner]) if (!agents.has(name)) agents.set(name, input.to);
  }
  for (const [, name] of body.matchAll(/@([\w.-]+(?:@[\w.-]+)?)/g)) {
    const agent = agents.get(name.replace(/\.+$/, ''));
    if (agent) return agent;
  }
  return to;
}
