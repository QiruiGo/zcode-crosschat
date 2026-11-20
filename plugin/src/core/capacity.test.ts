/**
 * C3 capacity 单测（DESIGN-V0.6.md §3.3 / §4.2-M6；E3 §① 实测口径）：
 * - 分类纯函数（E3 ps-procs.ps1 判定顺序 1:1；v0.9.2 C1 起 headless-turn 只认唤醒子标记，
 *   原「命令行形态猜回合树」规则删除——README 文档化的用户 CLI 不再被误判 V091-13）；
 * - 预警公式 red1/red2/red3 + degraded 降级 + env 防御解析；
 * - 采样缓存窗口（XC_MEM_SAMPLE_MIN_MS）与损坏/未来缓存防御；
 * - parseCimRows 形态防御（数组/单对象/null CommandLine/垃圾输出）；
 * - 真机冒烟：takeFreshSample 形状不变式（不假设 ZCode 在场——降级与可信两态都合法）；
 * - C9 压缩联动（DESIGN-V0.7 §5）：verdict.red 时 formatCapacityLines 追加
 *   compress-advice 建议行，绿样本不追加。
 * - v0.7.2（C9-B3 修复）：缓存窗口内设备水位与 os.freemem() 交叉复核；
 * - v0.7.2（C9-B4 修复）：第三条标红规则 turn-concurrency 与 XC_TURN_ESTIMATE_BYTES
 *   在 README/PROTOCOL 登记（文档-行为一致性回归锁；红队 grep 0 命中）。
 * - v0.9.2（C2）：degraded 样本的面板文本把「常驻树/并发回合」显示为 n/a（未评），
 *   不显示会被读成断言的 0。
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyProcess,
  classifyZcodeProcesses,
  COMPRESS_ADVICE_LINE,
  formatCapacityLines,
  isWakeChildCommandLine,
  judgeCapacity,
  memSampleMinMsFromEnv,
  memSessionLimitBytesFromEnv,
  memWarnWatermarkFromEnv,
  memWarnWatermarkInfoFromEnv,
  parseCimRows,
  sampleCapacityWithSampler,
  takeFreshSample,
  turnEstimateBytesFromEnv,
  WAKE_CHILD_COMMAND_MARKER,
  WAKE_CHILD_ENV_MARKER,
  WAKE_CHILD_ENV_VALUE,
} from './capacity.js';
import type { CapacitySample, ProcRow } from './capacity.js';

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

function row(pid: number, name: string, commandLine: string, wsBytes = 100 * MB): ProcRow {
  return { pid, ppid: pid - 1, name, commandLine, wsBytes };
}

function sample(overrides: Partial<CapacitySample> = {}): CapacitySample {
  return {
    sampledAt: 1000,
    totalBytes: 32 * GB,
    freeBytes: 16 * GB,
    watermark: 0.5,
    steadyTreeBytes: Math.round(3.3 * GB),
    headlessTurnCount: 0,
    headlessTurnMaxRssBytes: null,
    degraded: null,
    ...overrides,
  };
}

describe('classifyProcess（E3 §① 分类口径）', () => {
  it('main：Electron 主进程（无 --type）', () => {
    expect(classifyProcess(row(1, 'ZCode.exe', '"E:\\ZCode\\ZCode.exe" --updated'))).toBe('main');
  });

  it('shell：--type=renderer/gpu/crashpad 等 Electron 壳进程', () => {
    expect(classifyProcess(row(2, 'ZCode.exe', 'ZCode.exe --type=renderer --user-data-dir=x'))).toBe('shell');
    expect(classifyProcess(row(3, 'ZCode.exe', 'ZCode.exe --type=gpu-process'))).toBe('shell');
    expect(classifyProcess(row(4, 'ZCode.exe', 'ZCode.exe --type=crashpad-handler'))).toBe('shell');
  });

  it('cli-utility：--utility-sub-type（node.mojom.NodeService 等）', () => {
    expect(classifyProcess(row(5, 'ZCode.exe', 'ZCode.exe --type=utility --utility-sub-type=node.mojom.NodeService'))).toBe('cli-utility');
  });

  it('plugin-host：__zcode-plugin-host 标记', () => {
    expect(classifyProcess(row(6, 'ZCode.exe', 'ZCode.exe node.mjs __zcode-plugin-host documents'))).toBe('plugin-host');
  });

  it('desktop-appserver / headless-appserver：app-server 按 --surface 分', () => {
    expect(classifyProcess(row(7, 'ZCode.exe', 'ZCode.exe zcode.cjs app-server --stdio --surface desktop'))).toBe('desktop-appserver');
    expect(classifyProcess(row(8, 'ZCode.exe', 'ZCode.exe zcode.cjs app-server --stdio'))).toBe('headless-appserver');
  });

  it('headless-turn：只认唤醒子标记（v0.9.2 C1；命令行带唤醒回执前缀即回合树）', () => {
    // 唤醒 prompt 恒以 DESIGN §2.4 冻结回执前缀开头 → 随 --prompt 进命令行。
    expect(classifyProcess(row(9, 'ZCode.exe', 'ZCode.exe E:\\ZCode\\resources\\glm\\zcode.cjs --resume sess_x --prompt "[CrossChat inbox receipt: {"teamId":"default","recipient":"b","ids":["m1"]}]\n\n身份行" --cwd D:\\ws --output-format json'))).toBe('headless-turn');
  });

  it('v0.9.2（C1/V091-13）：用户自己的 zcode CLI 不再被误归 headless-turn', () => {
    // README 文档化的 ZC/zc 壳函数形态：与唤醒子命令行同形，但无唤醒子标记。
    expect(classifyProcess(row(10, 'ZCode.exe', 'ZCode.exe E:\\ZCode\\resources\\glm\\zcode.cjs --resume sess_x -p --mode yolo'))).toBe('main');
    expect(classifyProcess(row(15, 'ZCode.exe', 'ZCode.exe zcode.cjs --version'))).toBe('main');
    // 原第⑥步的其余同形形态一并回归 main（宁漏计并发回合，不制造假红）。
    expect(classifyProcess(row(16, 'ZCode.exe', 'ZCode.exe zcode.cjs app-server --stdio'))).toBe('headless-appserver');
  });

  it('v0.9.2（C1）：唤醒子标记先于一切形态规则（renderer 带标记仍归回合树）', () => {
    expect(classifyProcess(row(17, 'ZCode.exe', 'ZCode.exe --type=renderer --x=[CrossChat inbox receipt: '))).toBe('headless-turn');
  });

  it('--type 先于 cjs 规则：renderer 引用 zcode.cjs 不误归回合树', () => {
    expect(classifyProcess(row(11, 'ZCode.exe', 'ZCode.exe --type=renderer --x=zcode.cjs'))).toBe('shell');
  });

  it('plugin-host 与 app-server 的判定都先于 headless-turn', () => {
    expect(classifyProcess(row(12, 'ZCode.exe', 'ZCode.exe zcode.cjs __zcode-plugin-host'))).toBe('plugin-host');
    expect(classifyProcess(row(13, 'ZCode.exe', 'ZCode.exe zcode.cjs app-server'))).toBe('headless-appserver');
  });

  it('isWakeChildCommandLine：非字符串/空串不抛错', () => {
    expect(isWakeChildCommandLine(undefined)).toBe(false);
    expect(isWakeChildCommandLine('')).toBe(false);
    expect(isWakeChildCommandLine(WAKE_CHILD_COMMAND_MARKER)).toBe(true);
  });

  it('CommandLine 缺失（CIM 权限受限）→ 安全归 main 不抛错', () => {
    expect(classifyProcess(row(14, 'ZCode.exe', ''))).toBe('main');
  });
});

describe('classifyZcodeProcesses（稳态/瞬态两列口径）', () => {
  it('steadyTreeBytes 只含五类常驻；headless-turn 计数与峰值独立', () => {
    const tree = classifyZcodeProcesses([
      row(1, 'ZCode.exe', 'ZCode.exe --updated', 300 * MB), // main
      row(2, 'ZCode.exe', 'ZCode.exe --type=renderer', 875 * MB), // shell
      row(3, 'ZCode.exe', 'ZCode.exe --type=utility --utility-sub-type=node.mojom.NodeService', 351 * MB), // cli-utility
      row(4, 'ZCode.exe', 'ZCode.exe zcode.cjs app-server --stdio --surface desktop', 200 * MB), // desktop-appserver
      row(5, 'ZCode.exe', 'ZCode.exe zcode.cjs __zcode-plugin-host', 170 * MB), // plugin-host
      // v0.9.2（C1）：唤醒子 = 命令行带唤醒回执标记的 --resume 树。
      row(6, 'ZCode.exe', 'ZCode.exe zcode.cjs --resume s1 --prompt "[CrossChat inbox receipt: {...}]" --output-format json', 300 * MB), // headless-turn
      row(7, 'ZCode.exe', 'ZCode.exe zcode.cjs app-server --stdio', 240 * MB), // headless-appserver（临时 keeper，不计常驻）
    ]);
    const steady = 300 + 875 + 351 + 200 + 170; // MB
    expect(tree.steadyTreeBytes).toBe(steady * MB);
    expect(tree.headlessTurnCount).toBe(1);
    expect(tree.headlessTurnMaxRssBytes).toBe(300 * MB);
    expect(tree.categories['headless-appserver'].count).toBe(1);
    expect(tree.categories['main'].count).toBe(1);
  });

  it('多个并发回合树：计数累加、峰值取最大', () => {
    const tree = classifyZcodeProcesses([
      row(1, 'ZCode.exe', `zcode.cjs --resume a --prompt "[CrossChat inbox receipt: a]"`, 250 * MB),
      row(2, 'ZCode.exe', `zcode.cjs --resume b --prompt "[CrossChat inbox receipt: b]"`, 640 * MB),
      row(3, 'ZCode.exe', `zcode.cjs --resume c --prompt "[CrossChat inbox receipt: c]"`, 310 * MB),
    ]);
    expect(tree.headlessTurnCount).toBe(3);
    expect(tree.headlessTurnMaxRssBytes).toBe(640 * MB);
    expect(tree.steadyTreeBytes).toBe(0);
  });

  it('v0.9.2（C1/V091-13）：用户 CLI 与唤醒子混在时只计唤醒子（不再误伤）', () => {
    const tree = classifyZcodeProcesses([
      row(1, 'ZCode.exe', 'ZCode.exe E:\\ZCode\\resources\\glm\\zcode.cjs --resume sess_x -p --mode yolo', 900 * MB), // 用户 CLI：900MB
      row(2, 'ZCode.exe', 'ZCode.exe zcode.cjs --resume s1 --prompt "[CrossChat inbox receipt: x]"', 300 * MB), // 唤醒子
    ]);
    expect(tree.categories['main'].count).toBe(1); // 用户 CLI 归 main（常驻列，不参与 red2/red3）
    expect(tree.headlessTurnCount).toBe(1);
    expect(tree.headlessTurnMaxRssBytes).toBe(300 * MB); // 900MB 的用户 CLI 不再触发 session-limit
  });

  it('无回合树：headlessTurnMaxRssBytes=null', () => {
    const tree = classifyZcodeProcesses([row(1, 'ZCode.exe', 'ZCode.exe --updated', 300 * MB)]);
    expect(tree.headlessTurnCount).toBe(0);
    expect(tree.headlessTurnMaxRssBytes).toBeNull();
    expect(tree.steadyTreeBytes).toBe(300 * MB);
  });
});

describe('judgeCapacity（DESIGN §3.3 公式）', () => {
  it('red1：水位低于阈值标红，detail 给出规则与数字', () => {
    const v = judgeCapacity(sample({ freeBytes: 3.2 * GB, watermark: 0.1 }), {});
    expect(v.red).toBe(true);
    expect(v.violated).toEqual(['watermark']);
    expect(v.detail[0]).toContain('watermark');
    expect(v.detail[0]).toContain('10.0%');
  });

  it('red1 之上且无回合数据 → 不标红', () => {
    const v = judgeCapacity(sample(), {});
    expect(v.red).toBe(false);
    expect(v.violated).toEqual([]);
    expect(v.detail).toEqual([]);
  });

  it('red2：headless-turn 单进程 WS 超 800MB 上限', () => {
    const v = judgeCapacity(sample({ headlessTurnCount: 1, headlessTurnMaxRssBytes: 900 * MB }), {});
    expect(v.red).toBe(true);
    expect(v.violated).toEqual(['session-limit']);
    expect(v.detail[0]).toContain('session-limit');
    expect(v.detail[0]).toContain('900.0MB');
  });

  it('red2 不触发：峰值恰在限内（=上限不违）', () => {
    const v = judgeCapacity(sample({ headlessTurnCount: 1, headlessTurnMaxRssBytes: 800 * MB }), {});
    expect(v.violated).toEqual([]);
  });

  it('red3：并发回合 × 单回合预估 > 可用内存', () => {
    // 20 回合 × 1.5GB = 30GB > 16GB 可用（E3：每并发成员回合瞬时 +~1.5GB）
    const v = judgeCapacity(sample({ headlessTurnCount: 20, headlessTurnMaxRssBytes: 100 * MB }), {});
    expect(v.red).toBe(true);
    expect(v.violated).toEqual(['turn-concurrency']);
    expect(v.detail[0]).toContain('turn-concurrency');
  });

  it('red3 不触发：回合少且可用充裕', () => {
    const v = judgeCapacity(sample({ headlessTurnCount: 2, headlessTurnMaxRssBytes: 100 * MB }), {});
    expect(v.violated).toEqual([]);
  });

  it('多规则并列：violated 收集全部', () => {
    const v = judgeCapacity(
      sample({ freeBytes: 1 * GB, watermark: 1 / 32, headlessTurnCount: 10, headlessTurnMaxRssBytes: 900 * MB }),
      {},
    );
    expect(v.red).toBe(true);
    expect(v.violated).toEqual(['watermark', 'session-limit', 'turn-concurrency']);
    expect(v.detail).toHaveLength(3);
  });

  it('degraded：只评水位，进程类规则一律不评且 detail 声明降级', () => {
    const v = judgeCapacity(
      sample({ degraded: 'cim-unavailable', headlessTurnCount: 99, headlessTurnMaxRssBytes: 100 * GB }),
      {},
    );
    expect(v.red).toBe(false);
    expect(v.violated).toEqual([]);
    expect(v.detail).toHaveLength(1);
    expect(v.detail[0]).toContain('degraded');
    expect(v.detail[0]).toContain('CIM 进程采样不可用');
  });

  it('degraded 且水位红灯：red1 照常评', () => {
    const v = judgeCapacity(sample({ freeBytes: 1 * GB, watermark: 1 / 32, degraded: 'cim-unavailable' }), {});
    expect(v.red).toBe(true);
    expect(v.violated).toEqual(['watermark']);
    expect(v.detail).toHaveLength(2);
  });
});

describe('env 阈值解析（防御口径）', () => {
  it('XC_MEM_WARN_WATERMARK：合法覆盖、越界/非法/未设回缺省', () => {
    expect(memWarnWatermarkFromEnv({ XC_MEM_WARN_WATERMARK: '0.3' })).toBe(0.3);
    expect(memWarnWatermarkFromEnv({ XC_MEM_WARN_WATERMARK: '0' })).toBe(0.15);
    expect(memWarnWatermarkFromEnv({ XC_MEM_WARN_WATERMARK: '1' })).toBe(0.15);
    expect(memWarnWatermarkFromEnv({ XC_MEM_WARN_WATERMARK: '1.5' })).toBe(0.15);
    expect(memWarnWatermarkFromEnv({ XC_MEM_WARN_WATERMARK: 'abc' })).toBe(0.15);
    expect(memWarnWatermarkFromEnv({})).toBe(0.15);
    // 场景⑥制造预警的手段：调低到 0.999 → 常态即红
    const v = judgeCapacity(sample(), { XC_MEM_WARN_WATERMARK: '0.999' });
    expect(v.violated).toEqual(['watermark']);
  });

  it('v0.8.1（C4-O1）：memWarnWatermarkInfoFromEnv 分辨「越界已回落」与「未设置」', () => {
    // 合法域 (0,1) 内精细生效，不标记回落
    expect(memWarnWatermarkInfoFromEnv({ XC_MEM_WARN_WATERMARK: '0.3' })).toEqual({ watermark: 0.3, fellBack: false });
    expect(memWarnWatermarkInfoFromEnv({ XC_MEM_WARN_WATERMARK: '0.999' })).toEqual({ watermark: 0.999, fellBack: false });
    // 越界（≥1 全部值 + 0/负数/非数字）→ 回落缺省 0.15 且 fellBack:true（挂载面两级披露）
    for (const bad of ['1', '1.5', '2', '0', '-5', 'abc']) {
      expect(memWarnWatermarkInfoFromEnv({ XC_MEM_WARN_WATERMARK: bad })).toEqual({ watermark: 0.15, fellBack: true });
    }
    // 未设置/空串 = 就是缺省，无需披露
    expect(memWarnWatermarkInfoFromEnv({})).toEqual({ watermark: 0.15, fellBack: false });
    expect(memWarnWatermarkInfoFromEnv({ XC_MEM_WARN_WATERMARK: '' })).toEqual({ watermark: 0.15, fellBack: false });
    // 数值版保持兼容（红队 O1 子 claim：越界值按缺省判定，比较连续不钳）
    expect(memWarnWatermarkFromEnv({ XC_MEM_WARN_WATERMARK: '2' })).toBe(0.15);
  });

  it('XC_MEM_SESSION_LIMIT_BYTES / XC_TURN_ESTIMATE_BYTES：合法覆盖、非法回缺省', () => {
    expect(memSessionLimitBytesFromEnv({ XC_MEM_SESSION_LIMIT_BYTES: '1048576' })).toBe(MB);
    expect(memSessionLimitBytesFromEnv({ XC_MEM_SESSION_LIMIT_BYTES: '-1' })).toBe(800 * MB);
    expect(memSessionLimitBytesFromEnv({})).toBe(800 * MB);
    expect(turnEstimateBytesFromEnv({ XC_TURN_ESTIMATE_BYTES: '1' })).toBe(1);
    expect(turnEstimateBytesFromEnv({ XC_TURN_ESTIMATE_BYTES: 'NaN' })).toBe(Math.round(1.5 * GB));
    expect(turnEstimateBytesFromEnv({})).toBe(Math.round(1.5 * GB));
  });

  it('XC_MEM_SAMPLE_MIN_MS：0=不缓存合法，负数/非法回 60s', () => {
    expect(memSampleMinMsFromEnv({ XC_MEM_SAMPLE_MIN_MS: '0' })).toBe(0);
    expect(memSampleMinMsFromEnv({ XC_MEM_SAMPLE_MIN_MS: '5000' })).toBe(5000);
    expect(memSampleMinMsFromEnv({ XC_MEM_SAMPLE_MIN_MS: '-3' })).toBe(60_000);
    expect(memSampleMinMsFromEnv({ XC_MEM_SAMPLE_MIN_MS: 'x' })).toBe(60_000);
    expect(memSampleMinMsFromEnv({})).toBe(60_000);
  });
});

describe('parseCimRows（PS stdout 形态防御）', () => {
  it('数组形态：全字段行 + null CommandLine 行', () => {
    const rows = parseCimRows(
      JSON.stringify([
        { ProcessId: 1, ParentProcessId: 0, Name: 'ZCode.exe', CommandLine: 'ZCode.exe --updated', WorkingSetSize: 314572800 },
        { ProcessId: 2, ParentProcessId: 1, Name: 'ZCode.exe', CommandLine: null, WorkingSetSize: 100 },
      ]),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ pid: 1, commandLine: 'ZCode.exe --updated', wsBytes: 314572800 });
    expect(rows[1]).toMatchObject({ pid: 2, commandLine: '', wsBytes: 100 });
  });

  it('单对象形态（ConvertTo-Json 不加数组）→ 包装为一行', () => {
    const rows = parseCimRows(JSON.stringify({ ProcessId: 7, ParentProcessId: 0, Name: 'ZCode.exe', CommandLine: 'x', WorkingSetSize: 5 }));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.pid).toBe(7);
  });

  it('空输出/垃圾/缺字段行 → 空（调用方按 CIM 失败降级）', () => {
    expect(parseCimRows('')).toEqual([]);
    expect(parseCimRows('   \n  ')).toEqual([]);
    expect(parseCimRows('not-json{')).toEqual([]);
    expect(parseCimRows(JSON.stringify([{ ProcessId: 'x', WorkingSetSize: 'y' }]))).toEqual([]);
    expect(parseCimRows(JSON.stringify([{ ProcessId: 3, WorkingSetSize: -5 }]))).toEqual([]);
  });
});

describe('sampleCapacity 缓存窗口（XC_MEM_SAMPLE_MIN_MS）', () => {
  const dirs: string[] = [];
  function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'xc-capacity-'));
    dirs.push(dir);
    return dir;
  }
  function cleanup(): void {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* 尽力而为 */
      }
    }
  }

  it('窗口内回缓存（sampler 不再触发，sampledAt 保留首次真采样时刻）', async () => {
    try {
      const cacheFile = join(tmp(), 'capacity', 'sample.json'); // 嵌套目录不存在，验证 mkdir
      let calls = 0;
      const sampler = (now: number): CapacitySample => {
        calls += 1;
        return { ...sample({ sampledAt: now, steadyTreeBytes: 1 }) };
      };
      const a = await sampleCapacityWithSampler({}, cacheFile, 1000, sampler);
      expect(calls).toBe(1);
      expect(a.sampledAt).toBe(1000);
      expect(existsSync(cacheFile)).toBe(true);
      const b = await sampleCapacityWithSampler({}, cacheFile, 1000 + 59_999, sampler);
      expect(calls).toBe(1);
      expect(b.sampledAt).toBe(1000);
      const c = await sampleCapacityWithSampler({}, cacheFile, 1000 + 60_001, sampler);
      expect(calls).toBe(2);
      expect(c.sampledAt).toBe(1000 + 60_001);
    } finally {
      cleanup();
    }
  });

  it('XC_MEM_SAMPLE_MIN_MS=0 → 每次真采样', async () => {
    try {
      const cacheFile = join(tmp(), 'sample.json');
      let calls = 0;
      const sampler = (now: number): CapacitySample => {
        calls += 1;
        return sample({ sampledAt: now });
      };
      await sampleCapacityWithSampler({ XC_MEM_SAMPLE_MIN_MS: '0' }, cacheFile, 1000, sampler);
      await sampleCapacityWithSampler({ XC_MEM_SAMPLE_MIN_MS: '0' }, cacheFile, 2000, sampler);
      expect(calls).toBe(2);
    } finally {
      cleanup();
    }
  });

  it('缓存损坏 JSON / 未来时间戳 → 视为无效重采样', async () => {
    try {
      const dir = tmp();
      const cacheFile = join(dir, 'sample.json');
      writeFileSync(cacheFile, '{corrupt', 'utf8');
      let calls = 0;
      const sampler = (now: number): CapacitySample => {
        calls += 1;
        return sample({ sampledAt: now });
      };
      const a = await sampleCapacityWithSampler({}, cacheFile, 1000, sampler);
      expect(calls).toBe(1);
      expect(a.sampledAt).toBe(1000);
      writeFileSync(cacheFile, JSON.stringify({ ...sample({ sampledAt: 5000 }) }), 'utf8'); // sampledAt > now
      const b = await sampleCapacityWithSampler({}, cacheFile, 1000, sampler);
      expect(calls).toBe(2);
      expect(b.sampledAt).toBe(1000);
    } finally {
      cleanup();
    }
  });

  it('缓存命中还原 degraded 与 categoryCounts', async () => {
    try {
      const dir = tmp();
      const cacheFile = join(dir, 'sample.json');
      const degraded: CapacitySample = {
        sampledAt: 1000,
        totalBytes: 10,
        freeBytes: 5,
        watermark: 0.5,
        steadyTreeBytes: null,
        headlessTurnCount: 0,
        headlessTurnMaxRssBytes: null,
        degraded: 'cim-unavailable',
      };
      const sampler = (): CapacitySample => degraded;
      // osReader 注入同一组设备读数：隔离出「缓存还原」语义本身（不掺真实机器波动）。
      const osReader = (): { totalBytes: number; freeBytes: number } => ({ totalBytes: 10, freeBytes: 5 });
      const first = await sampleCapacityWithSampler({}, cacheFile, 1000, sampler, osReader);
      expect(first.degraded).toBe('cim-unavailable');
      const cached = await sampleCapacityWithSampler({}, cacheFile, 1000 + 1000, sampler, osReader);
      expect(cached).toEqual(degraded);
    } finally {
      cleanup();
    }
  });

  // v0.7.2（C9-B3 修复）：窗口内缓存命中的设备水位字段必须与 os.freemem() 交叉复核，
  // 缓存不再被逐字信任——伪造「100% 可用」的新鲜缓存不得制造假 GREEN。
  it('窗口内缓存命中：设备水位与 os.freemem 交叉复核（C9-B3，伪造缓存不得制造虚假读数）', async () => {
    try {
      const dir = tmp();
      const cacheFile = join(dir, 'sample.json');
      const poisoned: CapacitySample = {
        sampledAt: 1000,
        totalBytes: 32 * GB,
        freeBytes: 32 * GB, // 声称 100% 可用
        watermark: 1,
        steadyTreeBytes: 1000,
        headlessTurnCount: 0,
        headlessTurnMaxRssBytes: null,
        degraded: null,
        categoryCounts: { main: 1 },
      };
      writeFileSync(cacheFile, JSON.stringify(poisoned), 'utf8');
      let calls = 0;
      const sampler = (now: number): CapacitySample => {
        calls += 1;
        return sample({ sampledAt: now });
      };
      // 真实机器此刻只剩 ~20%：缓存说 100%，交叉复核后必须报真实水位
      const osReader = (): { totalBytes: number; freeBytes: number } => ({ totalBytes: 32 * GB, freeBytes: Math.round(0.2 * 32 * GB) });
      const b = await sampleCapacityWithSampler({}, cacheFile, 1000 + 59_999, sampler, osReader);
      expect(calls).toBe(0); // 仍在窗口内：进程树不重采（缓存仍省 CIM 成本）
      expect(b.sampledAt).toBe(1000); // sampledAt 保持进程树真采样时刻
      expect(b.watermark).toBeCloseTo(0.2, 5); // 水位来自实时 os.freemem，不是缓存的 1
      expect(b.freeBytes).toBe(Math.round(0.2 * 32 * GB));
      expect(b.steadyTreeBytes).toBe(1000); // 进程树字段仍取缓存（CIM 才是缓存要省的成本）
      expect(judgeCapacity(b, { XC_MEM_WARN_WATERMARK: '0.25' }).violated).toContain('watermark'); // 不会被钉成假 GREEN
    } finally {
      cleanup();
    }
  });

  it('窗口内缓存命中：osReader 异常/非法读数 → 回落缓存值（不崩、不虚报）', async () => {
    try {
      const dir = tmp();
      const cacheFile = join(dir, 'sample.json');
      const cachedSample = sample({ sampledAt: 1000 });
      writeFileSync(cacheFile, JSON.stringify(cachedSample), 'utf8');
      const sampler = (now: number): CapacitySample => sample({ sampledAt: now });
      const b = await sampleCapacityWithSampler(
        {},
        cacheFile,
        1000 + 1000,
        sampler,
        () => ({ totalBytes: Number.NaN, freeBytes: -1 }),
      );
      expect(b.totalBytes).toBe(cachedSample.totalBytes);
      expect(b.freeBytes).toBe(cachedSample.freeBytes);
      expect(b.watermark).toBe(cachedSample.watermark);
    } finally {
      cleanup();
    }
  });
});

describe('formatCapacityLines（panel 直出文本）', () => {
  it('绿样本：一行摘要，无 detail、无压缩建议行', () => {
    const s = sample();
    const lines = formatCapacityLines(s, judgeCapacity(s, {}));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('GREEN');
    expect(lines[0]).toContain('50.0%');
    expect(lines.some((l) => l.startsWith('compress-advice:'))).toBe(false);
  });

  it('红样本：RED 头 + violated detail 逐行', () => {
    const s = sample({ headlessTurnCount: 1, headlessTurnMaxRssBytes: 900 * MB });
    const lines = formatCapacityLines(s, judgeCapacity(s, {}));
    expect(lines[0]).toContain('RED');
    expect(lines).toHaveLength(3); // 摘要 + session-limit detail + C9 压缩建议行
    expect(lines[1]).toContain('session-limit');
  });

  // C9（DESIGN-V0.7.md §5）：标红追加固定压缩建议行（longtask checklist + lead 操作序）。
  it('红样本：追加 compress-advice 建议行（文案与导出的常量一致）', () => {
    const s = sample({ headlessTurnCount: 1, headlessTurnMaxRssBytes: 900 * MB });
    const lines = formatCapacityLines(s, judgeCapacity(s, {}));
    expect(lines[lines.length - 1]).toBe(COMPRESS_ADVICE_LINE);
    expect(lines[lines.length - 1]).toContain('longtask checklist');
    expect(lines[lines.length - 1]).toContain('journal');
    expect(lines[lines.length - 1]).toContain('xc_report(status:"in_progress")');
  });

  it('degraded 红样本（仅水位红灯）同样给建议行', () => {
    const s = sample({ freeBytes: 1 * GB, watermark: 1 / 32, degraded: 'cim-unavailable' });
    const lines = formatCapacityLines(s, judgeCapacity(s, {}));
    expect(lines[0]).toContain('RED');
    expect(lines[lines.length - 1]).toBe(COMPRESS_ADVICE_LINE);
  });

  // v0.9.2（C2/V091-14）：degraded 样本的进程类数字不得显示成「0」——0 会被读成
  // 「此刻没有无头回合」的断言，而 CIM 失败时这个数根本不可知。
  it('degraded 绿样本：并发回合/常驻树显示 n/a（未评）而不是 0，且 detail 声明未评', () => {
    const s = sample({ degraded: 'cim-unavailable', headlessTurnCount: 0, headlessTurnMaxRssBytes: null });
    const v = judgeCapacity(s, {});
    expect(v.red).toBe(false); // 只评水位 → 绿
    expect(v.violated).toEqual([]);
    const lines = formatCapacityLines(s, v);
    expect(lines[0]).toContain('GREEN');
    expect(lines[0]).toContain('并发回合 n/a（CIM 进程采样不可用，未评）');
    expect(lines[0]).not.toContain('并发回合 0');
    expect(lines[0]).toContain('常驻树 n/a（CIM 进程采样不可用，未评）');
    expect(lines.join('\n')).toContain('进程类规则（session-limit/turn-concurrency）未评');
  });

  it('degraded 样本不因进程数据缺失而虚报绿/红（判据只吃可信字段）', () => {
    // 缓存里可能带着上一次成功采样的进程数字 + degraded 标记：judgeCapacity 不得据此判定。
    const s = sample({ degraded: 'cim-unavailable', headlessTurnCount: 99, headlessTurnMaxRssBytes: 100 * GB });
    const v = judgeCapacity(s, {});
    expect(v.violated).toEqual([]);
    expect(v.red).toBe(false);
  });
});

describe('v0.9.2 C1 唤醒子标记常量（env 标记与命令行标记同族）', () => {
  it('env 标记键值是 XC_WAKE_CHILD=1（spawnResume 注入侧同名对拍）', () => {
    expect(WAKE_CHILD_ENV_MARKER).toBe('XC_WAKE_CHILD');
    expect(WAKE_CHILD_ENV_VALUE).toBe('1');
  });

  it('命令行标记 = 唤醒 prompt 的冻结回执前缀（与 core/mailbox.ts 同源）', () => {
    expect(WAKE_CHILD_COMMAND_MARKER).toBe('[CrossChat inbox receipt: ');
  });
});

// v0.7.2（C9-B4 修复）：第三条标红规则 turn-concurrency 与 XC_TURN_ESTIMATE_BYTES
// 必须在公开文档登记——红队实证「文档 grep 0 命中」，运维面对标红无法解释无法调参。
describe('文档登记：turn-concurrency 规则与 XC_TURN_ESTIMATE_BYTES（C9-B4）', () => {
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8');
  const readme = read('README.md');
  const protocol = read('docs/PROTOCOL.md');
  const demo = read('docs/DEMO.md');

  it('README 的 C9 段落登记三条规则与三个 env', () => {
    expect(readme).toContain('XC_TURN_ESTIMATE_BYTES');
    expect(readme).toContain('XC_MEM_WARN_WATERMARK');
    expect(readme).toContain('XC_MEM_SESSION_LIMIT_BYTES');
    expect(readme).toContain('并发 headless 回合数 × 单回合预估');
  });

  it('PROTOCOL §5 预警规则列全三条（含 turn-concurrency 判据）', () => {
    expect(protocol).toContain('turn-concurrency');
    expect(protocol).toContain('XC_TURN_ESTIMATE_BYTES');
    expect(protocol).toContain('并发 headless 回合数 ×');
  });

  it('PROTOCOL §9 env 全表登记 XC_TURN_ESTIMATE_BYTES（含缺省 1.5GB 口径）', () => {
    const envSection = protocol.split('## 9. 配置 env 全表')[1] ?? '';
    expect(envSection).toContain('XC_TURN_ESTIMATE_BYTES');
    expect(envSection).toContain('1.5GB');
  });

  it('DEMO 不含容量承诺歧义（未登记时不出现半截规则描述）', () => {
    // DEMO 不展开容量规则；一旦展开就必须带 env 名，避免出现无法调参的标红描述。
    if (/水位|容量/.test(demo)) {
      expect(demo).toContain('XC_MEM_WARN_WATERMARK');
    }
  });
});

describe('真机冒烟：takeFreshSample 形状不变式', () => {
  // 不假设环境（ZCode 在场与否都可）：要么 degraded 诚实标注，要么数据自洽。
  it('os 水位恒在；CIM 成功时分类计数非空、失败时 degraded 标注', async () => {
    const s = await takeFreshSample();
    expect(s.totalBytes).toBeGreaterThan(0);
    expect(s.freeBytes).toBeGreaterThan(0);
    expect(s.freeBytes).toBeLessThanOrEqual(s.totalBytes);
    expect(s.watermark).toBeGreaterThan(0);
    expect(s.watermark).toBeLessThanOrEqual(1);
    expect(s.sampledAt).toBeGreaterThan(0);
    if (s.degraded === null) {
      // 本插件自身进程（ZCode.exe 映像的插件宿主）必然在树里 → 常驻非零
      expect(s.steadyTreeBytes).toBeGreaterThan(0);
      expect(s.headlessTurnCount).toBeGreaterThanOrEqual(0);
      expect(s.categoryCounts).toBeDefined();
      expect(Object.keys(s.categoryCounts ?? {}).length).toBeGreaterThan(0);
    } else {
      expect(s.degraded).toBe('cim-unavailable');
      expect(s.steadyTreeBytes).toBeNull();
      expect(s.headlessTurnMaxRssBytes).toBeNull();
    }
  }, 30_000);

  it('真机样本过判定不抛错，且 panel 文本可生成', async () => {
    const s = await takeFreshSample();
    const v = judgeCapacity(s, {});
    const lines = formatCapacityLines(s, v);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]).toMatch(/capacity: (RED|GREEN)/);
  }, 30_000);
});
