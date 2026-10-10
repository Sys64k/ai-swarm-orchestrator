import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server (server.js + only the files it needs), so the dashboard can ship
  // inside the `aso` package and the Docker image without a node_modules install.
  output: "standalone",
};

export default nextConfig;
