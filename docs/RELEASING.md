# RELEASING：发布 runbook（DESIGN-V0.4 §3 的可执行版）

> 红线（RELEASE-RECON 实测）：① `gh release create --target` 必须传 commit SHA（tag 名 422）；
> ② 禁用 `gh release delete`（连带删远程 tag）；改资产用 `gh release upload --clobber`；
> ③ 直接创建正式 release（draft 资产对匿名 404）；
> ④ push 直连失败单命令借代理 `git -c http.proxy=http://127.0.0.1:7897 push ...`（禁写全局配置）。

> **版本占位**：下文 `<VER>` = 本次发布版本号（如 `v0.5.0`），`<VERNUM>` = 去掉 `v` 的版本号（如 `0.5.0`）。
> 每次发布前先把 `<VER>` / `<VERNUM>` 替换为实值——占位未替换即发布是本 runbook 唯一的硬性失败模式。
> 当前实例：`VER=v0.5.3` / `VERNUM=0.5.3`。

## 1. 前置（全部满足才开工）
- [ ] 本版功能与文档已合入 main（README 与 docs 反映本版能力；本机路径/会话 id 等敏感信息不入库）
- [ ] `cd plugin && npm run typecheck && npm test` 全绿（上一版基线不回退：v0.9.2 全量 = 118 文件 / 1999 例，口径见 `plugin/vitest.config.ts` 注释；retry=3 三判法不变）
- [ ] `docs/RELEASE-RECON.md` 已提交；README 走查通过（DESIGN-V0.4 §4.5 检查单）

## 2. 版本冻结（唯一写入窗口）
1. `plugin/.zcode-plugin/plugin.json` version → `<VERNUM>`
2. `marketplace.json` plugins[0].version → `<VERNUM>`
3. `plugin/package.json` version → `<VERNUM>`
4. `plugin/package-lock.json` 根 `version` 与 `packages[""].version` → `<VERNUM>`
5. `plugin/src/mcp/server.ts` SERVER_VERSION → `"<VERNUM>"`
6. `git add -A && git commit` → `git tag <VER>`
   → 记录 SHA：`git rev-parse <VER>^{commit}`（步骤 5 要用）

## 3. 打包
    node scripts/pack-release.mjs <VER>
（脚本自断言五处版本一致；v0.9.4 瘦身后依次执行：
① worktree 导出 tag 树（git 调用带 `-c core.autocrlf=false`——不变式「包内无 CRLF」，
   Git for Windows 安装级 autocrlf=true 会把 LF blob 检出成 CRLF）；
② `npm ci → npm run build → npm prune --omit=dev`（recon/02 §2.3 实测序列，build 依赖 devDependencies 的 esbuild）；
③ 裁包（B1/B2）：移走 `plugin/node_modules`、`src/**/*.test.ts` 与 `plugin/vitest.config.ts`
   （dist 自包含 + 测试运行时零加载；`plugin/scripts/build.mjs`、`tsconfig.json`、src 生产文件保留）；
④ 自包含冒测：在**无 node_modules** 的树上跑 dist import（IMPORT_OK）+ MCP stdio 握手
   `tools/list` 恰 10——零件箱缺失即打包失败；
⑤ CRLF 全树兜底扫描；⑥ `tar czf` + SHA256（`<hex>  <文件名>`，sha256sum -c 兼容）。
硬指标：包 ≤8 MB、文件数 ≤300、README ≤220 行（步骤 4 实测）。）

## 4. 本地验证（上传前）
- `tar -tzf .scratch-release/zcode-crosschat-<VERNUM>-prebuilt-slim.tar.gz | head`
  → 顶层 `zcode-crosschat-<VERNUM>/`，含 `marketplace.json` 与 `plugin/dist/mcp/server.mjs`
- 瘦身后形态（v0.9.4 B1/B2，逐条实测记入验收证据）：
  - `tar -tzf … | grep -c node_modules` → **0**；`tar -tzf … | grep -c "\.test\.ts"` → **0**
  - 文件数 ≤300：`tar -tzf … | wc -l`（v0.9.3 树实测 148）
  - 体积 ≤8 MB：`ls -l` 看字节数（v0.9.3 树实测 1.69 MB；解包后 5.9 MB）
  - README ≤220 行：解包后 `wc -l README.md`（v0.9.3 树为搬迁前旧文；v0.9.4 起 ≤220）
  - 包内无 CRLF：`grep -rl $'\r' <解包目录>` 为空
  - 生产文件在场：`plugin/dist/{mcp/server.mjs,mcp/wake-helper.mjs,hooks/*.mjs}`、`plugin/hooks/hooks.json`、
    `plugin/skills/`（2）、`plugin/commands/`（8）、`docs/`、`plugin/src` 生产文件（70）、`README.md`、`LICENSE`
- 隔离装一次：预构建包**不需要 npm install**（dist 自包含，零件箱已裁）：
  `ZCODE_STORAGE_DIR=<临时目录> plugins marketplace add <解包目录>` → `plugins install zcode-crosschat@dev-zcode-crosschat` → [enabled]
  → `plugins list` 计数非零即装通（hooks/skills/commands 随安装物化）

## 5. 发布
    git push origin main <VER>
    # 直连失败时：git -c http.proxy=http://127.0.0.1:7897 push origin main <VER>
    gh release create <VER> --target <步骤2的SHA> --title "zcode-crosschat <VER>" \
      --notes-file .scratch-release/notes-<VER>.md
    gh release upload <VER> \
      .scratch-release/zcode-crosschat-<VERNUM>-prebuilt-slim.tar.gz \
      .scratch-release/zcode-crosschat-<VERNUM>-prebuilt-slim.tar.gz.sha256

## 6. 发布后自检（输出全部记入验收证据）
    gh release view <VER> --json isDraft,tagName,assets   # isDraft=false、两资产在、body 含 SHA256
    # 匿名下载（无凭证语义；保留资产原名——.sha256 内记录的是原名，改名后 -c 会 FAILED open or read，复核轮 F1 实测）：
    curl -LO <browser_download_url> && sha256sum -c *.sha256
    # 解包 → 隔离 ZCODE_STORAGE_DIR → marketplace add → install → plugins list [enabled]

## 7. 从源码安装与安装 FAQ（v0.9.4 B3：自 README 搬迁，逐条比对零丢失）

### 没有合适的 Release 资产？从源码安装（开发者路径）

```bash
git clone https://github.com/QiruiGo/zcode-crosschat.git
cd zcode-crosschat/plugin
npm install && npm run build
```

然后回到 README「快速开始」第 2 步，把「解包目录」换成克隆的仓库根目录。**顺序红线：必须先 `npm install && npm run build` 再添加市场**——安装是纯目录拷贝，源码形态不先构建会得到一个「安装显示正常、实际不可用」的插件（缺构建产物且零报错）。GitHub 直连不畅时的兜底通道（实测更稳）：`curl -L -o zcode-crosschat.tar.gz https://codeload.github.com/QiruiGo/zcode-crosschat/tar.gz/refs/heads/main`，解包后同样**先构建再添加**。

### 常见问题（FAQ）

**`zcode: command not found`？** zcode CLI 不在 PATH，它是桌面版内置入口。按「快速开始第 2 步」的方式调用（可执行文件 + 入口脚本，Git Bash 函数或 PowerShell 函数任选）；安装目录定位法同处（默认 `%LOCALAPPDATA%\Programs\ZCode`，否则用注册表 Uninstall 项反推）。

**`npm install` 报 esbuild 的 allowScripts 警告？** npm 较新版本的安装脚本审批提示，**可忽略**（实测不影响构建）——只有从源码安装的开发者路径会遇到。

**装完想更新？** 解包目录/克隆目录是市场源（添加市场时做快照），**删除后无法更新**，请长期保留。出新版后：下载新 Release 资产 → 解包到新目录 → `plugins marketplace add <新解包目录>`（刷新快照）→ `plugins install zcode-crosschat@dev-zcode-crosschat`（版本递增触发重新物化）。从源码更新则需先递增 `plugin/.zcode-plugin/plugin.json` 与 `marketplace.json` 的 `version` 再重装，否则宿主不会重新物化。

**GitHub 访问不畅？** Release 资产下载失败可换时间重试；或用实测更稳的源码压缩包兜底：`curl -L -o zcode-crosschat.tar.gz https://codeload.github.com/QiruiGo/zcode-crosschat/tar.gz/refs/heads/main`（解包后按开发者路径先构建再添加）。注意 `plugins marketplace add QiruiGo/zcode-crosschat` 这种让 zcode 内部克隆的形态只认 `ZCODE_HTTP_PROXY` 环境变量。
