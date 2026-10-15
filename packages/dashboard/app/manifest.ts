import type { MetadataRoute } from "next";

/** Lets phones add the console to the home screen and open it like an app. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "AI Swarm Orchestrator",
    short_name: "ASO",
    start_url: "/",
    display: "standalone",
    background_color: "#0f1115",
    theme_color: "#0f1115",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      // Android wants PNGs to install the console as an app (needed for notifications on iPhone).
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
