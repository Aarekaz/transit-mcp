// Color theme: "system" (the default, follows the OS) or an explicit "light" /
// "dark" pick saved in this browser. Loaded in <head> so the saved pick lands
// before first paint; CSS reads :root[data-theme].
(() => {
  const KEY = 'transit-mcp-theme';
  const CHOICES = ['system', 'light', 'dark'];
  const LABELS = { system: 'System', light: 'Light', dark: 'Dark' };
  const root = document.documentElement;

  const readChoice = () => {
    try {
      const saved = localStorage.getItem(KEY);
      return CHOICES.includes(saved) ? saved : 'system';
    } catch {
      return 'system';
    }
  };

  const saveChoice = (choice) => {
    try {
      if (choice === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, choice);
    } catch {
      // Storage blocked: the pick still applies for this page view.
    }
  };

  const applyChoice = (choice) => {
    root.dataset.themeChoice = choice;
    if (choice === 'system') delete root.dataset.theme;
    else root.dataset.theme = choice;
  };

  applyChoice(readChoice());

  const systemIsDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

  // One button cycles the three modes. The first step from System is always
  // the opposite of what is on screen, so every click but the last visibly flips.
  const nextChoice = (choice) => {
    const away = systemIsDark() ? ['light', 'dark'] : ['dark', 'light'];
    if (choice === 'system') return away[0];
    if (choice === away[0]) return away[1];
    return 'system';
  };

  const wire = () => {
    const button = document.querySelector('.theme-button');
    if (!button) return;

    const sync = () => {
      const choice = root.dataset.themeChoice;
      const label = `Theme: ${LABELS[choice]}. Switch to ${LABELS[nextChoice(choice)]}`;
      button.setAttribute('aria-label', label);
      button.title = label;
    };

    button.addEventListener('click', () => {
      const choice = nextChoice(root.dataset.themeChoice);
      applyChoice(choice);
      saveChoice(choice);
      sync();
    });

    // The cycle order depends on the OS theme, so keep the label honest if it changes.
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', sync);
    sync();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire, { once: true });
  } else {
    wire();
  }
})();
