/** @type {import('next').NextConfig} */
const isProduction = process.env.NODE_ENV === "production";
const immutableAssetHeaders = [
  {
    key: "Cache-Control",
    value: "public, max-age=31536000, immutable",
  },
];
const devAssetHeaders = [
  {
    key: "Cache-Control",
    value: "no-store, must-revalidate",
  },
];
const assetCacheHeaders = isProduction ? immutableAssetHeaders : devAssetHeaders;
const globalSecurityHeaders = [
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  ...(isProduction
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=31536000; includeSubDomains",
        },
      ]
    : []),
];

const nextConfig = {
  poweredByHeader: false,
  distDir: process.env.NEXT_DIST_DIR || ".next",
  outputFileTracingRoot: process.cwd(),
  htmlLimitedBots: /.*/,
  experimental: {
    devtoolSegmentExplorer: false,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  async redirects() {
    return [
      {
        source: '/:path*',
        has: [{ type: 'host', value: 'rooindustries.com' }],
        destination: 'https://www.rooindustries.com/:path*',
        permanent: true,
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: '/BIOSGuide',
        destination: '/BIOSGuide/index.html',
      },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: globalSecurityHeaders,
      },
      {
        source: '/_next/static/:path*',
        headers: assetCacheHeaders,
      },
      {
        source: '/:path*.:ext(png|jpg|jpeg|gif|webp|avif|svg|ico|woff2|woff|ttf|otf|webm|mp4)',
        headers: assetCacheHeaders,
      },
    ];
  },
  images: {
    formats: ['image/avif', 'image/webp'],
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'cdn.sanity.io',
      },
    ],
  },
};

export default nextConfig;
