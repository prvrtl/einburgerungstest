export const THEME_COLORS = { light: '#f2f2f7', dark: '#000000' };

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
