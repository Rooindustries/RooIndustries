const PRODUCTION_HOSTS = new Set(['rooindustries.com', 'www.rooindustries.com']);

export const isProductionBrowser = (
  hostname = typeof window === 'undefined' ? '' : window.location.hostname,
  env = { NODE_ENV: process.env.NODE_ENV, VERCEL_ENV: process.env.NEXT_PUBLIC_VERCEL_ENV }
) => PRODUCTION_HOSTS.has(String(hostname).toLowerCase()) &&
  env.NODE_ENV === 'production' && (!env.VERCEL_ENV || env.VERCEL_ENV === 'production');
