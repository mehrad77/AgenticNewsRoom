import node from "@astrojs/node";
import { defineConfig } from "astro/config";

// One app serves every newsroom's reader site and the editor's desk; src/middleware.ts routes by host.
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  server: { host: true },
  security: { checkOrigin: true },
});
