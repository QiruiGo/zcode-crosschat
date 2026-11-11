#!/usr/bin/env node
/**
 * 发布打包（DESIGN-V0.4 §3.3 首发版，本脚本与版本无关）：从 tag 树产出预构建 slim tgz + SHA256。
 *
 * 用法（仓库根运行）：node scripts/pack-release.mjs v<x.y.z> [--keep-stage]
 *
 * 序列（与 recon/02 §2.3 实测序列一致：build 依赖 devDependencies 的 esbuild，
 * 必须完整 ci → build → prune --omit=dev，不能先 ci --omit=dev）：
 *   git worktree 导出 tag 树（产物=tag 树，不受工作区脏文件影响）
 *   → npm ci → npm run build → npm prune --omit=dev
 *   → dist import 冒测（recon/02 §2.3 的 IMPORT_OK 口径）
 *   → tar czf（顶层目录 zcode-crosschat-<ver>/，天然无 .git）
 *   → SHA256（<资产>.sha256 内容 `<hex>  <文件名>`，sha256sum -c 兼容）
 *
 * 产物：<仓库>/.scratch-release/（.gitignore 的 .scratch-* 模式已覆盖，不入库）。
 * 本脚本无发布网络操作（push 与 gh release 由 docs/RELEASING.md 执行；
 * npm ci 本身需访问 npm registry）。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const keepStage = args.includes("--keep-stage");
const tag = args.find((a) => !a.startsWith("--"));
const outDir = join(repoRoot, ".scratch-release");

function run(cmd, cmdArgs, opts = {}) {
  // shell:true 用于解析 Windows 的 npm.cmd；本仓路径不含空格（<仓库路径>）。
  const r = spawnSync(cmd, cmdArgs, { stdio: "inherit", shell: process.platform === "win32", ...opts });
  if (r.status !== 0) {
    console.error(`pack-release: 命令失败（exit=${r.status}）: ${cmd} ${cmdArgs.join(" ")}`);
    process.exit(r.status ?? 1);
  }
}
function check(cond, msg) {
  if (!cond) {
    console.error(`pack-release: ${msg}`);
    process.exit(1);
  }
}

// 0. 参数与 tag 校验
check(tag && /^v\d+\.\d+\.\d+$/.test(tag), "用法: node scripts/pack-release.mjs v<x.y.z> [--keep-stage]");
const ver = tag.slice(1);
const gitRev = spawnSync("git", ["rev-parse", `${tag}^{commit}`], { encoding: "utf8", cwd: repoRoot });
check(gitRev.status === 0, `tag ${tag} 不存在（先完成版本冻结与 git tag，见 docs/RELEASING.md）`);
const releaseSha = gitRev.stdout.trim();
console.log(`pack-release: tag=${tag} commit=${releaseSha}`);

// 1. worktree 导出 tag 树（目录名 = 资产顶层目录名；产物=tag 树，断言也读这份树——复核轮小项：
//    此前版本断言读 repoRoot 工作区，RELEASING 先 commit 后打包故两树一致，但读 stage 断言「所测即所包」更稳）
const stage = join(outDir, `zcode-crosschat-${ver}`);
rmSync(stage, { recursive: true, force: true });
// 上次运行若在 worktree add 之后、remove 之前中途失败（如 npm ci 失败 exit），注册表残留会让
// 本次 add 报「missing but already registered worktree」——rmSync 已删目录，prune 即可清掉残册。
run("git", ["worktree", "prune"], { cwd: repoRoot });
run("git", ["worktree", "add", "--detach", stage, tag], { cwd: repoRoot });
// worktree 根必有一个 .git 指针文件（内容 gitdir:<打包机绝对路径>）。设计称「worktree 导出天然无 .git」
// 与实测不符（v0.3.0 实跑取证：tgz 内 .git 含 gitdir: D:/tools/... 路径泄漏）——打包前显式删除。
rmSync(join(stage, ".git"), { force: true });

// 2. 版本一致性断言（§3.2 冻结清单的机器护栏；读 stage，不打工作区）
const manifest = JSON.parse(readFileSync(join(stage, "plugin/.zcode-plugin/plugin.json"), "utf8"));
const market = JSON.parse(readFileSync(join(stage, "marketplace.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(stage, "plugin/package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(stage, "plugin/package-lock.json"), "utf8"));
for (const [where, got] of [
  ["plugin/.zcode-plugin/plugin.json", manifest.version],
  ["marketplace.json", market.plugins[0]?.version],
  ["plugin/package.json", pkg.version],
  ["plugin/package-lock.json(root)", lock.version],
  ["plugin/package-lock.json(packages\"\")", lock.packages?.[""]?.version],
]) check(got === ver, `版本冻结不一致: ${where}=${got} ≠ ${ver}`);
check(
  readFileSync(join(stage, "plugin/src/mcp/server.ts"), "utf8").includes(`const SERVER_VERSION = "${ver}";`),
  "server.ts SERVER_VERSION 与版本不符",
);

// 3. 构建（实测序列，见文件头）
run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: join(stage, "plugin") });
run("npm", ["run", "build"], { cwd: join(stage, "plugin") });
run("npm", ["prune", "--omit=dev"], { cwd: join(stage, "plugin") });

// 4. dist import 冒测（recon/02 §2.3 口径：依赖图完整即 IMPORT_OK）
const probe = spawnSync(process.execPath, ["--input-type=module", "-e",
  `await import(${JSON.stringify(pathToFileURL(join(stage, "plugin/dist/mcp/server.mjs")).href)}); console.log("IMPORT_OK");`,
], { encoding: "utf8", timeout: 30000 });
check(probe.status === 0 && (probe.stdout ?? "").includes("IMPORT_OK"), `dist import 冒测失败: ${probe.stderr}`);

// 5. 打包（win32 下 shell:true 经 cmd 按 PATH 解析，可能命中 System32 的 bsdtar 而非 Git Bash 的
//    GNU tar 1.35——两者对本文用到的 -czf/-C 形态语义等价（复核轮记录）；如需固定实现可显式传 tar 绝对路径）
const assetName = `zcode-crosschat-${ver}-prebuilt-slim.tar.gz`;
rmSync(join(outDir, assetName), { force: true });
run("tar", ["-czf", assetName, "-C", outDir, `zcode-crosschat-${ver}`], { cwd: outDir });

// 6. SHA256（node crypto，免外部依赖；`<hex>  <文件名>` 两个空格，sha256sum -c 兼容）
const tgzPath = join(outDir, assetName);
const hash = createHash("sha256");
await new Promise((res, rej) => {
  const s = createReadStream(tgzPath);
  s.on("data", (d) => hash.update(d));
  s.on("end", res);
  s.on("error", rej);
});
const digest = hash.digest("hex");
writeFileSync(`${tgzPath}.sha256`, `${digest}  ${assetName}\n`);

// 7. 收尾：摘 worktree（保留产物；--keep-stage 保留现场排障）。
//    .git 指针已在打包前删除，git worktree remove 会校验失败拒删（「.git does not exist」，
//    v0.3.0 实跑复现 exit=128），故用 rmSync 删目录 + prune 清注册（与步骤 1 崩溃恢复同机制）。
if (!keepStage) {
  rmSync(stage, { recursive: true, force: true });
  run("git", ["worktree", "prune"], { cwd: repoRoot });
}

console.log("\npack-release: 完成");
console.log(`  资产:   ${tgzPath}`);
console.log(`  SHA256: ${digest}`);
console.log(`  发布 target（gh release create --target 用它）: ${releaseSha}`);
console.log("  后续步骤见 docs/RELEASING.md §5-§6");
