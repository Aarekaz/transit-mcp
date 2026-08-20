type ElementOptions = {
  className?: string;
  text?: string;
  attributes?: Readonly<Record<string, string>>;
};

type Child = Node | string;

export function element<TagName extends keyof HTMLElementTagNameMap>(
  tagName: TagName,
  options: ElementOptions = {},
  children: readonly Child[] = [],
): HTMLElementTagNameMap[TagName] {
  const node = document.createElement(tagName);
  if (options.className) {
    node.className = options.className;
  }
  if (options.text !== undefined) {
    node.textContent = options.text;
  }
  if (options.attributes) {
    for (const [name, value] of Object.entries(options.attributes)) {
      node.setAttribute(name, value);
    }
  }
  append(node, ...children);
  return node;
}

export function append(parent: ParentNode, ...children: readonly Child[]): void {
  for (const child of children) {
    parent.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
}

export function clear(node: ParentNode): void {
  node.replaceChildren();
}

export function button(
  label: string,
  className: string,
  onClick: () => void,
): HTMLButtonElement {
  const control = element('button', {
    className,
    text: label,
    attributes: { type: 'button' },
  });
  control.addEventListener('click', onClick);
  return control;
}

export function viewHeader(
  city: string,
  title: string,
  mode: 'live' | 'directory',
): HTMLElement {
  const heading = element('header', { className: 'view-header' });
  append(
    heading,
    element('div', { className: 'view-identity' }, [
      element('p', {
        className: 'board-kicker',
        text: `Metro MCP · ${city.toUpperCase()}`,
      }),
      element('h1', { text: title }),
    ]),
    element('p', {
      className: `mode-label mode-label--${mode}`,
      text: mode === 'live' ? 'Live board' : 'Directory',
    }),
  );
  return heading;
}

export function emptyState(message: string): HTMLElement {
  return element('p', {
    className: 'empty-state',
    text: message,
    attributes: { 'data-empty-state': '' },
  });
}

export function emptyListState(message: string): HTMLLIElement {
  return element('li', { className: 'list-empty' }, [emptyState(message)]);
}

export function lineBadge(line: string): HTMLElement {
  return element('span', { className: 'line-badge', text: line });
}
