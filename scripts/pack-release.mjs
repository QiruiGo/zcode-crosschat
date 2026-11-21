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
 *   → 裁包（v0.9.4 B1/B2：移走 node_modules 与测试文件，见步骤 4；v0.9.5 B3：包内
 *     scripts.test 改写为如实提示语——测试文件已裁，包内 npm test 不再指向不存在的 vitest）
 *   → 自包含冒测（recon/02 §2.3 的 IMPORT_OK 口径 + tools/list 恰 10，见步骤 5）
 *   → tar czf（顶层目录 zcode-crosschat-<ver>/，天然无 .git）
 *   → SHA256（<资产>.sha256 内容 `<hex>  <文件名>`，sha256sum -c 兼容）
 *
 * 产物：<仓库>/.scratch-release/（.gitignore 的 .scratch-* 模式已覆盖，不入库）。
 * 本脚本无发布网络操作（push 与 gh release 由 docs/RELEASING.md 执行；
 * npm ci 本身需访问 npm registry）。
 */
import { spawnSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
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

/** 递归列出 root 下所有普通文件（裁包枚举测试文件用；不跟随符号链接判断，仅按类型分流）。 */
function listFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else out.push(p);
    }
  }
  return out;
}

/**
 * MCP stdio 握手冒测：initialize → notifications/initialized → tools/list。
 * 返回工具名数组。v0.9.4 B1：这一步跑在**已裁掉 node_modules** 的 stage 上——
 * 包内 dist 由 esbuild bundle 自包含（recon/02 §2.3 实测：移走零件箱 tools/list 仍 10），
 * 故「无零件箱仍能完整应答」就是每次发布的机器护栏；import 失败或工具数≠10 即打包失败。
 * 协议版本取 SDK DEFAULT_NEGOTIATED_PROTOCOL_VERSION（2025-03-26，在 SUPPORTED 列表内）。
 */
async function stdioToolsList(serverPath, timeoutMs = 30_000) {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    // 状态根落系统临时目录：冒测只握手不落协作状态，也不污染仓库工作区。
    cwd: tmpdir(),
    env: { ...process.env },
  });
  let stderrText = "";
  child.stderr.on("data", (d) => { stderrText += String(d); });
  const messages = [];
  child.stdout.on("data", (chunk) => {
    for (const line of String(chunk).split("\n")) {
      const t = line.trim();
      if (t === "") continue;
      try { messages.push(JSON.parse(t)); } catch { /* 非 JSON 行忽略 */ }
    }
  });
  const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  const waitFor = (id) => new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(`等待 id=${id} 响应超时；stderr 尾部: ${stderrText.slice(-500)}`));
    }, timeoutMs);
    const poll = () => {
      const found = messages.find((m) => typeof m === "object" && m !== null && m.id === id);
      if (found !== undefined) { clearTimeout(timer); resolvePromise(found); }
      else setImmediate(poll);
    };
    poll();
  });
  const fail = (msg) => { throw new Error(msg); };
  try {
    send({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "pack-release-smoke", version: "1.0.0" },
      },
    });
    const init = await waitFor(1);
    if (init.error !== undefined) fail(`initialize 被拒: ${JSON.stringify(init.error)}`);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const listed = await waitFor(2);
    if (listed.error !== undefined) fail(`tools/list 被拒: ${JSON.stringify(listed.error)}`);
    const tools = Array.isArray(listed.result?.tools) ? listed.result.tools : [];
    return tools.map((t) => (typeof t?.name === "string" ? t.name : ""));
  } finally {
    child.kill();
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
// 行尾纪律（不变式：包内无 CRLF）：Git for Windows 安装级 core.autocrlf=true 会把
// worktree 检出物从 blob 的 LF 转成 CRLF（v0.9.4 实测：不显式关掉则包内 121 个文件
// 带 CRLF，违反「包内无 CRLF」不变式）。仓库 blob 全为 LF（git ls-files --eol 全 i/lf），
// 故打包用的 git 调用一律带 -c core.autocrlf=false 原样检出；步骤 6 前再全树扫描兜底。
const GIT_LF = ["-c", "core.autocrlf=false", "-c", "core.eol=lf"];
// 上次运行若在 worktree add 之后、remove 之前中途失败（如 npm ci 失败 exit），注册表残留会让
// 本次 add 报「missing but already registered worktree」——rmSync 已删目录，prune 即可清掉残册。
run("git", [...GIT_LF, "worktree", "prune"], { cwd: repoRoot });
run("git", [...GIT_LF, "worktree", "add", "--detach", stage, tag], { cwd: repoRoot });
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

// 4. 裁包（v0.9.4 方案 B1/B2：生产包只留运行时加载面 + 源码开发者路径）
//    B1：plugin/node_modules 整个移走——dist 是 esbuild bundle 自包含（步骤 5 的冒测就在
//        **无 node_modules** 的树上跑：import + tools/list 恰 10，零件缺失即打包失败）。
//        prune --omit=dev 仍按 recon/02 §2.3 实测序列保留（校验 prod 依赖可解析）。
//    B2：src/**/*.test.ts 与 vitest.config.ts 移走——运行时只加载 dist/skills/commands/hooks，
//        测试文件进包从不被加载（v0.9.4 方案 §一实测：131 个 / 45k 行）；src 生产文件、
//        scripts/build.mjs、tsconfig.json 保留（源码安装路径 npm install && npm run build 需要）。
//    裁法用「stage 内删除」而非 tar --exclude：不依赖 tar 实现的 glob 语义
//    （win32 shell:true 可能命中 System32 bsdtar；删除后 tar 无从收录，确定性等价且更强）。
check(existsSync(join(stage, "plugin", "node_modules")), "裁包前未见到 plugin/node_modules（npm ci/prune 未生效？）");
rmSync(join(stage, "plugin", "node_modules"), { recursive: true, force: true });
let testFileCount = 0;
for (const f of listFiles(join(stage, "plugin", "src"))) {
  if (f.endsWith(".test.ts")) {
    rmSync(f, { force: true });
    testFileCount += 1;
  }
}
rmSync(join(stage, "plugin", "vitest.config.ts"), { force: true });
check(testFileCount > 0, "裁包未命中任何 src/**/*.test.ts——排除规则失效？");
check(!existsSync(join(stage, "plugin", "node_modules")), "node_modules 未裁掉");
check(!existsSync(join(stage, "plugin", "vitest.config.ts")), "vitest.config.ts 未裁掉");
const remainingTests = listFiles(join(stage, "plugin", "src")).filter((f) => f.endsWith(".test.ts"));
check(remainingTests.length === 0, `仍有 ${remainingTests.length} 个测试文件残留在 stage`);

// v0.9.5 方案 §一 组 B B3：包内 test 脚本诚实化。测试文件与 vitest 都已不在这个包里
// （vitest 是 devDependency，node_modules 整个已移走），stage 的 package.json 仍写着
// "test": "vitest run"——包内跑 npm test 只会得到 MODULE_NOT_FOUND / "No test files
// found" 的误导报错。选择「打包时改写」（而非文档声明）：源码树的 scripts.test 必须
// 保持原样（测试在源码树真实存在且可用），诚实化只能发生在测试真的缺席的那份拷贝上；
// 改写后包内 npm test 打印一句如实说明并以退出码 1 结束（不给自动化假成功）。
// 改写走原文精确替换（只动 "test" 一行的字符串值，其余字节原样保留——整文件重序列化
// 会把 "engines" 等紧凑行重新折行，制造无关 diff）；版本一致性断言（步骤 2）在此之前
// 已跑完，且本改写不碰版本字段。
const SLIM_TEST_NOTICE =
  'echo "[zcode-crosschat] prebuilt-slim has no tests: test files and vitest are stripped at pack time. ' +
  "Tests run in the source tree only (git clone, then npm install && npm test). " +
  '包内无测试：测试文件与 vitest 已在打包时裁掉，测试仅源码树可用。" && exit 1';
const pkgRaw = readFileSync(join(stage, "plugin", "package.json"), "utf8");
const testScriptRaw = '"test": "vitest run"';
check(pkgRaw.includes(testScriptRaw), 'package.json 未找到 "test": "vitest run"（源文件形态变化？改写规则需同步更新）');
writeFileSync(join(stage, "plugin", "package.json"), pkgRaw.replace(testScriptRaw, `"test": ${JSON.stringify(SLIM_TEST_NOTICE)}`));
const repkg = JSON.parse(readFileSync(join(stage, "plugin", "package.json"), "utf8"));
check(repkg.version === ver, "scripts.test 改写意外动了 version 字段");
check(!repkg.scripts.test.includes("vitest run"), "包内 scripts.test 仍指向 vitest run（改写未生效）");

console.log(`pack-release: 裁包完成 —— node_modules 已移走，${testFileCount} 个测试文件 + vitest.config.ts 已移走，包内 scripts.test 已改写为如实提示语`);

// 5. 自包含冒测（recon/02 §2.3 口径：依赖图完整即 IMPORT_OK；v0.9.4 B1 追加 tools/list 恰 10）
const probe = spawnSync(process.execPath, ["--input-type=module", "-e",
  `await import(${JSON.stringify(pathToFileURL(join(stage, "plugin/dist/mcp/server.mjs")).href)}); console.log("IMPORT_OK");`,
], { encoding: "utf8", timeout: 30000 });
check(probe.status === 0 && (probe.stdout ?? "").includes("IMPORT_OK"), `dist import 冒测失败: ${probe.stderr}`);
const toolNames = await stdioToolsList(join(stage, "plugin/dist/mcp/server.mjs"));
check(toolNames.length === 10, `tools/list = ${toolNames.length} ≠ 10（工具面冻结恰 10；实得: ${toolNames.join(", ")}）`);
console.log(`pack-release: 自包含冒测通过（无 node_modules）—— IMPORT_OK + tools/list 恰 10`);

// 6. 打包（win32 下 shell:true 经 cmd 按 PATH 解析，可能命中 System32 的 bsdtar 而非 Git Bash 的
//    GNU tar 1.35——两者对本文用到的 -czf/-C 形态语义等价（复核轮记录）；如需固定实现可显式传 tar 绝对路径）
// 6.0 行尾兜底扫描（不变式：包内无 CRLF；步骤 1 已用 autocrlf=false 检出，这里防 dist 构建
//     或其他环节意外带入）。仓库无二进制文件，\r\n 即 CRLF 签名。
const crlfOffenders = [];
for (const f of listFiles(stage)) {
  if (readFileSync(f).includes("\r\n")) crlfOffenders.push(relative(stage, f));
}
check(crlfOffenders.length === 0, `stage 含 CRLF 文件 ${crlfOffenders.length} 个（包内无 CRLF 不变式）: ${crlfOffenders.slice(0, 5).join(", ")}`);
const assetName = `zcode-crosschat-${ver}-prebuilt-slim.tar.gz`;
rmSync(join(outDir, assetName), { force: true });
run("tar", ["-czf", assetName, "-C", outDir, `zcode-crosschat-${ver}`], { cwd: outDir });

// 7. SHA256（node crypto，免外部依赖；`<hex>  <文件名>` 两个空格，sha256sum -c 兼容）
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

// 8. 收尾：摘 worktree（保留产物；--keep-stage 保留现场排障）。
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
