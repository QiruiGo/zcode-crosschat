/**
 * v0.8.0 A5 回归（命令与文档面；DESIGN-V0.8.md §7 / 方案 §2 A5 / ACCEPT15-1 文档走查项）：
 *
 * 本组（G3）只拥有「命令模板 + 两个 skill + README/PROTOCOL + 五处版本」，不碰
 * G1 的 core/checkpoint.ts、hooks/prompt-submit.ts、tools-team.ts，也不碰 G2 的
 * core/handoff.ts、core/timeline.ts、tools-read.ts、tools-overview.ts。
 * 因此本文件的断言**只读本组拥有的文件**（plugin/commands 下的命令 markdown、
 * plugin/skills 下的两个 SKILL.md、README.md、docs/PROTOCOL.md 与五处版本号），
 * 不 import 任何 src 模块——这样三组可并行开发、本组测试的绿/红不被同事的进度左右。
 *
 * 覆盖：
 * 1. 命令面**恰 8**（6 旧 + 2 新；硬断言，把「命令数恰 8」从走查变成断言）；
 * 2. 两个新命令模板的冻结要点（调用哪个工具、失败码、截断披露、≤3 步口径）；
 * 3. 命令模板只引用真实存在的 10 个工具（防模板写错工具名）；
 * 4. longtask：接手模板三步 + 压缩前 checklist 三步序（checkpoint 先于 journal）；
 * 5. crosschat：工具表补 handoff/checkpoint/timeline/status + 「交接与压缩防护」小节；
 * 6. 平台缺口如实声明（README/PROTOCOL/skill 含「无 PreCompact，故用提醒+一键」；
 *    且 PreCompact / 压缩钩子只以否定句式出现——不宣称自动压缩钩子）；
 * 7. 五处版本号统一 0.8.1（AC6 的静态面）。
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_ROOT = join(SRC, '..');
const REPO_ROOT = join(PLUGIN_ROOT, '..');

const read = (abs: string): string => readFileSync(abs, 'utf8');
const readRel = (rel: string): string => read(join(REPO_ROOT, rel));

/** v0.8 命令面（恰 8；v0.7.0 起 6 个，v0.8.0 加 xc-checkpoint / xc-handoff）。 */
const EXPECTED_COMMANDS = [
  'xc-checkpoint', 'xc-dispatch', 'xc-handoff', 'xc-inbox',
  'xc-say', 'xc-status', 'xc-team', 'xc-work',
] as const;

/** v0.7 起工具面恰 10（AC6 黑盒集合的静态面；命令模板只许引用这些）。 */
const EXPECTED_TOOLS = [
  'xc_identify', 'xc_dispatch', 'xc_claim', 'xc_report', 'xc_read',
  'xc_relay', 'xc_overview', 'xc_team', 'xc_review', 'xc_doctor',
] as const;

/** 本组拥有的文档/技能面（平台缺口声明与版本走查的扫描范围）。
 *  v0.9.4 B3：README 瘦身——已知限制/威胁模型搬 docs/LIMITATIONS.md、版本记录搬 CHANGELOG.md，
 *  两个搬迁宿主一并纳入扫描范围（负例检查随之覆盖，防搬家变成宣称降级的漏洞）。 */
const DOC_SOURCES = ['README.md', 'docs/LIMITATIONS.md', 'CHANGELOG.md', 'docs/PROTOCOL.md', 'plugin/skills/longtask/SKILL.md', 'plugin/skills/crosschat/SKILL.md'] as const;

/** front-matter 解析：命令/技能 markdown 的 `--- ... ---` 头（无则抛）。 */
function frontMatter(text: string): string {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) throw new Error('missing YAML front-matter block');
  return m[1]!;
}

// ---------------------------------------------------------------------------
// 1. 命令面：恰 8
// ---------------------------------------------------------------------------

describe('A5 命令面：恰 8 个斜杠命令（v0.8.0 起 6 → 8）', () => {
  const commandDir = join(PLUGIN_ROOT, 'commands');
  const files = readdirSync(commandDir).filter((f) => f.endsWith('.md')).sort();

  it('commands/ 目录恰 8 个 .md（不多不少；防止存根复活或误删）', () => {
    expect(files.length).toBe(8);
    expect(files).toEqual([...EXPECTED_COMMANDS].map((c) => `${c}.md`).sort());
  });

  it('v0.7 的 6 个旧命令一个没少（合法流程不破坏）', () => {
    for (const cmd of ['xc-work', 'xc-dispatch', 'xc-inbox', 'xc-status', 'xc-team', 'xc-say']) {
      expect(existsSync(join(commandDir, `${cmd}.md`)), `${cmd}.md 应仍在`).toBe(true);
    }
  });

  it('/xc-agents、/xc-member 存根仍未复活（MIGRATION §3 承诺不被新命令破坏）', () => {
    expect(existsSync(join(commandDir, 'xc-agents.md'))).toBe(false);
    expect(existsSync(join(commandDir, 'xc-member.md'))).toBe(false);
  });

  it('8 个命令都有合法 front-matter（description / argument-hint / skills: crosschat）', () => {
    for (const cmd of EXPECTED_COMMANDS) {
      const text = read(join(commandDir, `${cmd}.md`));
      const fm = frontMatter(text);
      expect(fm, `${cmd} 缺 description`).toMatch(/^description: .+/m);
      expect(fm, `${cmd} 缺 argument-hint`).toMatch(/^argument-hint: /m);
      expect(fm, `${cmd} 未挂 crosschat 技能`).toMatch(/^skills: crosschat$/m);
      // 模板必须把 $ARGUMENTS 透传给技能协议（既有 6 个命令的同款契约）。
      expect(text, `${cmd} 缺 $ARGUMENTS 透传`).toContain('$ARGUMENTS');
    }
  });
});

// ---------------------------------------------------------------------------
// 2. /xc-checkpoint 模板冻结要点
// ---------------------------------------------------------------------------

describe('A5 /xc-checkpoint 命令模板（xc_team action:"checkpoint"，服务端落盘）', () => {
  const text = read(join(PLUGIN_ROOT, 'commands', 'xc-checkpoint.md'));

  it('调 xc_team({action:"checkpoint"[, note]})，并明说「服务端直接落盘、不要自己写文件」', () => {
    expect(text).toContain('xc_team({action:"checkpoint"');
    expect(text).toContain('note:"<上面的一句话备注>"');
    expect(text).toContain('由服务端直接落盘，不要自己写文件');
  });

  it('如实回报失败：写失败给错误码 checkpoint_write_failed + 恢复动作，不得声称已落盘', () => {
    expect(text).toContain('checkpoint_write_failed');
    expect(text).toContain('不得声称已落盘');
  });

  it('回报面 = path/bytes/开放任务数/未读数；容量 RED 时指向 longtask 压缩前 checklist', () => {
    expect(text).toContain('path');
    expect(text).toContain('bytes');
    expect(text).toContain('capacity.level = RED');
    expect(text).toContain('longtask');
  });

  it('description 指向落盘路径与七要素（模型可见面自明）', () => {
    expect(frontMatter(text)).toContain('.crosschat/checkpoints/<你>/');
  });
});

// ---------------------------------------------------------------------------
// 3. /xc-handoff 模板冻结要点
// ---------------------------------------------------------------------------

describe('A5 /xc-handoff 命令模板（xc_read scope:"handoff"，接手 ≤3 步）', () => {
  const text = read(join(PLUGIN_ROOT, 'commands', 'xc-handoff.md'));

  it('调 xc_read({scope:"handoff"[ , id]})，未注册先 identify（三步：identify → handoff → claim/续作）', () => {
    expect(text).toContain('xc_read({scope:"handoff"');
    expect(text).toContain('id:"<任务id或花名>"');
    expect(text).toContain('xc_identify');
    expect(text).toContain('接手三步：identify → handoff → claim/续作');
  });

  it('七要素渲染清单齐全（身份/任务/待领池/未读/容量/检查点/建议下一步）', () => {
    expect(text).toContain('我的任务（状态/attempt/最后进展/阻塞原因）');
    expect(text).toContain('待领池前 10');
    expect(text).toContain('未读摘要');
    expect(text).toContain('容量水位');
    expect(text).toContain('最近检查点路径与年龄');
    expect(text).toContain('建议下一步');
  });

  it('按 suggestions 行动：claim（单在途规则）/ unblock 或 cancel / 依赖记为等待项', () => {
    expect(text).toContain('xc_claim');
    expect(text).toContain('xc_team unblock');
    expect(text).toContain('等待项');
  });

  it('truncated 必须披露并给取全文指针，不得当作「没有这些内容」', () => {
    expect(text).toContain('truncated');
    expect(text).toContain('xc_read({scope:"inbox"})');
    expect(text).toContain('xc_overview');
    expect(text).toContain('xc_read({scope:"task"})');
    expect(text).toContain('不得当作「没有这些内容」');
  });
});

// ---------------------------------------------------------------------------
// 4. 命令模板只引用真实工具（防模板写错工具名 → 模型调一个不存在的工具）
// ---------------------------------------------------------------------------

describe('A5 命令模板引用的工具名都在 10 工具面内', () => {
  it('8 个模板里出现的 xc_* 具名工具 ⊆ EXPECTED_TOOLS', () => {
    const allowed = new Set<string>(EXPECTED_TOOLS);
    for (const cmd of EXPECTED_COMMANDS) {
      const text = read(join(PLUGIN_ROOT, 'commands', `${cmd}.md`));
      const found = new Set([...text.matchAll(/\bxc_[a-z_]+\b/g)].map((m) => m[0]));
      for (const name of found) {
        expect(allowed.has(name), `${cmd}.md 引用了不存在的工具 ${name}`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 5. longtask skill：接手三步 + 压缩前 checklist 三步序
// ---------------------------------------------------------------------------

describe('A5 longtask skill：接手模板与压缩前 checklist', () => {
  const text = readRel('plugin/skills/longtask/SKILL.md');

  it('§2 交接第 2 步 = xc_read({scope:"handoff"}) 一次拿全七要素（含 /xc-handoff 等价命令）', () => {
    expect(text).toContain('xc_read({ "scope": "handoff" })');
    expect(text).toContain('/xc-handoff');
    expect(text).toContain('一次拿全七要素');
  });

  it('一句话恢复模板钉死 ≤3 步口径（identify → /xc-handoff → claim/续作）', () => {
    expect(text).toContain('identify → /xc-handoff（xc_read handoff）→ 按建议下一步 claim/续作');
    expect(text).toContain('工具调用口径 = 3 次');
  });

  it('给出走不通的路径的替代：claim 只接 pending，他人的 in_progress/claimed/blocked 走 takeover 或等清扫', () => {
    expect(text).toContain('task_not_pending');
    expect(text).toContain('xc_identify({takeover:true})');
    expect(text).toContain('别发出走不通的指令');
  });

  it('压缩前 checklist 三步序：/xc-checkpoint 必须排在 journal 之前（顺序即纪律）', () => {
    const at = text.indexOf('/xc-checkpoint');
    const jt = text.indexOf('journal「当前进度」写全');
    const ct = text.indexOf('以上完成**之后**才接受压缩');
    expect(at).toBeGreaterThan(0);
    expect(jt).toBeGreaterThan(at);
    expect(ct).toBeGreaterThan(jt);
  });

  it('checkpoint 由服务端落盘且每 agent 保留最近 20 份（模板不教模型自己写文件）', () => {
    expect(text).toContain('服务端直接落盘');
    expect(text).toContain('不要自己写文件');
    expect(text).toContain('每 agent 保留最近 20 份');
  });

  it('如实声明平台无压缩钩子：插件只能「提醒 + 一键」，拦不住压缩本身', () => {
    expect(text).toContain('无压缩钩子（无 PreCompact/PostCompact）');
    expect(text).toContain('拦不住压缩本身');
    expect(text).toContain('XC_CHECKPOINT_NUDGE=0');
  });
});

// ---------------------------------------------------------------------------
// 6. crosschat skill：工具表 + 「交接与压缩防护」小节
// ---------------------------------------------------------------------------

describe('A5 crosschat skill：工具表与新小节', () => {
  const text = readRel('plugin/skills/crosschat/SKILL.md');

  it('§2 工具表补 xc_read scope:"handoff"', () => {
    expect(text).toContain('scope*`(inbox/mail/task/peer/peer-msg/journal/handoff)');
    expect(text).toContain('handoff=30 秒接手包');
  });

  it('§2 工具表补 xc_team action:"checkpoint" 与 xc_overview view:"timeline"/"status"', () => {
    expect(text).toContain('idle/cancel/unblock/checkpoint');
    expect(text).toContain('checkpoint 写一份交接检查点');
    expect(text).toContain('view?`(team/peers/panel/timeline/status)');
    expect(text).toContain('时间线（engine.jsonl 尾部事件');
    expect(text).toContain('紧凑状态（一眼瞭望，替代状态栏）');
  });

  it('新增「交接与压缩防护」小节：平台事实 + 一键 + 提醒（可关/30min/每 30min 最多一次）', () => {
    expect(text).toContain('## 10. 交接与压缩防护');
    expect(text).toContain('没有 PreCompact/PostCompact 钩子，也没有原生状态栏扩展点');
    expect(text).toContain('不提供自动压缩检查点、不提供状态栏');
    expect(text).toContain('XC_CHECKPOINT_NUDGE=0');
    expect(text).toContain('距上次检查点 >30min');
    expect(text).toContain('每 30min 最多一次');
  });

  it('接手三步 + truncated 披露 + 检查点文件不自动外发的权限边界都写进技能', () => {
    expect(text).toContain('≤3 次工具调用');
    expect(text).toContain('truncated');
    expect(text).toContain('插件不会把它自动发给任何会话');
    expect(text).toContain('按项目权限管理该目录');
  });
});

// ---------------------------------------------------------------------------
// 7. 文档：平台缺口如实声明 + 不宣称自动压缩钩子
// ---------------------------------------------------------------------------

describe('A5 文档：无 PreCompact，故用提醒+一键（ACCEPT15-1 文档走查）', () => {
  it('用户文档面与 PROTOCOL 都含原句「无 PreCompact」并说明降级方案', () => {
    // v0.9.4 B3：该原句随已知限制 16 搬去 docs/LIMITATIONS.md（README 只留指针）。
    expect(readRel('docs/LIMITATIONS.md')).toContain('无 PreCompact/PostCompact 钩子，故用「提醒 + 一键」');
    expect(readRel('docs/PROTOCOL.md')).toContain('无 PreCompact，故用「提醒 + 一键」');
  });

  it('已知限制与威胁模型各登记一条（检查点权限 + 平台缺口；v0.9.4 B3 起在 docs/LIMITATIONS.md）', () => {
    const limits = readRel('docs/LIMITATIONS.md');
    expect(limits).toContain('不提供自动压缩检查点');
    expect(limits).toContain('XC_CHECKPOINT_NUDGE=0');
    expect(limits).toContain('检查点文件按项目权限管理');
    expect(limits).toContain('插件不把它自动发给任何会话');
  });

  it('PROTOCOL §14 承载四件套（检查点格式/滚动 20/提醒五态、handoff 七要素+预算降级、timeline 事件族、status 行序）', () => {
    const protocol = readRel('docs/PROTOCOL.md');
    const s14 = protocol.split('## 14. 检查点、接手包与观测视图（v0.8）')[1] ?? '';
    expect(s14.length).toBeGreaterThan(0);
    expect(s14).toContain('CHECKPOINT_KEEP_MAX = 20');
    expect(s14).toContain('`agent` / `team` / `lead` / `createdAt` / `taskCounts` / `unread` / `capacity`');
    expect(s14).toContain('## 7. note');
    expect(s14).toContain('HANDOFF_BUDGET_CHARS = 4000');
    expect(s14).toContain('no-active-task');
    expect(s14).toContain('rate-limited');
    expect(s14).toContain('XC_CHECKPOINT_NUDGE');
    expect(s14).toContain('TAIL_READ_MAX_BYTES');
    expect(s14).toContain('member-provision-timeout');
    expect(s14).toContain('tasks: pending 2 / claimed 1');
  });

  it('PROTOCOL §1.1 磁盘布局与 §9 env 表登记 checkpoints 与 XC_CHECKPOINT_NUDGE', () => {
    const protocol = readRel('docs/PROTOCOL.md');
    expect(protocol).toContain('checkpoints/<agentKey>/<ISO>.md');
    expect(protocol).toContain('checkpoints/<agentKey>/.nudge');
    const envSection = protocol.split('## 9. 配置 env 全表')[1] ?? '';
    expect(envSection).toContain('XC_CHECKPOINT_NUDGE');
    expect(envSection).toContain('见 §14.2');
  });

  it('负例：PreCompact / 压缩钩子只以否定句式出现（不得宣称自动压缩钩子）', () => {
    for (const rel of DOC_SOURCES) {
      const text = readRel(rel);
      for (const line of text.split('\n')) {
        if (line.includes('PreCompact') || line.includes('压缩钩子')) {
          expect(line, `${rel} 出现非否定式的压缩钩子宣称：${line.trim()}`).toMatch(/无|不|没有|未能/);
        }
      }
    }
  });

  it('命令面与技能面都不含「自动压缩」承诺（自动二字只与「不/无」同现）', () => {
    for (const rel of [...DOC_SOURCES, 'plugin/commands/xc-checkpoint.md', 'plugin/commands/xc-handoff.md']) {
      for (const line of readRel(rel).split('\n')) {
        if (line.includes('自动压缩')) {
          expect(line, `${rel}：${line.trim()}`).toMatch(/无|不|没有|未能/);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 8. 版本五处统一（AC6 静态面）
// ---------------------------------------------------------------------------

describe('A5 版本五处统一 0.9.5', () => {
  it('package.json / plugin.json / marketplace.json / server.ts 四处 = 0.9.5', () => {
    expect(JSON.parse(readRel('plugin/package.json')).version).toBe('0.9.5');
    expect(JSON.parse(readRel('plugin/.zcode-plugin/plugin.json')).version).toBe('0.9.5');
    expect(JSON.parse(readRel('marketplace.json')).plugins[0].version).toBe('0.9.5');
    expect(readRel('plugin/src/mcp/server.ts')).toContain('const SERVER_VERSION = "0.9.5"');
  });

  // v0.9.5 集成注：四处版本文件已 0.9.5（41-v095 集成道随版本冻结就地同步本断言，
  // 即上行注解写明的「同步本断言」流程）；第五处（README 安装段）仍钉 0.9.2——同
  // v0.9.3/v0.9.4 冻先例留给发布 lane。
  // v0.9.3 集成注：第五处（README 安装段）仍钉 0.9.2——README 未随本次版本冻结改写
  // （发布 lane 的活：就地改资产名，并同步本断言）。四处版本文件已 0.9.3，本断言与
  // README 现状相符故绿；改 README 必须同步改这里。
  // v0.9.4 B3：版本记录整段搬去 CHANGELOG.md（README 只留指针）——版本条目断言改查
  // CHANGELOG；安装段（资产名/安装回显/命令面计数）仍钉 README。
  // v0.9.4 集成注：四处版本文件已 0.9.4（本 describe 上头两行）；第五处（README 安装段
  // 资产名/安装回显）仍钉 0.9.2——同 v0.9.3 冻先例留给发布 lane，同步改 README 时必须
  // 同步改这里。CHANGELOG 版本记录断言同样留 0.9.2/0.9.1/0.9.0（v0.9.4 条目由发布 lane
  // 随 notes 落笔后补钉）。
  it('README 安装段指向 0.9.2；CHANGELOG 版本记录含 0.9.2/0.9.1/0.9.0 条目（第五处）', () => {
    const readme = readRel('README.md');
    expect(readme).toContain('zcode-crosschat-0.9.2-prebuilt-slim.tar.gz');
    expect(readme).toContain('Installed plugin zcode-crosschat@dev-zcode-crosschat (0.9.2)');
    expect(readme).toContain('8 个斜杠命令');
    const changelog = readRel('CHANGELOG.md');
    expect(changelog).toContain('**v0.9.2**（2026-11-20，');
    expect(changelog).toContain('**v0.9.1**（2026-11-19，v0.8.1 首日生产实测第二批教训');
    expect(changelog).toContain('**v0.9.0**（2026-11-19，首日生产实测九缺口修复');
  });
});
