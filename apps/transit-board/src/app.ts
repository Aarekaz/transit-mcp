import { App, PostMessageTransport } from '@modelcontextprotocol/ext-apps';
import './styles.css';

void App;
void PostMessageTransport;

const mount = document.querySelector<HTMLElement>('#transit-board');

if (!mount) {
  throw new Error('Transit Board mount point is unavailable.');
}

mount.setAttribute('aria-busy', 'true');
