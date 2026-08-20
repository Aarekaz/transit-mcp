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
  method: string;
  sequence: number;
  params?: unknown;
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
  if (typeof message !== 'object' || message === null) return;
  const candidate = message as { jsonrpc?: unknown; method?: unknown; params?: unknown };
  if (candidate.jsonrpc !== '2.0' || typeof candidate.method !== 'string') return;
  protocol.push({
    direction,
    method: candidate.method,
    sequence,
    ...('params' in candidate ? { params: structuredClone(candidate.params) } : {}),
  });
  if (direction === 'app-to-host' && !expectedInboundMethods.has(candidate.method)) {
    unexpectedProtocol.push(candidate.method);
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
      });
    },
  },
});

requestMount();

declare global {
  interface Window {
    __metroAppsHarness: {
      snapshot(): HarnessSnapshot;
    };
  }
}
