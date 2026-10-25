// A module exports `server(core)` and/or `runner(core)`, which return its hooks:
//   server: extension, route(posted, agents) → To[], reply(posts, answeredIn, agent, body) → [{ thread, data }], changed(),
//           posted(tx, threadId, entry): work added to a post's commit, writes only,
//           catchUp(threadId, held, all, agent) → the content of a Deliver task's input to that agent's conversation,
//           serve(threadId, query) → what GET /api/threads/:id/<module name> answers
//   runner: told(message), disconnected(), ops: { [op]: (message, context) → what the runner answers the server's call }
export async function load(end, defaults, core) {
  const on = Object.keys(defaults).filter((name) => {
    const value = process.env[name.toUpperCase()];
    return value ? value !== '0' : defaults[name];
  });
  const modules = [];
  for (const name of on) {
    const make = (await import(`./${name}.js`))[end];
    if (make) modules.push({ name, ...await make(core) });
  }
  return modules;
}
