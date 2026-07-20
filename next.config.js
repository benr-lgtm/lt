/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep the headless-Chromium binary out of the bundler so Live Share scraping
  // works on Vercel.
  experimental: {
    serverComponentsExternalPackages: ["@sparticuz/chromium", "puppeteer-core"],
  },
};

module.exports = nextConfig;
