# RELEASING：发布 runbook（DESIGN-V0.4 §3 的可执行版）

> 红线（RELEASE-RECON 实测）：① `gh release create --target` 必须传 commit SHA（tag 名 422）；
> ② 禁用 `gh release delete`（连带删远程 tag）；改资产用 `gh release upload --clobber`；
> ③ 直接创建正式 release（draft 资产对匿名 404）；
> ④ push 直连失败单命令借代理 `git -c http.proxy=http://127.0.0.1:7897 push ...`（禁写全局配置）。

> **版本占位**：下文 `<VER>` = 本次发布版本号（如 `v0.5.0`），`<VERNUM>` = 去掉 `v` 的版本号（如 `0.5.0`）。
> 每次发布前先把 `<VER>` / `<VERNUM>` 替换为实值——占位未替换即发布是本 runbook 唯一的硬性失败模式。
> 当前实例：`VER=v0.5.2` / `VERNUM=0.5.2`。

## 1. 前置（全部满足才开工）
- [ ] 本版功能与文档已合入 main（README 与 docs 反映本版能力；本机路径/会话 id 等敏感信息不入库）
- [ ] `cd plugin && npm run typecheck && npm test` 全绿（上一版基线不回退：v0.5.2 的基线 = 53 文件 / 824 例）
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
（脚本自断言五处版本一致并做 dist import 冒测；产物与 SHA256 打印在末尾）

## 4. 本地验证（上传前）
- `tar -tzf .scratch-release/zcode-crosschat-<VERNUM>-prebuilt-slim.tar.gz | head`
  → 顶层 `zcode-crosschat-<VERNUM>/`，含 `marketplace.json` 与 `plugin/dist/mcp/server.mjs`
- （可选）隔离装一次：`ZCODE_STORAGE_DIR=<临时目录> plugins marketplace add <解包目录>` → install → [enabled]

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
