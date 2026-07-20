/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep the headless-Chromium binary out of the bundler so Live Share scraping
  // works on Vercel.
  experimental: {
    serverComponentsExternalPackages: ["@sparticuz/chromium", "puppeteer-core"],
    // Force-include the Brotli-compressed Chromium binaries and the AL2023
    // shared libraries (libnss3.so etc.) in the deployed /api/check function.
    // Without these files traced in, Chromium extracts to /tmp but fails with
    // "error while loading shared libraries: libnss3.so".
    outputFileTracingIncludes: {
      "/api/check": ["./node_modules/@sparticuz/chromium/bin/**"],
    },
  },
};

module.exports = nextConfig;
