import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // Emit a self-contained server bundle (.next/standalone/apps/demo/server.js
  // + a minimal node_modules) so the Docker runtime stage needs neither pnpm
  // nor the full workspace install.
  output: "standalone",
  // In a pnpm/turbo monorepo, pin the file-tracing root at the repo root so
  // Next traces the linked @promocean/* workspace packages into standalone and
  // lays the output out predictably at apps/demo/server.js.
  outputFileTracingRoot: path.join(import.meta.dirname, "../../"),
};

export default nextConfig;
