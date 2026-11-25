/**
 * v0.10.0（集成员·第 6 轮）定向单测：**协作状态根向上归并的两条后果已写进用户文档**。
 *
 * 缺口（主会话打回）：真实复测第 0.3 节与组 C 的披露都指向它，裁决员也把「嵌套独立项目
 * 归并父根」列成了边界，但用户文档里一个字都没有。本轮补三处（只加文档，不改代码行为）：
 *   ① docs/LIMITATIONS.md 新增第 30 条（既存根判据 + 两条后果）；
 *   ② docs/PROTOCOL.md §16.5 补一段「既存根的判据与两条后果」；
 *   ③ README 的「N 条已知限制」数字同步（只在原有行里改，README ≤220 行）。
 *
 * 覆盖：三处文档都在位 + 关键措辞逐条在（判据、两条后果、运维归属）+ **README 的数字与
 * LIMITATIONS 的实际条数一致**（防「加了条目忘了改数字」）+ README 行数不越 220 红线。
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), "utf8");

const LIMITATIONS = read("docs/LIMITATIONS.md");
const PROTOCOL = read("docs/PROTOCOL.md");
const README = read("README.md");

/** LIMITATIONS.md 里编号条目的行（形如 "30. **标题**——…"）。 */
function limitationItems(doc: string): Array<{ n: number; text: string }> {
  return doc.split(/\r?\n/)
    .map((line) => (/^(\d+)\.\s+\*\*/.exec(line)) ? { n: Number(RegExp.$1), text: line } : null)
    .filter((x): x is { n: number; text: string } => x !== null);
}

describe("v0.10.0 集成员·R6：状态根向上归并的两条后果已进用户文档", () => {
  it("LIMITATIONS.md 有第 30 条，且写明判据与两条后果", () => {
    const items = limitationItems(LIMITATIONS);
    const item30 = items.find((i) => i.n === 30);
    expect(item30, "LIMITATIONS.md 缺第 30 条").toBeDefined();
    const text = item30!.text;
    // 判据：.crosschat + registry/teams/logs 之一；只有 config.json 不算
    expect(text).toContain("registry");
    expect(text).toContain("teams");
    expect(text).toContain("logs");
    expect(text).toContain("config.json");
    expect(text).toContain("不算既存根");
    // 后果①：已生成的子目录根不会自动并回主根 + 停会话后删/迁
    expect(text).toContain("自己就是既存根");
    expect(text).toContain("不会自动并回主根");
    expect(text).toContain("停掉相关会话");
    // 后果②：只有 config.json 的工作区会并入上层根、自己的 config.json 不生效
    expect(text).toContain("并入上层根");
    expect(text).toContain("不生效");
    // 归并动作不由插件代做（运维归属）
    expect(text).toContain("不由插件代做");
  });

  it("PROTOCOL.md §16.5 有「既存根的判据与两条后果」一段（与 §16.5 的事件说明同节）", () => {
    const at = PROTOCOL.indexOf("### 16.5 ");
    expect(at, "PROTOCOL 缺 §16.5").toBeGreaterThanOrEqual(0);
    const section = PROTOCOL.slice(at, PROTOCOL.indexOf("### 16.6 ", at));
    expect(section).toContain("既存根的判据与两条后果");
    expect(section).toContain("registry`/`teams`/`logs` 之一");
    expect(section).toContain("自己就是既存根");
    expect(section).toContain("只有 `config.json` 的工作区不算既存根");
    expect(section).toContain("并入上层根");
    // 指向 LIMITATIONS 第 30 条（两处文档互引）
    expect(section).toContain("LIMITATIONS.md");
    expect(section).toContain("30");
  });

  // v0.10.0 第 6 轮文档 lane 追加（主会话授权的一次性例外，只改计数断言）：
  // LIMITATIONS 新增第 31 条（看门狗告警的忙闲闸边界，PROTOCOL §16.8）后，最大条目号
  // 与 README 的「N 条已知限制 / 27–N 条边界」计数随文档同步为 31；其余断言不动。
  it("README 的条数与 LIMITATIONS 实际条数一致（31），且行数不越 220 红线", () => {
    const items = limitationItems(LIMITATIONS);
    const max = Math.max(...items.map((i) => i.n));
    expect(max, "LIMITATIONS 最大条目号").toBe(31);
    // 条目连续（无跳号）
    const nums = items.map((i) => i.n).sort((a, b) => a - b);
    expect(nums[nums.length - 1]).toBe(nums.length);
    expect(README).toContain("31 条已知限制");
    expect(README).toContain("27–31 五条边界");
    expect(README).not.toContain("30 条已知限制");
    expect(README).not.toContain("27–30 四条边界");
    const lines = README.split("\n").length - (README.endsWith("\n") ? 1 : 0);
    expect(lines, "README 行数越界（≤220 红线）").toBeLessThanOrEqual(220);
  });
});
