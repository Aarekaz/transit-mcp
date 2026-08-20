import {
  AppBridge,
  PostMessageTransport,
  type McpUiDisplayMode,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps/app-bridge';
import {
  TOOL_CASES,
  TOOL_NAMES,
  resultFor,
  type FixtureState,
  type ToolName,
} from './fixtures';

type ToolCallRecord = {
  name: string;
  arguments?: Record<string, unknown>;
};

type DeliveryRecord = {
  method: string;
  params: unknown;
};

type ProtocolRecord = {
  direction: 'app-to-host' | 'host-to-app';
  kind: 'request' | 'notification' | 'success-response' | 'error-response' | 'malformed';
  sequence: number;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

type PendingProtocolRequest = {
  direction: ProtocolRecord['direction'];
  sequence: number;
  id: string | number;
  method: string;
};

type ProtocolViolation = {
  kind: 'unsolicited-response' | 'duplicate-response' | 'mismatched-response' | 'malformed';
  direction: ProtocolRecord['direction'];
  sequence: number;
  id?: unknown;
};

type HarnessRecords = {
  calls: ToolCallRecord[];
  deliveries: DeliveryRecord[];
  displayRequests: string[];
  sizeChanges: { width?: number; height?: number }[];
};

type HarnessSnapshot = HarnessRecords & {
  tool: ToolName;
  state: FixtureState;
  protocol: ProtocolRecord[];
  unexpectedProtocol: string[];
  bridgeEvents: { name: string; sequence: number }[];
  protocolViolations: ProtocolViolation[];
  pendingProtocol: PendingProtocolRequest[];
};

const required = <ElementType extends Element>(selector: string): ElementType => {
  const node = document.querySelector<ElementType>(selector);
  if (!node) throw new Error(`Missing host control: ${selector}`);
  return node;
};

const frame = required<HTMLIFrameElement>('#app-frame');
const toolControl = required<HTMLSelectElement>('#tool-control');
const stateControl = required<HTMLSelectElement>('#state-control');
const themeControl = required<HTMLSelectElement>('#theme-control');
const displayControl = required<HTMLSelectElement>('#display-control');
const safeAreaControl = required<HTMLSelectElement>('#safe-area-control');
const widthControl = required<HTMLSelectElement>('#width-control');
const hostStatus = required<HTMLElement>('#host-status');

let activeBridge: AppBridge | null = null;
let mountSequence = 0;
let operation = Promise.resolve();
let records: HarnessRecords = freshRecords();
const protocol: ProtocolRecord[] = [];
const unexpectedProtocol: string[] = [];
const bridgeEvents: { name: string; sequence: number }[] = [];
const protocolViolations: ProtocolViolation[] = [];
const pendingProtocol: PendingProtocolRequest[] = [];
const completedProtocol: PendingProtocolRequest[] = [];
const frameSources = new Set<MessageEventSource>();
const frameSequences = new Map<MessageEventSource, number>();
const expectedInboundMethods = new Set([
  'ui/initialize',
  'ui/notifications/initialized',
  'ui/notifications/size-changed',
  'tools/call',
  'ui/request-display-mode',
]);

function freshRecords(): HarnessRecords {
  return {
    calls: [],
    deliveries: [],
    displayRequests: [],
    sizeChanges: [],
  };
}

function recordProtocol(
  direction: ProtocolRecord['direction'],
  sequence: number,
  message: unknown,
): void {
  const candidate = typeof message === 'object' && message !== null && !Array.isArray(message)
    ? message as Record<string, unknown>
    : {};
  const hasOnlyKeys = (...allowed: string[]): boolean => (
    Object.keys(candidate).every(key => allowed.includes(key))
  );
  const hasId = typeof candidate.id === 'string'
    || (typeof candidate.id === 'number' && Number.isInteger(candidate.id));
  const hasOptionalId = !('id' in candidate) || hasId;
  const hasParams = !('params' in candidate)
    || (typeof candidate.params === 'object' && candidate.params !== null && !Array.isArray(candidate.params));
  const base = { direction, sequence };
  let record: ProtocolRecord;

  if (candidate.jsonrpc === '2.0'
    && typeof candidate.method === 'string'
    && hasId
    && hasParams
    && hasOnlyKeys('jsonrpc', 'id', 'method', 'params')) {
    record = {
      ...base,
      kind: 'request',
      id: candidate.id,
      method: candidate.method,
      ...('params' in candidate ? { params: structuredClone(candidate.params) } : {}),
    };
  } else if (candidate.jsonrpc === '2.0'
    && typeof candidate.method === 'string'
    && !('id' in candidate)
    && hasParams
    && hasOnlyKeys('jsonrpc', 'method', 'params')) {
    record = {
      ...base,
      kind: 'notification',
      method: candidate.method,
      ...('params' in candidate ? { params: structuredClone(candidate.params) } : {}),
    };
  } else if (candidate.jsonrpc === '2.0'
    && hasId
    && typeof candidate.result === 'object'
    && candidate.result !== null
    && !Array.isArray(candidate.result)
    && hasOnlyKeys('jsonrpc', 'id', 'result')) {
    record = {
      ...base,
      kind: 'success-response',
      id: candidate.id,
      result: structuredClone(candidate.result),
    };
  } else if (candidate.jsonrpc === '2.0'
    && hasOptionalId
    && typeof candidate.error === 'object'
    && candidate.error !== null
    && !Array.isArray(candidate.error)
    && Number.isInteger((candidate.error as Record<string, unknown>).code)
    && typeof (candidate.error as Record<string, unknown>).message === 'string'
    && hasOnlyKeys('jsonrpc', 'id', 'error')) {
    record = {
      ...base,
      kind: 'error-response',
      id: candidate.id,
      error: structuredClone(candidate.error),
    };
  } else {
    record = {
      ...base,
      kind: 'malformed',
      ...('id' in candidate ? { id: structuredClone(candidate.id) } : {}),
      ...('method' in candidate ? { method: structuredClone(candidate.method) } : {}),
      ...('params' in candidate ? { params: structuredClone(candidate.params) } : {}),
      ...('result' in candidate ? { result: structuredClone(candidate.result) } : {}),
      ...('error' in candidate ? { error: structuredClone(candidate.error) } : {}),
    };
  }
  protocol.push(record);

  if (record.kind === 'malformed') {
    protocolViolations.push({
      kind: 'malformed',
      direction,
      sequence,
      ...('id' in record ? { id: record.id } : {}),
    });
    return;
  }
  if (record.kind === 'request') {
    pendingProtocol.push({
      direction,
      sequence,
      id: record.id as string | number,
      method: record.method as string,
    });
  } else if (record.kind === 'success-response' || record.kind === 'error-response') {
    const responseId = record.id;
    const oppositeDirection = direction === 'app-to-host' ? 'host-to-app' : 'app-to-host';
    const pendingIndex = (typeof responseId === 'string' || typeof responseId === 'number')
      ? pendingProtocol.findIndex(request => (
        request.direction === oppositeDirection
        && request.sequence === sequence
        && request.id === responseId
      ))
      : -1;
    if (pendingIndex >= 0) {
      const [completed] = pendingProtocol.splice(pendingIndex, 1);
      if (completed) completedProtocol.push(completed);
    } else {
      const duplicate = (typeof responseId === 'string' || typeof responseId === 'number')
        && completedProtocol.some(request => (
        request.direction === oppositeDirection
        && request.sequence === sequence
        && request.id === responseId
      ));
      const mismatched = (typeof responseId === 'string' || typeof responseId === 'number')
        && (pendingProtocol.some(request => request.id === responseId)
          || completedProtocol.some(request => request.id === responseId));
      protocolViolations.push({
        kind: duplicate
          ? 'duplicate-response'
          : mismatched
            ? 'mismatched-response'
            : 'unsolicited-response',
        direction,
        sequence,
        ...(typeof responseId === 'string' || typeof responseId === 'number'
          ? { id: responseId }
          : {}),
      });
    }
  }
  if (direction === 'app-to-host'
    && (record.kind === 'request' || record.kind === 'notification')
    && !expectedInboundMethods.has(record.method as string)) {
    unexpectedProtocol.push(record.method as string);
  }
}

window.addEventListener('message', event => {
  if (!event.source || !frameSources.has(event.source)) return;
  recordProtocol(
    'app-to-host',
    frameSequences.get(event.source) ?? mountSequence,
    event.data,
  );
});

function isToolName(value: string): value is ToolName {
  return TOOL_NAMES.some(toolName => toolName === value);
}

function selectedTool(): ToolName {
  const value = toolControl.value;
  if (!isToolName(value)) {
    throw new Error(`Unsupported local fixture tool: ${value}`);
  }
  return value;
}

function selectedState(): FixtureState {
  const value = stateControl.value;
  if (value === 'ready' || value === 'empty' || value === 'error' || value === 'hostile') {
    return value;
  }
  throw new Error(`Unsupported local fixture state: ${value}`);
}

function selectedDisplayMode(): McpUiDisplayMode {
  return displayControl.value === 'fullscreen' ? 'fullscreen' : 'inline';
}

function hostVariables(theme: 'light' | 'dark'): Record<string, string> {
  if (theme === 'dark') {
    return {
      '--color-background-primary': 'color-mix(in oklab, oklch(0.19 0.015 84) 92%, oklch(0.3 0.04 65))',
      '--color-background-secondary': 'oklch(0.25 0.015 84)',
      '--color-text-primary': 'oklch(0.94 0.012 88)',
      '--color-text-secondary': 'oklch(0.72 0.02 88)',
      '--color-text-info': 'oklch(0.78 0.12 78)',
      '--color-border-primary': 'oklch(0.42 0.02 84)',
      '--color-ring-primary': 'oklch(0.84 0.16 83)',
      '--font-sans': '-apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", sans-serif',
    };
  }
  return {
    '--color-background-primary': 'color-mix(in oklab, oklch(0.97 0.01 90) 94%, oklch(0.76 0.05 160))',
    '--color-background-secondary': 'oklch(0.985 0.008 91)',
    '--color-text-primary': 'oklch(0.22 0.02 82)',
    '--color-text-secondary': 'oklch(0.45 0.025 82)',
    '--color-text-info': 'oklch(0.46 0.11 61)',
    '--color-border-primary': 'oklch(0.78 0.02 84)',
    '--color-ring-primary': 'oklch(0.5 0.16 55)',
    '--font-sans': '-apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", sans-serif',
  };
}

function completeHostContext(toolName: ToolName, requestId: string): McpUiHostContext {
  const theme = themeControl.value === 'dark' ? 'dark' : 'light';
  const width = Number(widthControl.value);
  return {
    toolInfo: {
      id: requestId,
      tool: {
        name: toolName,
        inputSchema: { type: 'object' },
      },
    },
    theme,
    styles: {
      variables: hostVariables(theme),
    } as McpUiHostContext['styles'],
    displayMode: selectedDisplayMode(),
    availableDisplayModes: ['inline', 'fullscreen'],
    containerDimensions: { width, maxHeight: 1_200 },
    locale: 'en-US',
    timeZone: 'America/New_York',
    userAgent: 'metro-mcp-apps-reference-host/1.0.0',
    platform: width === 320 ? 'mobile' : 'web',
    deviceCapabilities: { touch: false, hover: true },
    safeAreaInsets: safeAreaControl.value === 'on'
      ? { top: 12, right: 16, bottom: 20, left: 24 }
      : { top: 0, right: 0, bottom: 0, left: 0 },
  };
}

function applyHostChrome(): void {
  const theme = themeControl.value === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.hostTheme = theme;
  frame.style.width = `${Number(widthControl.value)}px`;
}

async function closeActiveBridge(): Promise<void> {
  const bridge = activeBridge;
  activeBridge = null;
  if (!bridge) return;
  try {
    await bridge.teardownResource({});
  } catch {
    // A replaced fixture may already have completed its teardown.
  }
  try {
    await bridge.close();
  } catch {
    // Closing is idempotent from the harness perspective.
  }
}

function navigateFrame(url: string): Promise<void> {
  return new Promise(resolve => {
    frame.addEventListener('load', () => resolve(), { once: true });
    frame.src = url;
  });
}

async function mountScenario(
  sequence: number,
  toolName: ToolName,
  state: FixtureState,
): Promise<void> {
  await closeActiveBridge();
  await navigateFrame('about:blank');
  applyHostChrome();
  records = freshRecords();

  const requestId = `fixture-${sequence}`;
  const initialContext = completeHostContext(toolName, requestId);
  records.deliveries.push({ method: 'ui/initialize:host-context', params: initialContext });
  const bridge = new AppBridge(
    null,
    { name: 'Metro MCP Apps Test Host', version: '1.0.0' },
    {
      serverTools: {},
      sandbox: {
        permissions: {},
        csp: {
          connectDomains: [],
          resourceDomains: [],
          frameDomains: [],
          baseUriDomains: [],
        },
      },
    },
    { hostContext: initialContext },
  );
  activeBridge = bridge;
  bridge.onerror = () => {
    bridgeEvents.push({ name: 'error', sequence });
  };

  bridge.oncalltool = async params => {
    const calledTool = params.name;
    const calledArguments = params.arguments === undefined
      ? undefined
      : structuredClone(params.arguments);
    records.calls.push({
      name: calledTool,
      ...(calledArguments === undefined ? {} : { arguments: calledArguments }),
    });
    if (!isToolName(calledTool)) {
      unexpectedProtocol.push(`tools/call:${calledTool}`);
      return {
        content: [{ type: 'text', text: 'Unsupported local fixture tool.' }],
        isError: true,
      };
    }
    return structuredClone(resultFor(calledTool, state));
  };

  bridge.onrequestdisplaymode = async ({ mode }) => {
    records.displayRequests.push(mode);
    const accepted = mode === 'fullscreen' || mode === 'inline'
      ? mode
      : selectedDisplayMode();
    displayControl.value = accepted;
    applyHostChrome();
    bridge.setHostContext(completeHostContext(toolName, requestId));
    return { mode: accepted };
  };

  bridge.addEventListener('sizechange', change => {
    records.sizeChanges.push(structuredClone(change));
    if (typeof change.height === 'number' && Number.isFinite(change.height)) {
      frame.style.height = `${Math.min(2_000, Math.max(256, Math.ceil(change.height)))}px`;
    }
  });
  bridge.addEventListener('requestteardown', () => {
    unexpectedProtocol.push('ui/notifications/request-teardown');
  });
  bridge.addEventListener('loggingmessage', () => {
    unexpectedProtocol.push('notifications/message');
  });
  bridge.addEventListener('sandboxready', () => {
    bridgeEvents.push({ name: 'sandboxready', sequence });
  });

  const initialized = new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error('Transit Board did not complete the Apps initialization handshake.'));
    }, 8_000);
    bridge.addEventListener('initialized', () => {
      void (async () => {
        const input = { arguments: structuredClone(TOOL_CASES[toolName].input) };
        const result = structuredClone(resultFor(toolName, state));
        records.deliveries.push({ method: 'ui/notifications/tool-input', params: input });
        await bridge.sendToolInput(input);
        records.deliveries.push({ method: 'ui/notifications/tool-result', params: result });
        await bridge.sendToolResult(result);
        window.clearTimeout(timeout);
        resolve();
      })().catch(reject);
    });
  });

  const target = frame.contentWindow;
  if (!target) throw new Error('Sandbox frame window is unavailable.');
  frameSources.add(target);
  frameSequences.set(target, sequence);
  const transport = new PostMessageTransport(target, target);
  const send = transport.send.bind(transport);
  transport.send = async (message, options) => {
    recordProtocol('host-to-app', sequence, message);
    await send(message, options);
  };
  await bridge.connect(transport);
  const resource = frame.dataset.resource;
  if (resource !== '/apps/transit-board.html') {
    throw new Error('Sandbox resource path is invalid.');
  }
  void navigateFrame(`${resource}?fixture=${sequence}`);
  await initialized;

  if (sequence === mountSequence) {
    hostStatus.dataset.scenario = `${toolName}:${state}`;
    hostStatus.dataset.ready = 'true';
    hostStatus.textContent = 'Fixture delivered.';
  }
}

function requestMount(): void {
  const sequence = ++mountSequence;
  const toolName = selectedTool();
  const state = selectedState();
  hostStatus.dataset.ready = 'false';
  hostStatus.dataset.scenario = '';
  hostStatus.textContent = 'Preparing fixture.';
  operation = operation
    .catch(() => undefined)
    .then(() => mountScenario(sequence, toolName, state))
    .catch(error => {
      if (sequence === mountSequence) {
        hostStatus.dataset.ready = 'error';
        hostStatus.dataset.scenario = `${toolName}:${state}`;
        hostStatus.textContent = error instanceof Error ? error.message : 'Host failed.';
      }
      throw error;
    });
}

function updateContext(): void {
  applyHostChrome();
  const bridge = activeBridge;
  if (!bridge) return;
  bridge.setHostContext(
    completeHostContext(selectedTool(), `fixture-${mountSequence}`),
  );
}

toolControl.addEventListener('change', requestMount);
stateControl.addEventListener('change', requestMount);
themeControl.addEventListener('change', updateContext);
displayControl.addEventListener('change', updateContext);
safeAreaControl.addEventListener('change', updateContext);
widthControl.addEventListener('change', updateContext);

window.addEventListener('pagehide', () => {
  void closeActiveBridge();
});

Object.defineProperty(window, '__metroAppsHarness', {
  value: {
    snapshot(): HarnessSnapshot {
      return structuredClone({
        tool: selectedTool(),
        state: selectedState(),
        ...records,
        protocol,
        unexpectedProtocol,
        bridgeEvents,
        protocolViolations,
        pendingProtocol,
      });
    },
    async teardownActive(): Promise<void> {
      if (!activeBridge) throw new Error('No active Apps bridge is available.');
      await activeBridge.teardownResource({});
    },
    async closeActiveForProbe(): Promise<void> {
      await closeActiveBridge();
    },
  },
});

requestMount();

declare global {
  interface Window {
    __metroAppsHarness: {
      snapshot(): HarnessSnapshot;
      teardownActive(): Promise<void>;
      closeActiveForProbe(): Promise<void>;
    };
  }
}
