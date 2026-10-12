import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export: the whole site is prerendered, so Cloudflare serves it as plain files.
  output: "export",
  images: { unoptimized: true },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
