/**
 * v0.5.3（A5 修复）provisionMember 的显式 spawn 配置快速失败路径：
 *
 * 红队 a5 形态（adj052 故障注-1）：XC_ZCODE_EXE 配置无效（不存在路径 / 不可执行文件）时，
 * 旧实现静默回落自动探测并**创建真实成员会话**（欢迎回合真实调模型 → 烧账号额度），
 * 失败回执只字不提配置错误、反而误导用户去查 member_model。
 *
 * 修复后：显式配置无效 → ProvisionError(step="spawn") 在 AppServerKeeper.start **之前**
 * 抛出——零子进程、零真实会话、零额度消耗；message 即配置错误根因（含无效路径原文），
 * member_provision_failed 回执 detail 原样携带（member-tools.ts 失败映射 `${step}: ${message}`）。
 *
 * 归属划分：zcode_exe 校验规则本体归 zcode-locate.test.ts（resolveExplicitSpawnPair）；
 * 本文件只覆盖 provisionMember 的消费路径（快速失败 + 回执根因透传），全部零真实 spawn。
 */
import { describe, expect, it } from "vitest";
import { ProvisionError, provisionMember } from "./provision.js";
import type { ToolDeps } from "../mcp/tools.js";

const BAD_EXE = "E:\\nonexistent-dir-9999\\ZCode.exe";

function depsWith(env: NodeJS.ProcessEnv): ToolDeps {
  // configError 在读取磁盘真源之前抛出：stateRoot/workspace 无需真实存在。
  return { stateRoot: "unused-for-config-error", workspace: "unused-for-config-error", env };
}

describe("provisionMember：显式 spawn 配置无效 → spawn 步快速失败（A5）", () => {
  it("配置不存在的 exe 路径 → ProvisionError(step=spawn)，message 携带配置根因与指引", async () => {
    const err = await provisionMember(depsWith({ XC_ZCODE_EXE: BAD_EXE }), { key: "m-x" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProvisionError);
    const pe = err as ProvisionError;
    expect(pe.step).toBe("spawn");
    expect(pe.message).toContain(BAD_EXE);
    expect(pe.message).toContain("文件不存在");
    expect(pe.message).toContain("不会回落自动探测");
    // 回执根因透传：member-tools 的失败 detail 形态 `${step}: ${message}` 必含坏路径
    // （红队判据 mentionsBadPath=true 的单元层）。
    expect(`spawn: ${pe.message}`).toContain("nonexistent-dir-9999");
  });

  it("配置存在但不可执行的 .txt（win32）→ 同样 spawn 步快速失败（红队探针②）", async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "xc-prov-a5-"));
    try {
      const notExec = join(dir, "notexec.txt");
      writeFileSync(notExec, "plain text\n", "utf8");
      const err = await provisionMember(depsWith({ XC_ZCODE_EXE: notExec }), { key: "m-x" }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ProvisionError);
      const pe = err as ProvisionError;
      expect(pe.step).toBe("spawn");
      expect(pe.message).toContain(notExec);
      if (process.platform === "win32") {
        expect(pe.message).toContain("不是 Windows 可执行文件");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("快速失败先于任何 spawn：错误在 Keeper 启动之前抛出（亚秒级，非 15s 超时形态）", async () => {
    // 15s bootstrap 超时的红队形态是「真会话跑满超时」；本路径必须亚秒级返回。
    const t0 = Date.now();
    const outcome = await provisionMember(depsWith({ XC_ZCODE_EXE: BAD_EXE }), { key: "m-x" }).then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    expect(outcome).toBe("rejected");
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
});
