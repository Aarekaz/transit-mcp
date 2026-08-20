// @vitest-environment happy-dom

import {
  App,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EXPECTED_TOOL_CONTRACTS } from '../fixtures/mcp-contracts';

type ToolInputHandler = NonNullable<App['ontoolinput']>;
type ToolResultHandler = NonNullable<App['ontoolresult']>;
type ToolCancelledHandler = NonNullable<App['ontoolcancelled']>;
type HostContextHandler = NonNullable<App['onhostcontextchanged']>;
type TeardownHandler = NonNullable<App['onteardown']>;
type CallToolParams = Parameters<App['callServerTool']>[0];
type ToolResult = Awaited<ReturnType<App['callServerTool']>>;

type TransitBoardController = {
  refresh(): Promise<void>;
  teardown(): Promise<void>;
};

type CreateTransitBoardApp = (dependencies: {
  app: FakeApp;
  transport: object;
  mount: HTMLElement;
  root?: HTMLElement;
  eventTarget?: Window;
}) => Promise<TransitBoardController>;

type LifecycleModule = {
  createTransitBoardApp?: CreateTransitBoardApp;
  createTransitBoardSdkApp?: () => App;
};

const completeContext = (
  name: string,
  context: Omit<McpUiHostContext, 'toolInfo'> = {},
): McpUiHostContext => ({
  ...context,
  toolInfo: {
    id: 'call-1',
    tool: {
      name,
      inputSchema: { type: 'object' },
    },
  },
});

class FakeApp {
  ontoolinput?: ToolInputHandler;
  ontoolresult?: ToolResultHandler;
  ontoolcancelled?: ToolCancelledHandler;
  onhostcontextchanged?: HostContextHandler;
  onteardown?: TeardownHandler;

  readonly calls: CallToolParams[] = [];
  readonly displayModeRequests: Array<{ mode: 'inline' | 'fullscreen' | 'pip' }> = [];
  connectedWith: object | undefined;
  transport: object | undefined;
  handlersAtConnect: Record<string, boolean> | undefined;
  closeCount = 0;
  readonly sizeChanges: Array<{ width?: number; height?: number }> = [];
  nextResult: ToolResult = {
    content: [{ type: 'text', text: '{}' }],
    structuredContent: {},
  };
  resultPromise: Promise<ToolResult> | undefined;
  displayModeResult: 'inline' | 'fullscreen' | 'pip' | undefined;
  callError: Error | undefined;
  duringConnect: ((app: FakeApp) => void) | undefined;
  connectPromise: Promise<void> | undefined;
  connectError: Error | undefined;
  contextError: Error | undefined;
  displayModePromise: Promise<{ mode: 'inline' | 'fullscreen' | 'pip' }> | undefined;
  inputDuringConnect: Parameters<ToolInputHandler>[0] | undefined;
  resultDuringConnect: Parameters<ToolResultHandler>[0] | undefined;

  constructor(private readonly initialContext: McpUiHostContext) {}

  async connect(transport: object): Promise<void> {
    this.connectedWith = transport;
    this.transport = transport;
    this.handlersAtConnect = {
      input: typeof this.ontoolinput === 'function',
      result: typeof this.ontoolresult === 'function',
      cancelled: typeof this.ontoolcancelled === 'function',
      context: typeof this.onhostcontextchanged === 'function',
      teardown: typeof this.onteardown === 'function',
    };
    this.duringConnect?.(this);
    if (this.inputDuringConnect) {
      this.ontoolinput?.(this.inputDuringConnect);
    }
    if (this.resultDuringConnect) {
      this.ontoolresult?.(this.resultDuringConnect);
    }
    if (this.connectPromise) {
      await this.connectPromise;
    }
    if (this.connectError) {
      throw this.connectError;
    }
  }

  getHostContext(): McpUiHostContext {
    if (this.contextError) {
      throw this.contextError;
    }
    return this.initialContext;
  }

  async callServerTool(params: CallToolParams): Promise<ToolResult> {
    this.calls.push(structuredClone(params));
    if (this.callError) {
      throw this.callError;
    }
    if (this.resultPromise) {
      return this.resultPromise;
    }
    return this.nextResult;
  }

  async requestDisplayMode(params: { mode: 'inline' | 'fullscreen' | 'pip' }): Promise<{
    mode: 'inline' | 'fullscreen' | 'pip';
  }> {
    this.displayModeRequests.push(params);
    if (this.displayModePromise) {
      return this.displayModePromise;
    }
    return { mode: this.displayModeResult ?? params.mode };
  }

  async sendSizeChanged(params: { width?: number; height?: number }): Promise<void> {
    this.sizeChanges.push(params);
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.transport = undefined;
  }
}

const createMount = (): HTMLElement => {
  const mount = document.createElement('main');
  mount.id = 'transit-board';
  mount.className = 'transit-board';
  document.body.append(mount);
  return mount;
};

const queryRequired = <ElementType extends Element>(
  container: ParentNode,
  selector: string,
): ElementType => {
  const element = container.querySelector<ElementType>(selector);
  if (!element) {
    throw new Error(`Missing required lifecycle element: ${selector}`);
  }
  return element;
};

let createTransitBoardApp: CreateTransitBoardApp | undefined;
let createTransitBoardSdkApp: (() => App) | undefined;
const activeControllers: TransitBoardController[] = [];

beforeAll(async () => {
  createMount();
  const lifecycle = await import('../../apps/transit-board/src/app') as LifecycleModule;
  createTransitBoardApp = lifecycle.createTransitBoardApp;
  createTransitBoardSdkApp = lifecycle.createTransitBoardSdkApp;
});

afterEach(async () => {
  await Promise.all(activeControllers.splice(0).map(controller => controller.teardown()));
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.cssText = '';
});

const startLifecycle = async (
  context: McpUiHostContext,
  configure?: (app: FakeApp) => void,
): Promise<{ app: FakeApp; mount: HTMLElement; controller: TransitBoardController }> => {
  if (!createTransitBoardApp) {
    throw new Error('Expected app.ts to export createTransitBoardApp');
  }
  const mount = createMount();
  const app = new FakeApp(context);
  configure?.(app);
  const controller = await createTransitBoardApp({
    app,
    transport: { kind: 'test-transport' },
    mount,
    root: document.documentElement,
    eventTarget: window,
  });
  activeControllers.push(controller);
  return { app, mount, controller };
};

type ResizeObserverProbe = {
  callback: ResizeObserverCallback;
  disconnectCount: number;
  observed: Element[];
  trigger(): void;
};

const installResizeSchedulerProbe = (): {
  cancelledFrameIds: number[];
  frames: Map<number, FrameRequestCallback>;
  observers: ResizeObserverProbe[];
  flushFrames(): void;
  restore(): void;
} => {
  const resizeObserverDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  const animationFrameDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'requestAnimationFrame',
  );
  const cancelFrameDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'cancelAnimationFrame',
  );
  const frames = new Map<number, FrameRequestCallback>();
  const cancelledFrameIds: number[] = [];
  const observers: ResizeObserverProbe[] = [];
  let nextFrameId = 1;
  class ProbeResizeObserver {
    readonly probe: ResizeObserverProbe;

    constructor(callback: ResizeObserverCallback) {
      this.probe = {
        callback,
        disconnectCount: 0,
        observed: [],
        trigger: () => callback([], this as unknown as ResizeObserver),
      };
      observers.push(this.probe);
    }

    observe(target: Element): void {
      this.probe.observed.push(target);
    }

    unobserve(): void {}

    disconnect(): void {
      this.probe.disconnectCount += 1;
    }
  }
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: ProbeResizeObserver,
  });
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: FrameRequestCallback) => {
      const frameId = nextFrameId;
      nextFrameId += 1;
      frames.set(frameId, callback);
      return frameId;
    },
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    configurable: true,
    value: (frameId: number) => {
      cancelledFrameIds.push(frameId);
      frames.delete(frameId);
    },
  });
  const restoreProperty = (name: 'ResizeObserver' | 'requestAnimationFrame' | 'cancelAnimationFrame', descriptor: PropertyDescriptor | undefined): void => {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, name);
    }
  };
  return {
    cancelledFrameIds,
    frames,
    observers,
    flushFrames: () => {
      for (const [frameId, callback] of [...frames]) {
        frames.delete(frameId);
        callback(performance.now());
      }
    },
    restore: () => {
      restoreProperty('ResizeObserver', resizeObserverDescriptor);
      restoreProperty('requestAnimationFrame', animationFrameDescriptor);
      restoreProperty('cancelAnimationFrame', cancelFrameDescriptor);
    },
  };
};

describe('Transit Board Apps lifecycle', () => {
  it('constructs the real SDK App without implicit resize and preserves public size notifications', async () => {
    expect(typeof createTransitBoardSdkApp).toBe('function');
    const sdkApp = createTransitBoardSdkApp?.();
    if (!sdkApp) {
      throw new Error('Expected the production SDK App factory');
    }
    const sentMethods: string[] = [];
    let observerCount = 0;
    const resizeObserverDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
    const animationFrameDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'requestAnimationFrame',
    );
    class ProbeResizeObserver {
      constructor(_callback: ResizeObserverCallback) {
        observerCount += 1;
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: ProbeResizeObserver,
    });
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      value: () => 1,
    });
    try {
      type SdkTransport = Exclude<Parameters<App['connect']>[0], undefined>;
      type TransportMessage = Parameters<SdkTransport['send']>[0];
      const transport = {
        onmessage: undefined as SdkTransport['onmessage'],
        onerror: undefined as SdkTransport['onerror'],
        onclose: undefined as SdkTransport['onclose'],
        async start(): Promise<void> {},
        async send(message: TransportMessage): Promise<void> {
          if ('method' in message) {
            sentMethods.push(message.method);
          }
          if ('method' in message && message.method === 'ui/initialize' && 'id' in message) {
            queueMicrotask(() => {
              transport.onmessage?.({
                jsonrpc: '2.0',
                id: message.id,
                result: {
                  protocolVersion: '2026-01-26',
                  hostInfo: { name: 'observer-probe', version: '1.0.0' },
                  hostCapabilities: {},
                  hostContext: {},
                },
              });
            });
          }
        },
        async close(): Promise<void> {
          transport.onclose?.();
        },
      } as SdkTransport;

      await sdkApp.connect(transport);
      expect(observerCount).toBe(0);
      await sdkApp.sendSizeChanged({ width: 320, height: 180 });
      expect(sentMethods).toContain('ui/notifications/size-changed');
      expect(observerCount).toBe(0);
      await sdkApp.close();
    } finally {
      if (resizeObserverDescriptor) {
        Object.defineProperty(globalThis, 'ResizeObserver', resizeObserverDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'ResizeObserver');
      }
      if (animationFrameDescriptor) {
        Object.defineProperty(globalThis, 'requestAnimationFrame', animationFrameDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
      }
    }
  });

  it('closes transport ownership when the real SDK transport start rejects', async () => {
    expect(typeof createTransitBoardSdkApp).toBe('function');
    expect(typeof createTransitBoardApp).toBe('function');
    const sdkApp = createTransitBoardSdkApp?.();
    if (!sdkApp || !createTransitBoardApp) {
      throw new Error('Expected the production SDK lifecycle exports');
    }
    type SdkTransport = Exclude<Parameters<App['connect']>[0], undefined>;
    let closeCount = 0;
    const transport = {
      onmessage: undefined as SdkTransport['onmessage'],
      onerror: undefined as SdkTransport['onerror'],
      onclose: undefined as SdkTransport['onclose'],
      async start(): Promise<void> {
        throw new Error('transport start failed');
      },
      async send(): Promise<void> {},
      async close(): Promise<void> {
        closeCount += 1;
        transport.onclose?.();
      },
    } as SdkTransport;

    await expect(createTransitBoardApp({
      app: sdkApp as unknown as FakeApp,
      transport,
      mount: createMount(),
      root: document.documentElement,
      eventTarget: window,
    })).rejects.toThrow('transport start failed');

    expect(closeCount).toBe(1);
    expect(sdkApp.transport).toBeUndefined();
  });

  it('cancels the initial Metro resize frame synchronously before closing the real SDK', async () => {
    expect(typeof createTransitBoardSdkApp).toBe('function');
    expect(typeof createTransitBoardApp).toBe('function');
    const sdkApp = createTransitBoardSdkApp?.();
    if (!sdkApp || !createTransitBoardApp) {
      throw new Error('Expected the production SDK lifecycle exports');
    }
    const probe = installResizeSchedulerProbe();
    let closeCount = 0;
    try {
      type SdkTransport = Exclude<Parameters<App['connect']>[0], undefined>;
      type TransportMessage = Parameters<SdkTransport['send']>[0];
      const transport = {
        onmessage: undefined as SdkTransport['onmessage'],
        onerror: undefined as SdkTransport['onerror'],
        onclose: undefined as SdkTransport['onclose'],
        async start(): Promise<void> {},
        async send(message: TransportMessage): Promise<void> {
          if ('method' in message && message.method === 'ui/initialize' && 'id' in message) {
            queueMicrotask(() => {
              transport.onmessage?.({
                jsonrpc: '2.0',
                id: message.id,
                result: {
                  protocolVersion: '2026-01-26',
                  hostInfo: { name: 'resize-drain-probe', version: '1.0.0' },
                  hostCapabilities: {},
                  hostContext: {},
                },
              });
            });
          }
        },
        async close(): Promise<void> {
          closeCount += 1;
          transport.onclose?.();
        },
      } as SdkTransport;
      const controller = await createTransitBoardApp({
        app: sdkApp as unknown as FakeApp,
        transport,
        mount: createMount(),
        root: document.documentElement,
        eventTarget: window,
      });

      const teardownPromise = controller.teardown();
      const closeCountBeforeFrameFlush = closeCount;
      const queuedFramesAfterTeardown = probe.frames.size;
      probe.flushFrames();
      await teardownPromise;

      expect(closeCountBeforeFrameFlush).toBe(1);
      expect(queuedFramesAfterTeardown).toBe(0);
      expect(probe.cancelledFrameIds).toHaveLength(1);
      expect(probe.observers).toHaveLength(1);
      expect(probe.observers[0]?.observed).toEqual([document.documentElement, document.body]);
      expect(probe.observers[0]?.disconnectCount).toBe(1);
      expect(closeCount).toBe(1);
      expect(sdkApp.transport).toBeUndefined();
    } finally {
      probe.restore();
    }
  });

  it('cancels a later observer-queued Metro resize frame before closing the real SDK', async () => {
    expect(typeof createTransitBoardSdkApp).toBe('function');
    expect(typeof createTransitBoardApp).toBe('function');
    const sdkApp = createTransitBoardSdkApp?.();
    if (!sdkApp || !createTransitBoardApp) {
      throw new Error('Expected the production SDK lifecycle exports');
    }
    const probe = installResizeSchedulerProbe();
    let closeCount = 0;
    let sizeNotificationCount = 0;
    try {
      type SdkTransport = Exclude<Parameters<App['connect']>[0], undefined>;
      type TransportMessage = Parameters<SdkTransport['send']>[0];
      const transport = {
        onmessage: undefined as SdkTransport['onmessage'],
        onerror: undefined as SdkTransport['onerror'],
        onclose: undefined as SdkTransport['onclose'],
        async start(): Promise<void> {},
        async send(message: TransportMessage): Promise<void> {
          if ('method' in message && message.method === 'ui/initialize' && 'id' in message) {
            queueMicrotask(() => {
              transport.onmessage?.({
                jsonrpc: '2.0',
                id: message.id,
                result: {
                  protocolVersion: '2026-01-26',
                  hostInfo: { name: 'later-resize-probe', version: '1.0.0' },
                  hostCapabilities: {},
                  hostContext: {},
                },
              });
            });
          } else if ('method' in message && message.method === 'ui/notifications/size-changed') {
            sizeNotificationCount += 1;
          }
        },
        async close(): Promise<void> {
          closeCount += 1;
          transport.onclose?.();
        },
      } as SdkTransport;
      const controller = await createTransitBoardApp({
        app: sdkApp as unknown as FakeApp,
        transport,
        mount: createMount(),
        root: document.documentElement,
        eventTarget: window,
      });

      probe.flushFrames();
      await Promise.resolve();
      expect(sizeNotificationCount).toBe(1);
      probe.observers[0]?.trigger();
      expect(probe.frames.size).toBe(1);

      await controller.teardown();
      const queuedFramesAfterTeardown = probe.frames.size;
      probe.flushFrames();
      await Promise.resolve();

      expect(queuedFramesAfterTeardown).toBe(0);
      expect(sizeNotificationCount).toBe(1);
      expect(probe.cancelledFrameIds).toHaveLength(1);
      expect(probe.observers[0]?.disconnectCount).toBe(1);
      expect(closeCount).toBe(1);
    } finally {
      probe.restore();
    }
  });

  for (const trigger of ['host teardown', 'pagehide'] as const) {
    it(`cancels queued resize work synchronously on ${trigger}`, async () => {
      const probe = installResizeSchedulerProbe();
      try {
        const { app, controller } = await startLifecycle(completeContext('get_incidents'));
        if (trigger === 'host teardown') {
          const response = app.onteardown?.({}, {} as Parameters<TeardownHandler>[1]);
          expect(response).toEqual({});
        } else {
          window.dispatchEvent(new Event('pagehide'));
        }
        const queuedFramesAfterTrigger = probe.frames.size;
        probe.flushFrames();
        await new Promise(resolve => window.setTimeout(resolve, 0));

        expect(queuedFramesAfterTrigger).toBe(0);
        expect(probe.cancelledFrameIds).toHaveLength(1);
        expect(probe.observers).toHaveLength(1);
        expect(probe.observers[0]?.disconnectCount).toBe(1);
        expect(app.sizeChanges).toHaveLength(0);
        expect(app.closeCount).toBe(1);
        await controller.teardown();
        expect(probe.observers[0]?.disconnectCount).toBe(1);
        expect(app.closeCount).toBe(1);
      } finally {
        probe.restore();
      }
    });
  }

  it('cancels queued resize work synchronously when post-connect setup fails', async () => {
    if (!createTransitBoardApp) {
      throw new Error('Expected app.ts to export createTransitBoardApp');
    }
    const probe = installResizeSchedulerProbe();
    try {
      const app = new FakeApp(completeContext('get_incidents'));
      app.contextError = new Error('context unavailable');
      const lifecyclePromise = createTransitBoardApp({
        app,
        transport: { kind: 'test-transport' },
        mount: createMount(),
        root: document.documentElement,
        eventTarget: window,
      });
      const rejection = expect(lifecyclePromise).rejects.toThrow('context unavailable');
      await Promise.resolve();
      await Promise.resolve();
      const queuedFramesAfterFailure = probe.frames.size;
      probe.flushFrames();
      await rejection;

      expect(queuedFramesAfterFailure).toBe(0);
      expect(probe.cancelledFrameIds).toHaveLength(1);
      expect(probe.observers).toHaveLength(1);
      expect(probe.observers[0]?.disconnectCount).toBe(1);
      expect(app.sizeChanges).toHaveLength(0);
      expect(app.closeCount).toBe(1);
    } finally {
      probe.restore();
    }
  });

  it('installs every official lifecycle handler before connecting and renders through the real dispatcher', async () => {
    expect(typeof createTransitBoardApp).toBe('function');
    const { app, mount } = await startLifecycle(completeContext('get_station_predictions'));

    expect(app.handlersAtConnect).toEqual({
      input: true,
      result: true,
      cancelled: true,
      context: true,
      teardown: true,
    });
    expect(app.connectedWith).toEqual({ kind: 'test-transport' });

    app.ontoolinput?.({ arguments: { city: 'dc', station: 'A01' } });
    app.ontoolresult?.({
      content: [{ type: 'text', text: '{"station":"wrong fallback"}' }],
      structuredContent: EXPECTED_TOOL_CONTRACTS.get_station_predictions.structuredContent,
    });

    expect(queryRequired(mount, '[data-view="rail-arrivals"]')).toBeTruthy();
    expect(queryRequired(mount, 'h1').textContent).toBe('A01 train arrivals');
    expect(mount.textContent).not.toContain('wrong fallback');
    expect(mount.getAttribute('aria-busy')).toBe('false');
  });

  it('retains a result delivered during connect until the initial host tool context is available', async () => {
    const result = EXPECTED_TOOL_CONTRACTS.get_station_predictions.structuredContent;
    const { mount } = await startLifecycle(
      completeContext('get_station_predictions'),
      (app) => {
        app.inputDuringConnect = { arguments: { city: 'dc', station: 'A01' } };
        app.resultDuringConnect = {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        };
      },
    );

    expect(queryRequired(mount, '[data-view="rail-arrivals"]')).toBeTruthy();
    expect(queryRequired(mount, 'h1').textContent).toBe('A01 train arrivals');
  });

  for (const order of ['result-then-cancel', 'cancel-then-result'] as const) {
    it(`keeps cancellation terminal when connect delivers ${order}`, async () => {
      const result = EXPECTED_TOOL_CONTRACTS.get_station_predictions.structuredContent;
      const { mount } = await startLifecycle(
        completeContext('get_station_predictions'),
        (app) => {
          app.duringConnect = (host) => {
            host.ontoolinput?.({ arguments: { city: 'dc', station: 'A01' } });
            const deliverResult = (): void => host.ontoolresult?.({
              content: [{ type: 'text', text: JSON.stringify(result) }],
              structuredContent: result,
            });
            const deliverCancellation = (): void => host.ontoolcancelled?.({
              reason: 'Cancelled during connection.',
            });
            if (order === 'result-then-cancel') {
              deliverResult();
              deliverCancellation();
            } else {
              deliverCancellation();
              deliverResult();
            }
          };
        },
      );

      expect(mount.querySelector('[data-state="cancelled"]')).not.toBeNull();
      expect(mount.querySelector('[data-view="rail-arrivals"]')).toBeNull();
      expect(queryRequired(mount, '[role="status"]').textContent).toBe(
        'Transit request cancelled.',
      );
    });
  }

  it('parses only an object-valued JSON text fallback and rejects arrays, primitives, and invalid text', async () => {
    const { app, mount } = await startLifecycle(completeContext('get_bus_routes'));
    app.ontoolinput?.({ arguments: { city: 'dc' } });

    app.ontoolresult?.({
      content: [{
        type: 'text',
        text: JSON.stringify(EXPECTED_TOOL_CONTRACTS.get_bus_routes.structuredContent),
      }],
    });
    expect(queryRequired(mount, '[data-view="bus-routes"]')).toBeTruthy();

    for (const text of ['[]', 'null', '"route"', 'not json']) {
      app.ontoolresult?.({ content: [{ type: 'text', text }] });
      expect(queryRequired(mount, '[data-state="error"]').textContent).toContain(
        'This transit result can’t be displayed',
      );
      expect(mount.querySelector('pre')).toBeNull();
    }
  });

  it('announces object-shaped results that fail renderer validation as unavailable', async () => {
    const { app, mount } = await startLifecycle(completeContext('get_incidents'));

    app.ontoolresult?.({
      content: [{ type: 'text', text: 'fallback is not used' }],
      structuredContent: { city: 'dc' },
    });

    expect(mount.querySelector('[data-view="unsupported-result"]')).not.toBeNull();
    expect(queryRequired(mount, '[role="status"]').textContent).toBe(
      'Transit result unavailable.',
    );
  });

  it('refreshes only the origin tool with immutable shallow-copied arguments unaffected by filters', async () => {
    const { app, mount } = await startLifecycle(completeContext('get_bus_predictions'));
    const input = { city: 'dc', stopId: '1001195', route: '30N' };
    app.ontoolinput?.({ arguments: input });
    input.route = 'X2';
    const representative = EXPECTED_TOOL_CONTRACTS.get_bus_predictions.structuredContent;
    const result = {
      ...representative,
      predictions: [
        representative.predictions[0],
        {
          route: '30S',
          direction: 'SOUTHBOUND',
          minutesAway: 11,
          vehicleId: null,
          tripId: null,
        },
      ],
    };
    app.ontoolresult?.({
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
    });
    app.nextResult = {
      content: [{ type: 'text', text: JSON.stringify(representative) }],
      structuredContent: representative,
    };

    const filter = queryRequired<HTMLSelectElement>(mount, 'select[name="route-filter"]');
    filter.value = '30S';
    filter.dispatchEvent(new Event('change', { bubbles: true }));
    queryRequired<HTMLButtonElement>(mount, '[data-action="refresh"]').click();
    await Promise.resolve();
    queryRequired<HTMLButtonElement>(mount, '[data-action="refresh"]').click();
    await Promise.resolve();

    expect(app.calls).toEqual([
      { name: 'get_bus_predictions', arguments: { city: 'dc', stopId: '1001195', route: '30N' } },
      { name: 'get_bus_predictions', arguments: { city: 'dc', stopId: '1001195', route: '30N' } },
    ]);
    expect(queryRequired(mount, '[role="status"]').textContent).toContain('Transit data refreshed');
  });

  it('never dispatches missing or unknown tool names', async () => {
    for (const context of [{}, completeContext('delete_everything')]) {
      const { app, mount, controller } = await startLifecycle(context);
      app.ontoolinput?.({ arguments: { city: 'dc' } });
      app.ontoolresult?.({ content: [{ type: 'text', text: '{}' }], structuredContent: {} });
      const refresh = queryRequired<HTMLButtonElement>(mount, '[data-action="refresh"]');
      expect(refresh.disabled).toBe(true);
      refresh.click();
      await Promise.resolve();
      expect(app.calls).toHaveLength(0);
      await controller.teardown();
    }
  });

  it('applies only controlled host theme, style, safe-area, and display-mode values', async () => {
    const supportedRuntimeColor = 'rebeccapurple';
    const { app, mount } = await startLifecycle(completeContext('get_incidents'));
    app.onhostcontextchanged?.({
      theme: 'dark',
      displayMode: 'fullscreen',
      safeAreaInsets: { top: 12, right: 9, bottom: 7, left: 5 },
      styles: {
        variables: {
          '--color-background-primary': 'rgb(1, 2, 3)',
          '--color-background-secondary': '#101820',
          '--color-text-primary': 'rgb(240, 241, 242)',
          '--color-text-secondary': 'hsl(210, 10%, 70%)',
          '--color-text-info': 'rgb(40, 80, 160)',
          '--color-border-primary': 'transparent',
          '--color-ring-primary': '#4488cc',
          '--font-sans': 'Transit Sans, sans-serif',
          '--not-a-host-variable': 'url(javascript:alert(1))',
        },
      },
    } as unknown as McpUiHostContext);

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(mount.dataset.displayMode).toBe('fullscreen');
    expect(mount.style.getPropertyValue('--safe-area-inset-top')).toBe('12px');
    expect(mount.style.getPropertyValue('--safe-area-inset-left')).toBe('5px');
    expect(mount.style.getPropertyValue('--board-canvas')).toBe('rgb(1, 2, 3)');
    expect(mount.style.getPropertyValue('--board-panel')).toBe('#101820');
    expect(mount.style.getPropertyValue('--board-ink')).toBe('rgb(240, 241, 242)');
    expect(mount.style.getPropertyValue('--board-muted')).toBe('hsl(210, 10%, 70%)');
    expect(mount.style.getPropertyValue('--board-accent')).toBe('rgb(40, 80, 160)');
    expect(mount.style.getPropertyValue('--board-border')).toBe('transparent');
    expect(mount.style.getPropertyValue('--focus-ring')).toBe('#4488cc');
    expect(mount.style.getPropertyValue('--font-ui')).toBe('Transit Sans, sans-serif');
    expect(mount.style.getPropertyValue('--not-a-host-variable')).toBe('');

    app.onhostcontextchanged?.({
      styles: {
        variables: {
          '--color-background-primary': supportedRuntimeColor,
          '--font-sans': '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        },
      },
    } as unknown as McpUiHostContext);
    expect(mount.style.getPropertyValue('--board-canvas')).toBe(
      supportedRuntimeColor,
    );
    expect(mount.style.getPropertyValue('--font-ui')).toBe(
      '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    );

    app.onhostcontextchanged?.({
      styles: { variables: { '--font-sans': '"Noto Sans 日本語", sans-serif' } },
    } as unknown as McpUiHostContext);
    expect(mount.style.getPropertyValue('--font-ui')).toBe('"Noto Sans 日本語", sans-serif');

    app.onhostcontextchanged?.({
      styles: { variables: { '--font-sans': '"inherit", sans-serif' } },
    } as unknown as McpUiHostContext);
    expect(mount.style.getPropertyValue('--font-ui')).toBe('"inherit", sans-serif');

    const adversarialValues = [
      ['--color-background-primary', 'image-set("https://example.invalid/pixel.png" 1x)', '--board-canvas', ''],
      ['--color-background-secondary', 'image("https://example.invalid/panel.png")', '--board-panel', ''],
      ['--color-text-primary', 'var(--attacker-color)', '--board-ink', ''],
      ['--color-text-secondary', 'env(attacker-color)', '--board-muted', ''],
      ['--color-text-info', 'linear-gradient(red, blue)', '--board-accent', ''],
      ['--color-text-info', 'color-mix(in srgb, red, expression(alert(1)))', '--board-accent', ''],
      ['--color-background-primary', 'color-mix(in srgb, red, inherit)', '--board-canvas', ''],
      ['--color-background-primary', 'color-mix(in srgb, red, initial)', '--board-canvas', ''],
      ['--color-border-primary', 'cross-fade(url(https://example.invalid/a), red)', '--board-border', ''],
      ['--color-ring-primary', 'paint(attacker)', '--focus-ring', ''],
      ['--font-sans', 'url(https://example.invalid/font.woff2)', '--font-ui', ''],
      ['--font-sans', 'local(Transit Sans)', '--font-ui', ''],
      ['--font-sans', 'var(--host-font)', '--font-ui', ''],
      ['--font-sans', 'env(host-font)', '--font-ui', ''],
      ['--font-sans', 'inherit', '--font-ui', ''],
      ['--font-sans', 'initial', '--font-ui', ''],
      ['--font-sans', 'revert-layer', '--font-ui', ''],
      ['--font-sans', 'Transit\nSans', '--font-ui', ''],
    ] as const;
    for (const [hostName, value, localName, expected] of adversarialValues) {
      app.onhostcontextchanged?.({
        styles: { variables: { [hostName]: value } },
      } as unknown as McpUiHostContext);
      expect(mount.style.getPropertyValue(localName)).toBe(expected);
    }

    app.onhostcontextchanged?.({
      styles: { variables: { '--color-background-primary': undefined } },
    } as unknown as McpUiHostContext);
    expect(mount.style.getPropertyValue('--board-canvas')).toBe('');
  });

  it('keeps native color parsing authoritative when callers supply an obsolete override', async () => {
    if (!createTransitBoardApp) {
      throw new Error('Expected app.ts to export createTransitBoardApp');
    }
    const mount = createMount();
    const app = new FakeApp(completeContext('get_incidents'));
    const dependencies = {
      app,
      transport: { kind: 'test-transport' },
      mount,
      root: document.documentElement,
      eventTarget: window,
      supportsColor: () => true,
    };
    const cssDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'CSS');
    Object.defineProperty(globalThis, 'CSS', {
      configurable: true,
      value: { supports: () => false },
    });
    try {
      const parserProbe = document.createElement('span');
      parserProbe.style.color = 'totally-not-a-color';
      expect(parserProbe.style.color).toBe('');
      expect(CSS.supports('color', 'totally-not-a-color')).toBe(false);
      const controller = await createTransitBoardApp(dependencies);
      activeControllers.push(controller);

      for (const value of [
        'totally-not-a-color',
        'color-mix(foo)',
        'color-mix(in srgb, red, inherit)',
        'light-dark(revert, red)',
        'linear-gradient(red, blue)',
      ]) {
        app.onhostcontextchanged?.({
          styles: { variables: { '--color-background-primary': value } },
        } as unknown as McpUiHostContext);
        expect(mount.style.getPropertyValue('--board-canvas')).toBe('');
      }
    } finally {
      if (cssDescriptor) {
        Object.defineProperty(globalThis, 'CSS', cssDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'CSS');
      }
    }
  });

  it('offers fullscreen only when the host advertises it and applies the returned mode', async () => {
    const { app, mount } = await startLifecycle(completeContext('get_incidents', {
      displayMode: 'inline',
      availableDisplayModes: ['inline'],
    }));
    expect(mount.querySelector('[data-action="fullscreen"]')).toBeNull();

    app.onhostcontextchanged?.({ availableDisplayModes: ['inline', 'fullscreen'] });
    const fullscreen = queryRequired<HTMLButtonElement>(mount, '[data-action="fullscreen"]');
    expect(fullscreen.textContent).toBe('Enter fullscreen');
    fullscreen.click();
    await Promise.resolve();

    expect(app.displayModeRequests).toEqual([{ mode: 'fullscreen' }]);
    expect(mount.dataset.displayMode).toBe('fullscreen');
    expect(queryRequired<HTMLButtonElement>(mount, '[data-action="fullscreen"]').textContent)
      .toBe('Exit fullscreen');
  });

  it('announces the display mode the host actually returns', async () => {
    const { mount } = await startLifecycle(completeContext('get_incidents', {
      displayMode: 'inline',
      availableDisplayModes: ['inline', 'fullscreen', 'pip'],
    }), fakeApp => {
      fakeApp.displayModeResult = 'pip';
    });

    queryRequired<HTMLButtonElement>(mount, '[data-action="fullscreen"]').click();
    await Promise.resolve();

    expect(mount.dataset.displayMode).toBe('pip');
    expect(queryRequired(mount, '[role="status"]').textContent).toBe(
      'Picture-in-picture mode enabled.',
    );
  });

  it('does not let a late refresh result overwrite a cancellation state', async () => {
    let resolveResult: ((result: ToolResult) => void) | undefined;
    const resultPromise = new Promise<ToolResult>(resolve => {
      resolveResult = resolve;
    });
    const { app, mount } = await startLifecycle(completeContext('get_incidents'), fakeApp => {
      fakeApp.resultPromise = resultPromise;
    });
    app.ontoolinput?.({ arguments: { city: 'dc' } });
    queryRequired<HTMLButtonElement>(mount, '[data-action="refresh"]').click();
    app.ontoolcancelled?.({ reason: 'Cancelled by rider.' });

    resolveResult?.({
      content: [{ type: 'text', text: '{}' }],
      structuredContent: { city: 'dc', incidents: [] },
    });
    await resultPromise;
    await new Promise(resolve => window.setTimeout(resolve, 0));

    expect(mount.querySelector('[data-state="cancelled"]')).not.toBeNull();
    expect(queryRequired(mount, '[role="status"]').textContent).toBe(
      'Transit request cancelled.',
    );
  });

  it('disables refresh and preserves cancellation when clicked after cancellation', async () => {
    const { app, mount } = await startLifecycle(completeContext('get_incidents'));
    app.ontoolinput?.({ arguments: { city: 'dc' } });
    app.ontoolcancelled?.({ reason: 'Cancelled by rider.' });
    const refresh = queryRequired<HTMLButtonElement>(mount, '[data-action="refresh"]');

    expect(refresh.disabled).toBe(true);
    refresh.click();
    await Promise.resolve();

    expect(app.calls).toHaveLength(0);
    expect(mount.querySelector('[data-state="cancelled"]')).not.toBeNull();
    expect(queryRequired(mount, '[role="status"]').textContent).toBe(
      'Transit request cancelled.',
    );
  });

  it('ignores a direct controller refresh after cancellation', async () => {
    const { app, mount, controller } = await startLifecycle(
      completeContext('get_incidents'),
    );
    app.ontoolinput?.({ arguments: { city: 'dc' } });
    app.ontoolcancelled?.({ reason: 'Cancelled by rider.' });

    await controller.refresh();

    expect(app.calls).toHaveLength(0);
    expect(mount.querySelector('[data-state="cancelled"]')).not.toBeNull();
    expect(queryRequired(mount, '[role="status"]').textContent).toBe(
      'Transit request cancelled.',
    );
  });

  it('keeps host teardown terminal when it arrives during connect', async () => {
    let teardownResponse: Awaited<ReturnType<TeardownHandler>> | undefined;
    const { app, mount, controller } = await startLifecycle(completeContext('get_incidents', {
      theme: 'dark',
    }), fakeApp => {
      fakeApp.duringConnect = (host) => {
        const response = host.onteardown?.({}, {} as Parameters<TeardownHandler>[1]);
        if (response instanceof Promise) {
          throw new Error('Fake host teardown response must be synchronous in this probe');
        }
        teardownResponse = response;
      };
    });

    await new Promise(resolve => window.setTimeout(resolve, 0));
    expect(teardownResponse).toEqual({});
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(queryRequired(mount, '[role="status"]').textContent).toBe(
      'Connecting to Transit Board.',
    );
    expect(app.closeCount).toBe(1);
    await controller.teardown();
    expect(app.closeCount).toBe(1);
  });

  it('keeps a host teardown terminal when connect later rejects', async () => {
    if (!createTransitBoardApp) {
      throw new Error('Expected app.ts to export createTransitBoardApp');
    }
    const mount = createMount();
    const app = new FakeApp(completeContext('get_incidents', { theme: 'dark' }));
    app.connectError = new Error('connect closed');
    app.duringConnect = (host) => {
      host.onteardown?.({}, {} as Parameters<TeardownHandler>[1]);
    };

    await expect(createTransitBoardApp({
      app,
      transport: { kind: 'test-transport' },
      mount,
      root: document.documentElement,
      eventTarget: window,
    })).rejects.toThrow('connect closed');
    await new Promise(resolve => window.setTimeout(resolve, 0));

    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(mount.querySelector('[data-state="error"]')).toBeNull();
    expect(queryRequired(mount, '[role="status"]').textContent).toBe(
      'Connecting to Transit Board.',
    );
    expect(app.closeCount).toBe(1);
  });

  it('keeps pagehide terminal while connect is deferred', async () => {
    if (!createTransitBoardApp) {
      throw new Error('Expected app.ts to export createTransitBoardApp');
    }
    let resolveConnect: (() => void) | undefined;
    const connectPromise = new Promise<void>(resolve => {
      resolveConnect = resolve;
    });
    const mount = createMount();
    const app = new FakeApp(completeContext('get_incidents', { theme: 'dark' }));
    app.connectPromise = connectPromise;
    const lifecyclePromise = createTransitBoardApp({
      app,
      transport: { kind: 'test-transport' },
      mount,
      root: document.documentElement,
      eventTarget: window,
    });

    window.dispatchEvent(new Event('pagehide'));
    resolveConnect?.();
    const controller = await lifecyclePromise;

    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(queryRequired(mount, '[role="status"]').textContent).toBe(
      'Connecting to Transit Board.',
    );
    expect(app.closeCount).toBe(1);
    await controller.teardown();
    expect(app.closeCount).toBe(1);
  });

  it('disposes manual resize and closes once when post-connect initialization fails', async () => {
    if (!createTransitBoardApp) {
      throw new Error('Expected app.ts to export createTransitBoardApp');
    }
    const mount = createMount();
    const app = new FakeApp(completeContext('get_incidents'));
    app.contextError = new Error('context unavailable');

    await expect(createTransitBoardApp({
      app,
      transport: { kind: 'test-transport' },
      mount,
      root: document.documentElement,
      eventTarget: window,
    })).rejects.toThrow('context unavailable');

    expect(app.closeCount).toBe(1);
    expect(app.ontoolinput).toBeUndefined();
    expect(app.onteardown).toBeUndefined();
  });

  for (const outcome of ['resolve', 'reject'] as const) {
    it(`ignores a deferred fullscreen ${outcome} after controller teardown`, async () => {
      let settleDisplay: (() => void) | undefined;
      const displayModePromise = new Promise<{ mode: 'inline' | 'fullscreen' | 'pip' }>(
        (resolve, reject) => {
          settleDisplay = outcome === 'resolve'
            ? () => resolve({ mode: 'pip' })
            : () => reject(new Error('closed display request'));
        },
      );
      const { app, mount, controller } = await startLifecycle(completeContext('get_incidents', {
        displayMode: 'inline',
        availableDisplayModes: ['inline', 'fullscreen', 'pip'],
      }), fakeApp => {
        fakeApp.displayModePromise = displayModePromise;
      });
      const statusBefore = queryRequired(mount, '[role="status"]').textContent;
      queryRequired<HTMLButtonElement>(mount, '[data-action="fullscreen"]').click();

      await controller.teardown();
      settleDisplay?.();
      await new Promise(resolve => window.setTimeout(resolve, 0));

      expect(mount.dataset.displayMode).toBe('inline');
      expect(queryRequired(mount, '[role="status"]').textContent).toBe(statusBefore);
      expect(app.closeCount).toBe(1);
    });
  }

  it('does not re-render or re-enable refresh after teardown of a deferred call', async () => {
    let resolveResult: ((result: ToolResult) => void) | undefined;
    const resultPromise = new Promise<ToolResult>(resolve => {
      resolveResult = resolve;
    });
    const { app, mount, controller } = await startLifecycle(
      completeContext('get_incidents'),
      fakeApp => {
        fakeApp.resultPromise = resultPromise;
      },
    );
    app.ontoolinput?.({ arguments: { city: 'dc' } });
    const refresh = queryRequired<HTMLButtonElement>(mount, '[data-action="refresh"]');
    refresh.click();
    const statusBefore = queryRequired(mount, '[role="status"]').textContent;

    await controller.teardown();
    resolveResult?.({
      content: [{ type: 'text', text: '{}' }],
      structuredContent: { city: 'dc', incidents: [] },
    });
    await new Promise(resolve => window.setTimeout(resolve, 0));

    expect(mount.querySelector('[data-view="service-incidents"]')).toBeNull();
    expect(queryRequired(mount, '[role="status"]').textContent).toBe(statusBefore);
    expect(refresh.disabled).toBe(true);
    expect(app.closeCount).toBe(1);
  });

  it('tears down resize and transport exactly once on repeated pagehide', async () => {
    const { app, controller } = await startLifecycle(completeContext('get_incidents'));
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('pagehide'));
    await new Promise(resolve => window.setTimeout(resolve, 0));

    expect(app.closeCount).toBe(1);
    await controller.teardown();
    expect(app.closeCount).toBe(1);
  });

  it('announces cancellation and errors, then disconnects handlers and transport on teardown', async () => {
    const { app, mount, controller } = await startLifecycle(completeContext('get_incidents'));
    app.ontoolinput?.({ arguments: { city: 'dc' } });
    app.callError = new Error('Bearer secret-must-not-render');
    queryRequired<HTMLButtonElement>(mount, '[data-action="refresh"]').click();
    await Promise.resolve();
    await Promise.resolve();
    expect(queryRequired(mount, '[data-state="error"]').textContent).toContain(
      'Transit data could not be refreshed',
    );
    expect(mount.textContent).not.toContain('secret-must-not-render');

    app.ontoolcancelled?.({ reason: '<img src=x onerror=alert(1)>' });
    expect(queryRequired(mount, '[data-state="cancelled"]').textContent).toContain(
      '<img src=x onerror=alert(1)>',
    );
    expect(mount.querySelector('img')).toBeNull();
    expect(queryRequired(mount, '[role="status"]').textContent).toContain('Transit request cancelled');

    await controller.teardown();
    expect(app.closeCount).toBe(1);
    expect(app.ontoolinput).toBeUndefined();
    expect(app.ontoolresult).toBeUndefined();
    expect(app.ontoolcancelled).toBeUndefined();
    expect(app.onhostcontextchanged).toBeUndefined();
    expect(app.onteardown).toBeUndefined();
    await controller.teardown();
    expect(app.closeCount).toBe(1);
  });

  it('responds to official host teardown before closing and removing lifecycle listeners', async () => {
    const { app, controller } = await startLifecycle(completeContext('get_incidents'));
    const teardownHandler = app.onteardown;
    if (!teardownHandler) {
      throw new Error('Expected the host teardown handler to be installed');
    }

    const response = await teardownHandler(
      {},
      {} as Parameters<TeardownHandler>[1],
    );
    expect(response).toEqual({});
    expect(app.ontoolinput).toBeUndefined();
    expect(app.ontoolresult).toBeUndefined();
    expect(app.ontoolcancelled).toBeUndefined();
    expect(app.onhostcontextchanged).toBeUndefined();
    expect(app.onteardown).toBeUndefined();

    window.dispatchEvent(new Event('pagehide'));
    await new Promise(resolve => window.setTimeout(resolve, 0));
    expect(app.closeCount).toBe(1);
    await controller.teardown();
    expect(app.closeCount).toBe(1);
  });
});
