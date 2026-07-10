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
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self' https://formspree.io",
  `script-src 'self' 'unsafe-inline'${isProduction ? "" : " 'unsafe-eval'"} https://scripts.seorce.com https://widget.intercom.io https://js.intercomcdn.com https://www.googletagmanager.com https://www.paypal.com https://www.paypalobjects.com https://checkout.razorpay.com https://cdn.razorpay.com`,
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data: https://js.intercomcdn.com",
  "img-src 'self' data: blob: https://cdn.sanity.io https://razorpay.com https://*.razorpay.com https://www.paypalobjects.com https://*.paypal.com https://static.intercomassets.com https://*.intercomcdn.com https://static-cdn.jtvnw.net",
  "media-src 'self' blob: https://cdn.sanity.io https://js.intercomcdn.com",
  "connect-src 'self' https://scripts.seorce.com https://www.google-analytics.com https://www.paypal.com https://api.razorpay.com https://checkout.razorpay.com https://checkout-static-next.razorpay.com https://lumberjack.razorpay.com https://api-iam.intercom.io https://api-iam.eu.intercom.io wss://nexus-websocket-a.intercom.io",
  "frame-src https://www.paypal.com https://checkout.razorpay.com https://api.razorpay.com",
  "worker-src 'self' blob:",
  ...(isProduction ? ["upgrade-insecure-requests"] : []),
].join("; ");
const globalSecurityHeaders = [
  {
    key: "Content-Security-Policy",
    value: contentSecurityPolicy,
  },
  {
    key: "X-Frame-Options",
    value: "DENY",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "Referrer-Policy",
    value: "no-referrer",
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
  outputFileTracingIncludes: {
    "/api/downloads/file": ["./downloads/**/*"],
  },
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
