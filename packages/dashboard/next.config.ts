import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server (server.js + only the files it needs), so the dashboard can ship
  // inside the `aso` package and the Docker image without a node_modules install.
  output: "standalone",
  // The service worker must never be served from a cache, or phones keep an old one.
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
        ],
      },
    ];
  },
};

export default nextConfig;
