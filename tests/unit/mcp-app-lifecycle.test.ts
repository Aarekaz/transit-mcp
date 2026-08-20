// @vitest-environment happy-dom

import type {
  App,
  McpUiHostContext,
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
  handlersAtConnect: Record<string, boolean> | undefined;
  closeCount = 0;
  nextResult: ToolResult = {
    content: [{ type: 'text', text: '{}' }],
    structuredContent: {},
  };
  resultPromise: Promise<ToolResult> | undefined;
  displayModeResult: 'inline' | 'fullscreen' | 'pip' | undefined;
  callError: Error | undefined;
  inputDuringConnect: Parameters<ToolInputHandler>[0] | undefined;
  resultDuringConnect: Parameters<ToolResultHandler>[0] | undefined;

  constructor(private readonly initialContext: McpUiHostContext) {}

  async connect(transport: object): Promise<void> {
    this.connectedWith = transport;
    this.handlersAtConnect = {
      input: typeof this.ontoolinput === 'function',
      result: typeof this.ontoolresult === 'function',
      cancelled: typeof this.ontoolcancelled === 'function',
      context: typeof this.onhostcontextchanged === 'function',
      teardown: typeof this.onteardown === 'function',
    };
    if (this.inputDuringConnect) {
      this.ontoolinput?.(this.inputDuringConnect);
    }
    if (this.resultDuringConnect) {
      this.ontoolresult?.(this.resultDuringConnect);
    }
  }

  getHostContext(): McpUiHostContext {
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
    return { mode: this.displayModeResult ?? params.mode };
  }

  async close(): Promise<void> {
    this.closeCount += 1;
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

beforeAll(async () => {
  createMount();
  const lifecycle = await import('../../apps/transit-board/src/app') as LifecycleModule;
  createTransitBoardApp = lifecycle.createTransitBoardApp;
});

afterEach(() => {
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
  return { app, mount, controller };
};

describe('Transit Board Apps lifecycle', () => {
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
    const { app, mount } = await startLifecycle(completeContext('get_incidents'));
    app.onhostcontextchanged?.({
      theme: 'dark',
      displayMode: 'fullscreen',
      safeAreaInsets: { top: 12, right: 9, bottom: 7, left: 5 },
      styles: {
        variables: {
          '--color-background-primary': 'rgb(1, 2, 3)',
          '--color-text-primary': 'rgb(240, 241, 242)',
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
    expect(mount.style.getPropertyValue('--board-ink')).toBe('rgb(240, 241, 242)');
    expect(mount.style.getPropertyValue('--font-ui')).toBe('Transit Sans, sans-serif');
    expect(mount.style.getPropertyValue('--not-a-host-variable')).toBe('');

    app.onhostcontextchanged?.({
      styles: { variables: { '--color-background-primary': undefined } },
    } as unknown as McpUiHostContext);
    expect(mount.style.getPropertyValue('--board-canvas')).toBe('');
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

  it('announces cancellation and errors, then disconnects handlers and transport on teardown', async () => {
    const { app, mount, controller } = await startLifecycle(completeContext('get_incidents'));
    app.ontoolcancelled?.({ reason: '<img src=x onerror=alert(1)>' });
    expect(queryRequired(mount, '[data-state="cancelled"]').textContent).toContain(
      '<img src=x onerror=alert(1)>',
    );
    expect(mount.querySelector('img')).toBeNull();
    expect(queryRequired(mount, '[role="status"]').textContent).toContain('Transit request cancelled');

    app.ontoolinput?.({ arguments: { city: 'dc' } });
    app.ontoolresult?.({
      content: [{ type: 'text', text: JSON.stringify({ city: 'dc', incidents: [] }) }],
      structuredContent: { city: 'dc', incidents: [] },
    });
    app.callError = new Error('Bearer secret-must-not-render');
    queryRequired<HTMLButtonElement>(mount, '[data-action="refresh"]').click();
    await Promise.resolve();
    await Promise.resolve();
    expect(queryRequired(mount, '[data-state="error"]').textContent).toContain(
      'Transit data could not be refreshed',
    );
    expect(mount.textContent).not.toContain('secret-must-not-render');

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
