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
  readonly transport: AppTransport | undefined;
  sendSizeChanged(
    params: Parameters<App['sendSizeChanged']>[0],
  ): ReturnType<App['sendSizeChanged']>;
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

const HOST_COLOR_STYLE_MAP = {
  '--color-background-primary': '--board-canvas',
  '--color-background-secondary': '--board-panel',
  '--color-text-primary': '--board-ink',
  '--color-text-secondary': '--board-muted',
  '--color-text-info': '--board-accent',
  '--color-border-primary': '--board-border',
  '--color-ring-primary': '--focus-ring',
} as const;

const unsafeCssFunction = /\b(?:url|src|image|image-set|cross-fade|paint|element|var|env|attr|expression)\s*\(/i;
const unsafeCssSyntax = /[\\;{}!]|\/\*|\*\//;
const cssControlCharacter = /[\u0000-\u001f\u007f]/u;
const cssWideKeyword = /^(?:inherit|initial|unset|revert|revert-layer)$/i;

function isBalancedFunction(value: string, name: string): boolean {
  if (!value.toLowerCase().startsWith(`${name}(`) || !value.endsWith(')')) {
    return false;
  }
  let depth = 0;
  for (const character of value) {
    if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
      if (depth < 0) {
        return false;
      }
    }
  }
  return depth === 0;
}

function unquotedCss(value: string): { balanced: boolean; value: string } {
  let quote: '"' | "'" | null = null;
  let unquoted = '';
  for (const character of value) {
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      }
      unquoted += ' ';
    } else if (character === '"' || character === "'") {
      quote = character;
      unquoted += ' ';
    } else {
      unquoted += character;
    }
  }
  return { balanced: quote === null, value: unquoted };
}

function isSafeColor(value: string): boolean {
  const candidate = value.trim();
  if (
    candidate.length === 0
    || candidate.length > 256
    || cssControlCharacter.test(candidate)
    || unsafeCssSyntax.test(candidate)
    || unsafeCssFunction.test(candidate)
    || /^(?:currentcolor|inherit|initial|unset|revert|revert-layer)$/i.test(candidate)
  ) {
    return false;
  }
  const probe = document.createElement('span');
  probe.style.color = candidate;
  return probe.style.color !== '' || isBalancedFunction(candidate, 'color-mix');
}

function isSafeFontFamily(value: string): boolean {
  const candidate = value.trim();
  const unquoted = unquotedCss(candidate);
  if (
    candidate.length === 0
    || candidate.length > 512
    || cssControlCharacter.test(candidate)
    || unsafeCssSyntax.test(candidate)
    || !unquoted.balanced
    || unsafeCssFunction.test(unquoted.value)
    || /[()]/.test(unquoted.value)
    || cssWideKeyword.test(candidate)
  ) {
    return false;
  }
  const probe = document.createElement('span');
  probe.style.fontFamily = candidate;
  return probe.style.fontFamily !== '';
}

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

function setupTransitBoardResizeNotifications(
  app: TransitBoardHost,
  eventTarget: Window,
  measurementRoot: HTMLElement,
): () => void {
  let disposed = false;
  let observer: ResizeObserver | null = null;
  let previousWidth = 0;
  let previousHeight = 0;
  const pendingFrames = new Set<number>();

  const schedule = (): void => {
    if (disposed || pendingFrames.size > 0) {
      return;
    }
    const frameId = eventTarget.requestAnimationFrame(() => {
      pendingFrames.delete(frameId);
      if (disposed) {
        return;
      }
      const originalHeight = measurementRoot.style.height;
      measurementRoot.style.height = 'max-content';
      const height = Math.ceil(measurementRoot.getBoundingClientRect().height);
      measurementRoot.style.height = originalHeight;
      const width = Math.ceil(eventTarget.innerWidth);
      if (width === previousWidth && height === previousHeight) {
        return;
      }
      previousWidth = width;
      previousHeight = height;
      try {
        void app.sendSizeChanged({ width, height }).catch(() => {
          // Size notifications are best effort and never outlive this lifecycle in the UI.
        });
      } catch {
        // Treat a synchronous transport shutdown like an already-settled notification.
      }
    });
    pendingFrames.add(frameId);
  };

  const dispose = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    observer?.disconnect();
    observer = null;
    for (const frameId of pendingFrames) {
      eventTarget.cancelAnimationFrame(frameId);
    }
    pendingFrames.clear();
  };

  schedule();
  try {
    observer = new ResizeObserver(schedule);
    observer.observe(measurementRoot);
    const body = measurementRoot.ownerDocument.body;
    if (body) {
      observer.observe(body);
    }
  } catch (error) {
    dispose();
    throw error;
  }
  return dispose;
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
  let toolLifecycleCancelled = false;
  let refreshInFlight = false;
  let renderGeneration = 0;
  let fullscreenButton: HTMLButtonElement | null = null;
  let resizeDisposer: (() => void) | null = null;
  let closePromise: Promise<void> | null = null;
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
    for (const [hostName, localName] of Object.entries(HOST_COLOR_STYLE_MAP)) {
      const value = variables[hostName as keyof typeof variables];
      if (value === undefined) {
        mount.style.removeProperty(localName);
        continue;
      }
      if (typeof value === 'string' && isSafeColor(value)) {
        mount.style.setProperty(localName, value);
      } else {
        mount.style.removeProperty(localName);
      }
    }
    const fontFamily = variables['--font-sans'];
    if (fontFamily === undefined) {
      mount.style.removeProperty('--font-ui');
    } else if (typeof fontFamily === 'string' && isSafeFontFamily(fontFamily)) {
      mount.style.setProperty('--font-ui', fontFamily);
    } else {
      mount.style.removeProperty('--font-ui');
    }
  };

  async function requestFullscreen(): Promise<void> {
    if (teardownStarted) {
      return;
    }
    const target = hostContext.displayMode === 'fullscreen' ? 'inline' : 'fullscreen';
    if (hostContext.availableDisplayModes?.includes(target) !== true) {
      return;
    }
    try {
      const result = await app.requestDisplayMode({ mode: target });
      if (teardownStarted) {
        return;
      }
      applyHostContext({ displayMode: result.mode });
      const message = result.mode === 'fullscreen'
        ? 'Fullscreen mode enabled.'
        : result.mode === 'pip'
          ? 'Picture-in-picture mode enabled.'
          : 'Inline mode enabled.';
      setStatus(message, false);
    } catch {
      if (!teardownStarted) {
        setStatus('Display mode could not be changed.', false);
      }
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
    if (teardownStarted) {
      return;
    }
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
    if (teardownStarted) {
      return;
    }
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
    if (teardownStarted || pendingResult === null || originToolName === null) {
      return;
    }
    const pending = pendingResult;
    pendingResult = null;
    renderResult(pending.result, pending.successMessage);
  };

  async function refresh(): Promise<void> {
    if (
      refreshInFlight
      || teardownStarted
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
    const disposeResize = resizeDisposer;
    resizeDisposer = null;
    disposeResize?.();
  };

  const closeApp = (): Promise<void> => {
    closePromise ??= app.close();
    return closePromise;
  };

  const teardown = async (): Promise<void> => {
    if (!teardownStarted) {
      teardownStarted = true;
      clearHandlersAndListeners();
    }
    await closeApp();
  };

  app.ontoolinput = ({ arguments: argumentsFromHost }): void => {
    if (!teardownStarted && originalArguments === null && argumentsFromHost !== undefined) {
      originalArguments = Object.freeze({ ...argumentsFromHost });
      updateRefreshAvailability();
    }
  };
  app.ontoolresult = (result): void => {
    if (teardownStarted || toolLifecycleCancelled) {
      return;
    }
    renderGeneration += 1;
    renderResult(result, 'Transit data ready.');
  };
  app.ontoolcancelled = ({ reason }): void => {
    if (teardownStarted) {
      return;
    }
    toolLifecycleCancelled = true;
    pendingResult = null;
    renderGeneration += 1;
    resultHost.replaceChildren(stateView(
      'cancelled',
      'Transit request cancelled',
      reason ?? 'The host cancelled this transit request.',
    ));
    setStatus('Transit request cancelled.', false);
  };
  app.onhostcontextchanged = (context): void => {
    if (teardownStarted) {
      return;
    }
    applyHostContext(context);
    flushPendingResult();
  };
  app.onteardown = (): Record<string, never> => {
    if (!teardownStarted) {
      teardownStarted = true;
      clearHandlersAndListeners();
      eventTarget.setTimeout(() => {
        void closeApp();
      }, 0);
    }
    return {};
  };
  eventTarget.addEventListener('pagehide', handlePageHide);

  try {
    await app.connect(transport);
    if (teardownStarted) {
      return { teardown };
    }
    resizeDisposer = setupTransitBoardResizeNotifications(app, eventTarget, root);
    applyHostContext(app.getHostContext() ?? {});
    flushPendingResult();
    if (pendingResult === null && resultHost.querySelector('[data-state="loading"]')) {
      setStatus('Waiting for transit data.', true);
    }
  } catch (error) {
    if (!teardownStarted) {
      resultHost.replaceChildren(stateView(
        'error',
        'Transit Board could not connect',
        'The host connection could not be established.',
      ));
      setStatus('Transit Board connection failed.', false);
      teardownStarted = true;
      clearHandlersAndListeners();
      if (app.transport !== undefined) {
        try {
          await closeApp();
        } catch {
          // Preserve the initialization error; teardown remains terminal.
        }
      }
    }
    throw error;
  }

  return { teardown };
}

export function createTransitBoardSdkApp(): App {
  return new App(
    { name: 'Metro MCP Transit Board', version: '5.0.0' },
    { availableDisplayModes: ['inline', 'fullscreen'] },
    { autoResize: false, strict: true },
  );
}

async function startTransitBoard(): Promise<void> {
  const mount = document.querySelector<HTMLElement>('#transit-board');
  if (!mount) {
    throw new Error('Transit Board mount point is unavailable.');
  }
  const app = createTransitBoardSdkApp();
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
