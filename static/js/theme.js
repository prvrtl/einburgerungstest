export const THEME_COLORS = { light: '#e9f5f7', dark: '#06171d' };

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    const scheme = theme !== 'auto' ? theme
      : (m.getAttribute('media') || '').includes('dark') ? 'dark' : 'light';
    m.setAttribute('content', THEME_COLORS[scheme]);
  });
}
