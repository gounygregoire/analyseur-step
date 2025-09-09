// Simple publish/subscribe bus sans dépendances externes
// Usage: import bus from "./events-bus.js";
//        const unsubscribe = bus.subscribe('foo', payload => ...);
//        bus.publish('foo', data);

export function createEventBus() {
  const listeners = new Map();

  return {
    subscribe(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
      return () => listeners.get(event)?.delete(handler);
    },
    publish(event, payload) {
      listeners.get(event)?.forEach((handler) => handler(payload));
    },
    unsubscribe(event, handler) {
      listeners.get(event)?.delete(handler);
    }
  };
}

const eventBus = createEventBus();
export default eventBus;

