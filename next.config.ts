import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  // Huntloop is a local, per-request, database-driven app: keep the classic dynamic model.
  cacheComponents: false,
  // Drives the user's Chrome for SEEK/LinkedIn; must stay a plain Node dependency.
  serverExternalPackages: ["playwright-core", "@modelcontextprotocol/sdk", "chrome-devtools-mcp", "undici"],
  // The CV builder used to live at these addresses; bookmarks and open tabs keep working.
  async redirects() {
    return [
      { source: "/profile/interview", destination: "/profile/cv-builder", permanent: true },
      { source: "/api/cv-interview/:id/chat", destination: "/api/cv-builder/:id/chat", permanent: true },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default withNextIntl(nextConfig);
