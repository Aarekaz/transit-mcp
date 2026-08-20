import {
  App,
  PostMessageTransport,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps';
import { clear, element } from './dom';
import { isRecord, isSupportedToolName } from './model';
import { renderToolResult } from './render';
import './styles.css';

type ToolInputHandler = NonNullable<App['ontoolinput']>;
type ToolResultHandler = NonNullable<App['ontoolresult']>;
type ToolCancelledHandler = NonNullable<App['ontoolcancelled']>;
type HostContextHandler = NonNullable<App['onhostcontextchanged']>;
type TeardownHandler = NonNullable<App['onteardown']>;
type AppTransport = Exclude<Parameters<App['connect']>[0], undefined>;
type ToolResult = Parameters<ToolResultHandler>[0];

export type TransitBoardHost = {
  ontoolinput: ToolInputHandler | undefined;
  ontoolresult: ToolResultHandler | undefined;
  ontoolcancelled: ToolCancelledHandler | undefined;
  onhostcontextchanged: HostContextHandler | undefined;
  onteardown: TeardownHandler | undefined;
  connect(transport: AppTransport): Promise<void>;
  close(): Promise<void>;
  getHostContext(): McpUiHostContext | undefined;
  callServerTool(params: Parameters<App['callServerTool']>[0]): ReturnType<App['callServerTool']>;
  requestDisplayMode(
    params: Parameters<App['requestDisplayMode']>[0],
  ): ReturnType<App['requestDisplayMode']>;
};

export type TransitBoardController = {
  teardown(): Promise<void>;
};

export type TransitBoardDependencies = {
  app: TransitBoardHost;
  transport: AppTransport;
  mount: HTMLElement;
  root?: HTMLElement;
  eventTarget?: Window;
};

const HOST_STYLE_MAP = {
  '--color-background-primary': '--board-canvas',
  '--color-background-secondary': '--board-panel',
  '--color-text-primary': '--board-ink',
  '--color-text-secondary': '--board-muted',
  '--color-border-primary': '--board-border',
  '--color-ring-primary': '--focus-ring',
  '--font-sans': '--font-ui',
} as const;

const unsafeCssValue = /(?:url|expression)\s*\(|@import/i;

function stateView(
  state: 'loading' | 'error' | 'cancelled',
  title: string,
  message: string,
): HTMLElement {
  return element('section', {
    className: `transit-view state-view${state === 'error' ? ' state-view--error' : ''}`,
    attributes: {
      'data-state': state,
      ...(state === 'error' ? { role: 'alert' } : {}),
    },
  }, [
    element('p', { className: 'board-kicker', text: 'Metro MCP · Transit Board' }),
    element('h1', { text: title }),
    element('p', { text: message }),
  ]);
}

function textFallback(result: ToolResult): Record<string, unknown> | undefined {
  const text = result.content.find(block => block.type === 'text')?.text;
  if (text === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function toolErrorMessage(result: ToolResult): string {
  return result.content.find(block => block.type === 'text')?.text
    ?? 'The transit provider returned an error.';
}

function safeInset(value: number): string {
  return `${Math.min(256, Math.max(0, Number.isFinite(value) ? value : 0))}px`;
}

function mergeHostContext(
  current: McpUiHostContext,
  update: McpUiHostContext,
): McpUiHostContext {
  const mergedStyles = update.styles === undefined
    ? current.styles
    : {
        ...current.styles,
        ...update.styles,
        variables: update.styles.variables === undefined
          ? current.styles?.variables
          : { ...current.styles?.variables, ...update.styles.variables },
      };
  return {
    ...current,
    ...update,
    ...(mergedStyles === undefined ? {} : { styles: mergedStyles }),
  };
}

export async function createTransitBoardApp(
  dependencies: TransitBoardDependencies,
): Promise<TransitBoardController> {
  const {
    app,
    transport,
    mount,
    root = document.documentElement,
    eventTarget = window,
  } = dependencies;
  let hostContext: McpUiHostContext = {};
  let originToolName: string | null = null;
  let originalArguments: Readonly<Record<string, unknown>> | null = null;
  let pendingResult: { result: ToolResult; successMessage: string } | null = null;
  let refreshInFlight = false;
  let renderGeneration = 0;
  let fullscreenButton: HTMLButtonElement | null = null;
  let teardownStarted = false;

  clear(mount);
  mount.setAttribute('aria-busy', 'true');
  mount.dataset.displayMode = 'inline';

  const actions = element('div', {
    className: 'lifecycle-actions',
    attributes: { 'aria-label': 'Transit Board actions' },
  });
  const refreshButton = element('button', {
    className: 'board-action',
    text: 'Refresh',
    attributes: { type: 'button', 'data-action': 'refresh' },
  });
  refreshButton.disabled = true;
  actions.append(refreshButton);
  const status = element('p', {
    className: 'lifecycle-status',
    text: 'Connecting to Transit Board.',
    attributes: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
  });
  const resultHost = element('div', { className: 'result-host' }, [
    stateView('loading', 'Preparing service data', 'Connecting to this conversation’s transit result.'),
  ]);
  mount.append(actions, status, resultHost);

  const setStatus = (message: string, busy: boolean): void => {
    status.textContent = message;
    mount.setAttribute('aria-busy', String(busy));
  };

  const updateRefreshAvailability = (): void => {
    refreshButton.disabled = refreshInFlight
      || originalArguments === null
      || originToolName === null
      || !isSupportedToolName(originToolName);
  };

  const applyHostStyles = (context: McpUiHostContext): void => {
    const variables = context.styles?.variables;
    if (!variables) {
      return;
    }
    for (const [hostName, localName] of Object.entries(HOST_STYLE_MAP)) {
      const value = variables[hostName as keyof typeof variables];
      if (value === undefined) {
        mount.style.removeProperty(localName);
        continue;
      }
      if (typeof value === 'string' && value.trim() !== '' && !unsafeCssValue.test(value)) {
        mount.style.setProperty(localName, value);
      }
    }
  };

  async function requestFullscreen(): Promise<void> {
    const target = hostContext.displayMode === 'fullscreen' ? 'inline' : 'fullscreen';
    if (hostContext.availableDisplayModes?.includes(target) !== true) {
      return;
    }
    try {
      const result = await app.requestDisplayMode({ mode: target });
      applyHostContext({ displayMode: result.mode });
      const message = result.mode === 'fullscreen'
        ? 'Fullscreen mode enabled.'
        : result.mode === 'pip'
          ? 'Picture-in-picture mode enabled.'
          : 'Inline mode enabled.';
      setStatus(message, false);
    } catch {
      setStatus('Display mode could not be changed.', false);
    }
  }

  const updateFullscreenControl = (): void => {
    const fullscreenOffered = hostContext.availableDisplayModes?.includes('fullscreen') === true;
    const canExitFullscreen = hostContext.displayMode === 'fullscreen'
      && hostContext.availableDisplayModes?.includes('inline') === true;
    if (!fullscreenOffered || (hostContext.displayMode === 'fullscreen' && !canExitFullscreen)) {
      fullscreenButton?.removeEventListener('click', requestFullscreen);
      fullscreenButton?.remove();
      fullscreenButton = null;
      return;
    }
    if (!fullscreenButton) {
      fullscreenButton = element('button', {
        className: 'board-action board-action--secondary',
        attributes: { type: 'button', 'data-action': 'fullscreen' },
      });
      fullscreenButton.addEventListener('click', requestFullscreen);
      actions.append(fullscreenButton);
    }
    fullscreenButton.textContent = hostContext.displayMode === 'fullscreen'
      ? 'Exit fullscreen'
      : 'Enter fullscreen';
  };

  const applyHostContext = (update: McpUiHostContext): void => {
    hostContext = mergeHostContext(hostContext, update);
    if (originToolName === null && typeof hostContext.toolInfo?.tool.name === 'string') {
      originToolName = hostContext.toolInfo.tool.name;
    }
    if (hostContext.theme === 'light' || hostContext.theme === 'dark') {
      root.dataset.theme = hostContext.theme;
      root.style.colorScheme = hostContext.theme;
    }
    applyHostStyles(hostContext);
    if (hostContext.safeAreaInsets) {
      mount.style.setProperty('--safe-area-inset-top', safeInset(hostContext.safeAreaInsets.top));
      mount.style.setProperty('--safe-area-inset-right', safeInset(hostContext.safeAreaInsets.right));
      mount.style.setProperty('--safe-area-inset-bottom', safeInset(hostContext.safeAreaInsets.bottom));
      mount.style.setProperty('--safe-area-inset-left', safeInset(hostContext.safeAreaInsets.left));
    }
    if (
      hostContext.displayMode === 'inline'
      || hostContext.displayMode === 'fullscreen'
      || hostContext.displayMode === 'pip'
    ) {
      mount.dataset.displayMode = hostContext.displayMode;
    }
    updateRefreshAvailability();
    updateFullscreenControl();
  };

  const renderResult = (result: ToolResult, successMessage: string): void => {
    if (result.isError) {
      resultHost.replaceChildren(stateView(
        'error',
        'Transit request failed',
        toolErrorMessage(result),
      ));
      setStatus('Transit request failed.', false);
      return;
    }
    const structured = isRecord(result.structuredContent)
      ? result.structuredContent
      : textFallback(result);
    if (structured === undefined) {
      resultHost.replaceChildren(stateView(
        'error',
        'This transit result can’t be displayed',
        'The host did not provide an object-shaped transit result.',
      ));
      setStatus('Transit result unavailable.', false);
      return;
    }
    if (originToolName === null) {
      pendingResult = { result, successMessage };
      setStatus('Waiting for the originating transit tool.', true);
      return;
    }
    pendingResult = null;
    const rendered = renderToolResult(resultHost, originToolName, structured);
    setStatus(rendered ? successMessage : 'Transit result unavailable.', false);
  };

  const flushPendingResult = (): void => {
    if (pendingResult === null || originToolName === null) {
      return;
    }
    const pending = pendingResult;
    pendingResult = null;
    renderResult(pending.result, pending.successMessage);
  };

  async function refresh(): Promise<void> {
    if (
      refreshInFlight
      || originalArguments === null
      || originToolName === null
      || !isSupportedToolName(originToolName)
    ) {
      return;
    }
    refreshInFlight = true;
    const generation = ++renderGeneration;
    updateRefreshAvailability();
    setStatus('Refreshing transit data…', true);
    try {
      const result = await app.callServerTool({
        name: originToolName,
        arguments: { ...originalArguments },
      });
      if (generation === renderGeneration && !teardownStarted) {
        renderResult(result, 'Transit data refreshed.');
      }
    } catch {
      if (generation === renderGeneration && !teardownStarted) {
        resultHost.replaceChildren(stateView(
          'error',
          'Transit data could not be refreshed',
          'The host could not complete the refresh request.',
        ));
        setStatus('Transit refresh failed.', false);
      }
    } finally {
      refreshInFlight = false;
      if (!teardownStarted) {
        updateRefreshAvailability();
      }
    }
  }

  refreshButton.addEventListener('click', refresh);

  function handlePageHide(): void {
    void teardown();
  }

  const clearHandlersAndListeners = (): void => {
    renderGeneration += 1;
    refreshButton.removeEventListener('click', refresh);
    fullscreenButton?.removeEventListener('click', requestFullscreen);
    eventTarget.removeEventListener('pagehide', handlePageHide);
    app.ontoolinput = undefined;
    app.ontoolresult = undefined;
    app.ontoolcancelled = undefined;
    app.onhostcontextchanged = undefined;
    app.onteardown = undefined;
  };

  const teardown = async (): Promise<void> => {
    if (teardownStarted) {
      return;
    }
    teardownStarted = true;
    clearHandlersAndListeners();
    await app.close();
  };

  app.ontoolinput = ({ arguments: argumentsFromHost }): void => {
    if (originalArguments === null && argumentsFromHost !== undefined) {
      originalArguments = Object.freeze({ ...argumentsFromHost });
      updateRefreshAvailability();
    }
  };
  app.ontoolresult = (result): void => {
    renderGeneration += 1;
    renderResult(result, 'Transit data ready.');
  };
  app.ontoolcancelled = ({ reason }): void => {
    renderGeneration += 1;
    resultHost.replaceChildren(stateView(
      'cancelled',
      'Transit request cancelled',
      reason ?? 'The host cancelled this transit request.',
    ));
    setStatus('Transit request cancelled.', false);
  };
  app.onhostcontextchanged = (context): void => {
    applyHostContext(context);
    flushPendingResult();
  };
  app.onteardown = (): Record<string, never> => {
    if (!teardownStarted) {
      teardownStarted = true;
      clearHandlersAndListeners();
      eventTarget.setTimeout(() => {
        void app.close();
      }, 0);
    }
    return {};
  };
  eventTarget.addEventListener('pagehide', handlePageHide);

  try {
    await app.connect(transport);
    applyHostContext(app.getHostContext() ?? {});
    flushPendingResult();
    if (pendingResult === null && resultHost.querySelector('[data-state="loading"]')) {
      setStatus('Waiting for transit data.', true);
    }
  } catch (error) {
    resultHost.replaceChildren(stateView(
      'error',
      'Transit Board could not connect',
      'The host connection could not be established.',
    ));
    setStatus('Transit Board connection failed.', false);
    clearHandlersAndListeners();
    throw error;
  }

  return { teardown };
}

async function startTransitBoard(): Promise<void> {
  const mount = document.querySelector<HTMLElement>('#transit-board');
  if (!mount) {
    throw new Error('Transit Board mount point is unavailable.');
  }
  const app = new App(
    { name: 'Metro MCP Transit Board', version: '5.0.0' },
    { availableDisplayModes: ['inline', 'fullscreen'] },
    { autoResize: true, strict: true },
  );
  await createTransitBoardApp({
    app,
    transport: new PostMessageTransport(window.parent, window.parent),
    mount,
  });
}

if (window.parent !== window) {
  void startTransitBoard().catch(() => {
    // createTransitBoardApp renders a safe connection error before rejecting.
  });
}
