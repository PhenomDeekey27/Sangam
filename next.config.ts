import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Defaults to `.next`. The Playwright suite points this at a throwaway
   * directory so it can boot its own dev server without fighting the dev
   * server already running in this folder (Next 16 holds an exclusive lock on
   * `<distDir>/dev`). Unset in every other workflow.
   */
  distDir: process.env.SANGAM_DIST_DIR ?? ".next",
  allowedDevOrigins: [
    "6021-2401-4900-1c29-654f-cd-efa8-529-9fc7.ngrok-free.app",
  ],
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
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
