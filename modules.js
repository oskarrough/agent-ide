// A module exports `server(core)` and/or `runner(core)`, which return its hooks:
//   server: extension, route(posted, agents) → To[], reply(posts, answeredIn, agent, body) → [{ thread, data }], changed(),
//           posted(tx, threadId, entry): work added to a post's commit, writes only,
//           catchUp(threadId, held, all) → the content of a Deliver task's input
//   runner: told(message), disconnected()
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
