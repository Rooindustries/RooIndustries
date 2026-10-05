export const normalizePolicyLink = (value) => {
  const href = String(value || '');
  const normalized = href.toLowerCase();
  if (normalized === '/contact' || /^\/contact[?#/]/.test(normalized) ||
      normalized === 'serviroo@rooindustries.com' || normalized === 'mailto:serviroo@rooindustries.com') {
    return 'mailto:serviroo@rooindustries.com';
  }
  return href;
};
