// What agents spent, from Pi's own ledger: `pi.usage` on each agent's conversation, which a fork starts empty, so a
// fork's agents count only what they spent since. GET /api/usage gives every shown thread's; GET /api/threads/:id/usage
// one thread's. Memory's line requests have no conversation, so they don't count.
import { UsageDoc } from '@earendil-works/pi-durable';

const empty = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
function add(sum, u) {
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) sum[key] += u[key] ?? 0;
  sum.cost += typeof u.cost === 'number' ? u.cost : u.cost?.total ?? 0;
  return sum;
}

export function server({ conversation, thread, threadList, snapshot }) {
  // Each agent's spend by model, `provider/id` as the model reported itself, and its tools'.
  async function spent(id, row) {
    const agents = await Promise.all(Object.entries(row.agents).map(async ([name, conversation]) => {
      const ledger = (await snapshot(UsageDoc, conversation)) ?? { models: {}, tools: {} };
      const models = Object.fromEntries(Object.entries(ledger.models).map(([key, u]) => [key, add(empty(), u)]));
      const total = [...Object.values(ledger.models), ...Object.values(ledger.tools)].reduce(add, empty());
      return { name, conversation, models, total };
    }));
    return { id, title: row.title, parent: row.parent, agents, total: agents.map((a) => a.total).reduce(add, empty()) };
  }
  async function serve(id) {
    if (id !== null) return (await conversation(id), spent(id, await thread(id)));
    const threads = await Promise.all((await threadList()).map(async ({ id }) => spent(id, await thread(id))));
    return { threads, total: threads.map((t) => t.total).reduce(add, empty()) };
  }
  return { serve };
}
