import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";

/**
 * Vite configuration for vinext (Next.js on Vite) + Cloudflare Workers.
 *
 * Required for vinext App Router builds targeting Cloudflare Workers.
 * The cloudflare() plugin sets up the RSC/SSR multi-environment build.
 *
 * Service bindings (BACKEND_API) and secrets (HMAC_SECRET) are configured
 * in wrangler.toml / .dev.vars — not here.
 */
export default defineConfig({
  plugins: [
    vinext(),
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
});
