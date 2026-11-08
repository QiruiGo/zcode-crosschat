import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entries = [
  join(root, "src/mcp/server.ts"),
  join(root, "src/hooks/session-start.ts"),
  join(root, "src/hooks/prompt-submit.ts"),
  join(root, "src/hooks/stop.ts"),
];
mkdirSync(join(root, "dist"), { recursive: true });
await build({
  entryPoints: entries,
  outdir: join(root, "dist"),
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: false,
  minify: false,
  logLevel: "info",
});
console.log("build ok -> dist/mcp/server.mjs + dist/hooks/*.mjs");
