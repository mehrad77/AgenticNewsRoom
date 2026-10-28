import node from "@astrojs/node";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

// One app serves every newsroom's reader site and the editor's desk; src/middleware.ts routes by host.
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  server: { host: true },
  security: { checkOrigin: true },
  // Workspace packages run from their own source at runtime, as in every worker: @anr/render finds
  // config/formats relative to itself, which bundling into dist/ would break.
  vite: {
    build: { rollupOptions: { external: [/^@anr\//] } },
    // Tailwind for the desk's one stylesheet (src/styles/desk.css); reader sites do not load it.
    plugins: [tailwindcss()],
  },
});
