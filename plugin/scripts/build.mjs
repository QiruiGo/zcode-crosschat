import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// v0.2（DESIGN-V0.2 §10.2）：入口改为 {in, out} 对象形式——wake-helper 的产物必须
// 落在 dist/mcp/wake-helper.mjs（resume-cli.ts resolveWakeHelperPath 的解析路径，
// DESIGN-V0.2 §4.2）。若沿用普通 entries 数组，esbuild 以全部入口的公共祖先 src/
// 为 outbase，wake-helper 会被输出到 dist/engine/，与 §4.2 解析路径不符。
// 输出布局与 v0.1.0 兼容：dist/mcp/server.mjs + dist/hooks/*.mjs，仅新增
// dist/mcp/wake-helper.mjs。
const entries = [
  { in: join(root, "src/mcp/server.ts"), out: "mcp/server" },
  { in: join(root, "src/engine/wake-helper.ts"), out: "mcp/wake-helper" }, // v0.2：V9 修复的孤儿化跳板（DESIGN-V0.2 §4.2）
  { in: join(root, "src/hooks/session-start.ts"), out: "hooks/session-start" },
  { in: join(root, "src/hooks/prompt-submit.ts"), out: "hooks/prompt-submit" },
  { in: join(root, "src/hooks/stop.ts"), out: "hooks/stop" },
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
console.log("build ok -> dist/mcp/server.mjs + dist/mcp/wake-helper.mjs + dist/hooks/*.mjs");
