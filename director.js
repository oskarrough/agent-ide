// Whom a message asks: every agent of the thread it @mentions (as @openai/gpt-6.1-sol@laptop, @gpt-6.1-sol@laptop,
// @gpt-6.1-sol or @laptop); else its own `to`, or nobody.
export const server = () => ({ route });

function route({ body, to }, agents) {
  const named = new Map();
  for (const agent of agents) {
    const id = agent.model.slice(agent.model.indexOf('/') + 1);
    for (const name of [`${agent.model}@${agent.runner}`, `${id}@${agent.runner}`, id, agent.runner]) if (!named.has(name)) named.set(name, agent);
  }
  const picked = [...body.matchAll(/@([\w./-]+(?:@[\w.-]+)?)/g)].map(([, name]) => named.get(name.replace(/\.+$/, ''))).filter(Boolean);
  return picked.length ? [...new Set(picked)] : to;
}
