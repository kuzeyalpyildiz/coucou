// A stand-in for the object Tauri injects into the webview. The island talks to
// Rust through it, so the tests see every command the island sends and can fire
// the events Rust would emit — through the real bridge, with no source changes.

/** Every command the island invoked, oldest first: [name, args]. */
export const calls = [];

const listeners = new Map();
let nextListenerId = 1;

export const eventInternals = {
  unregisterListener: (event, id) => {
    if (listeners.get(event)?.id === id) listeners.delete(event);
  },
};

export const internals = {
  transformCallback: (callback) => callback,
  invoke: async (cmd, args) => {
    if (cmd === "plugin:event|listen") {
      const id = nextListenerId++;
      listeners.set(args.event, { handler: args.handler, id });
      return id;
    }
    if (cmd === "plugin:event|unlisten") return;
    calls.push([cmd, args]);
    return null;
  },
};

/** Fires an event the way the Rust side would. */
export function emit(event, payload) {
  const listener = listeners.get(event);
  if (!listener) throw new Error(`nothing listens to "${event}"`);
  listener.handler({ event, id: listener.id, payload });
}

/** The commands invoked under one name, as a list of their arguments. */
export function sent(cmd) {
  return calls.filter(([name]) => name === cmd).map(([, args]) => args);
}
