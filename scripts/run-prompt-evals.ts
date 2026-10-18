import process from 'node:process';
import { parseArgs } from 'node:util';
import fixtureData from '../tests/evals/transit-prompts.json';

export interface PromptFixture {
  id: string;
  prompt: string;
  call: { name: string; arguments: Record<string, unknown> };
  expected: { tool: string; status?: string; reason?: string; errorCode?: string; collection?: string; minimumItems?: number; agencyText?: boolean; futureWindow?: boolean };
  fixtureResult: Record<string, unknown>;
}
export interface Observation { tool: string; result: unknown }
export const promptFixtures: PromptFixture[] = fixtureData;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const evalLimitations = [
  'Synthetic deterministic scenarios only. Fixture mode tests the evaluator against illustrative partial responses, not a running transit server.',
  'Tool selection accuracy is agreement of the supplied/scripted tool trace with the expected tool, not model-selection accuracy. No LLM is invoked.',
  'Endpoint mode replays fixed read-only calls using MCP 2026-07-28 JSON transport. It needs matching synthetic data and a controlled clock; public deployments may correctly fail fixture-specific expectations.',
  'These checks are not full output-schema, routing, provenance-authenticity or natural-language safety validation. Injection checks cover labelled inert agency text, not model obedience.',
];

/** Deterministic assertions; reports contain case IDs and fixed reason codes only. */
export function evaluatePrompt(fixture: PromptFixture, observation: Observation) {
  const failures: string[] = [], expected = fixture.expected, result = object(observation.result);
  if (observation.tool !== expected.tool) failures.push('TOOL_SELECTION');
  if (expected.errorCode) {
    if (result.code !== expected.errorCode) failures.push('ERROR_CODE');
    if (!Array.isArray(result.candidates) || result.candidates.length < 2) failures.push('AMBIGUITY_CANDIDATES');
  } else {
    if (result.status !== expected.status) failures.push('STATUS');
    if (typeof result.asOf !== 'string' || !Number.isFinite(Date.parse(result.asOf)) || !Array.isArray(result.sources)) failures.push('PROVENANCE');
    if (expected.reason && (!Array.isArray(result.reasons) || !result.reasons.includes(expected.reason))) failures.push('REASON');
    const items = expected.collection ? result[expected.collection] : undefined;
    if (expected.collection && (!Array.isArray(items) || items.length < (expected.minimumItems ?? 0))) failures.push('RESULT_COLLECTION');
    if (result.status === 'unavailable' && ['itineraries', 'departures', 'vehicles'].some(key => Array.isArray(result[key]) && result[key].length > 0)) failures.push('NONEMPTY_UNAVAILABLE');
    if (Array.isArray(result.itineraries) && result.itineraries.some(item => {
      const legs = object(item).legs;
      return !Array.isArray(legs) || legs.length === 0 || legs.some(leg => object(leg).validatorOutcome !== 'valid');
    })) failures.push('UNVALIDATED_ITINERARY');
    if (result.status === 'scheduled_only' && Array.isArray(result.departures) && result.departures.some(item => object(item).status !== 'scheduled_only' || object(item).predictedTime !== null)) failures.push('UNVERIFIED_PREDICTION');
    if (expected.futureWindow && Array.isArray(result.departures)) {
      const start = Date.parse(String(fixture.call.arguments.at)), end = start + Number(fixture.call.arguments.windowSeconds) * 1000;
      if (result.departures.some(item => {
        const row = object(item), time = Date.parse(String(row.predictedTime ?? row.scheduledTime));
        return !Number.isFinite(time) || time < start || time >= end;
      })) failures.push('OUTSIDE_FUTURE_WINDOW');
    }
    if (expected.agencyText && (!Array.isArray(result.alerts) || result.alerts.some(alert => {
      const text = object(object(alert).agencyText);
      return text.label !== 'agency_supplied' || typeof text.title !== 'string' || typeof text.description !== 'string'
        || /[<>\u0000-\u001f\u007f]/.test(text.title + text.description);
    }))) failures.push('UNTRUSTED_AGENCY_TEXT');
  }
  return { id: fixture.id, passed: failures.length === 0, failures };
}

type Runner = (fixture: PromptFixture) => Promise<Observation>;
export async function runPromptEvals(fixtures: PromptFixture[], runner: Runner, mode: 'fixture' | 'endpoint') {
  const cases = [];
  let selections = 0;
  for (const fixture of fixtures) {
    try {
      const observation = await runner(fixture);
      if (observation.tool === fixture.expected.tool) selections++;
      cases.push(evaluatePrompt(fixture, observation));
    } catch {
      cases.push({ id: fixture.id, passed: false, failures: ['TRANSPORT_OR_PROTOCOL_ERROR'] });
    }
  }
  const passed = cases.filter(result => result.passed).length;
  return { mode, passed, failed: cases.length - passed, toolSelectionAccuracy: fixtures.length ? selections / fixtures.length : null, cases, limitations: evalLimitations };
}

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
export function endpointRunner(endpoint: string, fetcher: Fetcher = fetch): Runner {
  const url = new URL(endpoint);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/mcp'
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Supply an explicit HTTPS /mcp endpoint or local HTTP /mcp endpoint without credentials');
  return async fixture => {
    // Only checked-in calls can reach the endpoint; prompts and provider text are never sent as instructions.
    if (!promptFixtures.includes(fixture)) throw new Error('Only built-in synthetic cases may be sent');
    const response = await fetcher(url.href, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': fixture.call.name },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: fixture.call.name, arguments: fixture.call.arguments,
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: 'transit-prompt-evals', version: '1' } },
      } }),
    });
    if (!response.ok) throw new Error('Endpoint request failed');
    const envelope = object(await response.json());
    if (envelope.jsonrpc !== '2.0' || envelope.id !== 1 || envelope.error || !envelope.result) throw new Error('Invalid protocol response');
    const result = object(envelope.result);
    let data = result.structuredContent;
    if (data === undefined && Array.isArray(result.content)) {
      const texts = result.content.filter(item => object(item).type === 'text');
      if (texts.length === 1 && typeof object(texts[0]).text === 'string') data = JSON.parse(object(texts[0]).text as string);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Missing tool data');
    // Successful assertions must not turn a tool error into a passing transit answer.
    if (Boolean(result.isError) !== Boolean(fixture.expected.errorCode)) throw new Error('Unexpected tool outcome');
    return { tool: fixture.call.name, result: data };
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { endpoint: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } } });
  if (values.endpoint && values['dry-run']) throw new Error('Conflicting modes');
  const mode = values.endpoint ? 'endpoint' : 'fixture';
  const runner: Runner = values.endpoint ? endpointRunner(values.endpoint) : async fixture => ({ tool: fixture.call.name, result: fixture.fixtureResult });
  const report = await runPromptEvals(promptFixtures, runner, mode);
  console.info(JSON.stringify(report, null, 2));
  if (report.failed) process.exitCode = 1;
}
if ((import.meta as ImportMeta & { main?: boolean }).main) {
  main().catch(() => { console.error('Prompt evaluation failed. Check the explicit /mcp endpoint and CLI options. Raw errors are suppressed.'); process.exitCode = 1; });
}
