import type { MetadataRoute } from "next";

/** The web app manifest: "Add to Home Screen" on iPhone, "Install app" on Android and desktop Chrome. */
export function appManifest(): MetadataRoute.Manifest {
  return {
    name: "Daily brief",
    short_name: "Brief",
    description: "What you owe, what you're waiting on, and what was decided.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    categories: ["productivity"],
    icons: [
      { src: "/icons/icon-256.png", sizes: "256x256", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "All open", url: "/open" },
      { name: "People", url: "/people" },
    ],
  };
}
