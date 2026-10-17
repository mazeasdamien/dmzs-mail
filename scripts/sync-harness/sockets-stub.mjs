export function connect(addr, opts) {
  return globalThis.__fakeConnect(addr, opts);
}
