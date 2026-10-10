import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "OpenJury",
    short_name: "OpenJury",
    description: "Competitions and blind voting for your community.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#FFF8F0",
    theme_color: "#FFF8F0",
    icons: [{ src: "/icon", sizes: "512x512", type: "image/png" }],
  };
}
