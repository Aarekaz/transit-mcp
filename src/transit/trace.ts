import { AsyncLocalStorage } from 'node:async_hooks';

/** Where one tool call spends its time, logged as a single `tool_timing` line. Workers
 * clocks advance only across I/O, so phases measure storage and coordinator waits; the
 * remainder of the call is computation. Counts record reads, bytes and decodes. */
interface Trace { phases: Record<string, number>; counts: Record<string, number> }
const traces = new AsyncLocalStorage<Trace>();
/** Which isolate served the call and how many it has served: caches only help a reused isolate. */
const isolate = Math.random().toString(36).slice(2, 8);
let served = 0;

export async function traced<T>(tool: string, run: () => Promise<T>): Promise<T> {
  const trace: Trace = { phases: {}, counts: {} }, started = Date.now(), call = ++served;
  try { return await traces.run(trace, run); }
  finally {
    console.info(JSON.stringify({ event: 'tool_timing', tool, isolate, call, ms: Date.now() - started, ...Object.fromEntries(Object.entries(trace.phases).map(([name, ms]) => [`${name}Ms`, ms])), ...trace.counts }));
  }
}

export async function phase<T>(name: string, run: () => Promise<T>): Promise<T> {
  const trace = traces.getStore();
  if (!trace) return run();
  const started = Date.now();
  try { return await run(); } finally { trace.phases[name] = (trace.phases[name] ?? 0) + Date.now() - started; }
}

export function count(name: string, amount = 1): void {
  const trace = traces.getStore();
  if (trace) trace.counts[name] = (trace.counts[name] ?? 0) + amount;
}
