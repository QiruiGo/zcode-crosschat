/**
 * v0.10.0（集成员·第 6 轮）定向单测：**工具描述里的版本号必须是 v0.10.0**。
 *
 * 缺口（主会话打回）：这些功能随 0.10.0 发布，模型调用工具时会读到的 describe / 工具描述
 * 文本里却写着 v0.9.10（上一轮的标签归一按规矩只碰注释、没碰字符串）：
 *   - plugin/src/mcp/tools-tasks.ts:131（xc_report 的 urgent 参数 describe）
 *   - plugin/src/mcp/tools-tasks.ts:1464（xc_report 工具描述）
 *   - plugin/src/mcp/tools-team.ts:2002（xc_team 描述里的 duty）
 *   - plugin/src/mcp/tools-identify.ts:931（duty 参数 describe）
 *   - plugin/src/mcp/tools-overview.ts:1431（两处：duty / headlessTurn）与 :1435（一处）
 *
 * 覆盖：
 * 1. 上述每一处都含 `v0.10.0` 且不含 `v0.9.10`（行号锚定 + 内容断言，改错行也会红）；
 * 2. 仓库级护栏：plugin/src 下全部**非测试** .ts 的**字符串字面量**里不得再出现 `v0.9.10`
 *    （注释里的历史引用合法——本扫描只数字符串内容，不猜注释）；
 * 3. 版本号只允许出现在描述文本里（不新增任何必填配置/参数——本次只是改字符串）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(SRC, "..", "..");

/** 任务书点名的 6 处（文件 → 行号 → 该处应出现的版本号）。
 *  v0.10.1（G-26）：tools-team.ts 的 xc_team 描述行整体下移（2002 → 2339）——下移
 *  主因是新增约 312 行的 handleTeamCompact 块（action=compact 的闸门/协议/审计实现），
 *  TeamShape/TeamActionArgs 增补 compact/force 字段只是次因（评审 F19：原注释把主因
 *  归为字段增补，与实际代码结构不符）；评审修复轮补唤醒/锁内复验等实现使行号进一步
 *  下移到 2565，对抗检验 3a/3b 的未来值守卫块再下移到 2594。行号随实际代码更新，
 *  内容断言不变。 */
const PINNED: Array<{ file: string; line: number; what: string }> = [
  { file: "plugin/src/mcp/tools-tasks.ts", line: 131, what: "xc_report urgent 参数 describe" },
  { file: "plugin/src/mcp/tools-tasks.ts", line: 1464, what: "xc_report 工具描述" },
  { file: "plugin/src/mcp/tools-team.ts", line: 2594, what: "xc_team 描述 duty" },
  { file: "plugin/src/mcp/tools-identify.ts", line: 931, what: "xc_identify duty 参数 describe" },
  { file: "plugin/src/mcp/tools-overview.ts", line: 1431, what: "xc_overview 描述 duty/headlessTurn（两处）" },
  { file: "plugin/src/mcp/tools-overview.ts", line: 1435, what: "xc_overview status 视图描述" },
];

function readRepo(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

function walk(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.name.endsWith(".ts")) out.push(p);
    }
  }
  return out;
}

/**
 * 抽出源码里的全部**字符串字面量**内容（双引号 / 单引号 / 模板字符串），跳过注释。
 * 迷你扫描器：只为本测试的「字符串里不得有旧版本号」护栏服务，不做完整语法分析。
 */
function stringLiterals(source: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      let text = "";
      while (i < n) {
        if (source[i] === "\\") {
          text += source[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i++;
          break;
        }
        // 模板字符串里的 ${...} 不是字符串内容：整体跳过（嵌套括号计数）。
        if (quote === "`" && source[i] === "$" && source[i + 1] === "{") {
          let depth = 1;
          i += 2;
          while (i < n && depth > 0) {
            if (source[i] === "{") depth++;
            else if (source[i] === "}") depth--;
            i++;
          }
          continue;
        }
        text += source[i]!;
        i++;
      }
      out.push(text);
      continue;
    }
    i++;
  }
  return out;
}

describe("v0.10.0 集成员·R6：工具描述里的版本号", () => {
  it("任务书点名的 6 处都是 v0.10.0、无 v0.9.10", () => {
    for (const pin of PINNED) {
      const lines = readRepo(pin.file).split("\n");
      const text = lines[pin.line - 1];
      expect(text, `${pin.file}:${pin.line} 行不存在或已移位（${pin.what}）`).toBeDefined();
      expect(text, `${pin.file}:${pin.line}（${pin.what}）应含 v0.10.0`).toContain("v0.10.0");
      expect(text, `${pin.file}:${pin.line}（${pin.what}）不应再含 v0.9.10`).not.toContain("v0.9.10");
    }
  });

  // v0.10.1（评审 F17）：xc_team 描述第一行的动作枚举必须含 compact——此前漏了它，
  // 与 TeamShape 枚举、同串后文 compact 段落及 README/SKILL 的动作清单不一致。
  it("xc_team 描述第一行的动作枚举含 compact（与 TeamShape.action 枚举一致）", () => {
    const firstLine = readRepo("plugin/src/mcp/tools-team.ts")
      .split("\n")
      .find((line) => line.includes("Command family in one tool (actions:"));
    expect(firstLine, "xc_team 描述第一行（actions 枚举行）不存在").toBeDefined();
    expect(firstLine!).toContain("unblock/checkpoint/compact");
  });

  it("这 6 处合共 7 个版本标签（1431 行有两处：duty 与 headlessTurn）", () => {
    // 防「行号漂移后只改到一处」：逐处数标签个数。
    const expected: Array<[string, number, number]> = [
      ["plugin/src/mcp/tools-tasks.ts", 131, 1],
      ["plugin/src/mcp/tools-tasks.ts", 1464, 1],
      ["plugin/src/mcp/tools-team.ts", 2594, 1],
      ["plugin/src/mcp/tools-identify.ts", 931, 1],
      ["plugin/src/mcp/tools-overview.ts", 1431, 2],
      ["plugin/src/mcp/tools-overview.ts", 1435, 1],
    ];
    for (const [file, line, count] of expected) {
      const text = readRepo(file).split("\n")[line - 1]!;
      expect((text.match(/v0\.10\.0/g) ?? []).length, `${file}:${line}`).toBe(count);
      expect((text.match(/v0\.9\.10/g) ?? []).length, `${file}:${line}`).toBe(0);
    }
  });

  it("仓库级护栏：plugin/src 非测试源码的字符串字面量里不得有 v0.9.10", () => {
    const files = walk(SRC).filter((f) => !f.endsWith(".test.ts"));
    const hits: string[] = [];
    for (const abs of files) {
      const rel = relative(REPO_ROOT, abs).replace(/\\/g, "/");
      for (const literal of stringLiterals(readFileSync(abs, "utf8"))) {
        if (literal.includes("v0.9.10")) hits.push(`${rel}: ${literal.slice(0, 80)}`);
      }
    }
    expect(hits, `字符串里仍有旧版本号：\n${hits.join("\n")}`).toEqual([]);
    // 自检：扫描器真的在工作（同一批文件里 v0.10.0 的字符串标签应当 > 0）。
    let okCount = 0;
    for (const abs of files) {
      for (const literal of stringLiterals(readFileSync(abs, "utf8"))) {
        if (literal.includes("v0.10.0")) okCount++;
      }
    }
    expect(okCount).toBeGreaterThan(0);
    // 覆盖的是全部 src（不是子集）
    expect(files.length).toBeGreaterThan(60); // 本仓 src 非测试源文件共 70 个
    expect(files.every((f) => statSync(f).isFile())).toBe(true);
    expect(files.some((f) => f.endsWith(join("mcp", "tools-overview.ts")))).toBe(true);
  });
});
