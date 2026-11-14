/**
 * C3 capacity 单测（DESIGN-V0.6.md §3.3 / §4.2-M6；E3 §① 实测口径）：
 * - 分类纯函数（E3 ps-procs.ps1 判定顺序 1:1，含踩坑 3 的 headless-turn 判定）；
 * - 预警公式 red1/red2/red3 + degraded 降级 + env 防御解析；
 * - 采样缓存窗口（XC_MEM_SAMPLE_MIN_MS）与损坏/未来缓存防御；
 * - parseCimRows 形态防御（数组/单对象/null CommandLine/垃圾输出）；
 * - 真机冒烟：takeFreshSample 形状不变式（不假设 ZCode 在场——降级与可信两态都合法）。
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyProcess,
  classifyZcodeProcesses,
  formatCapacityLines,
  judgeCapacity,
  memSampleMinMsFromEnv,
  memSessionLimitBytesFromEnv,
  memWarnWatermarkFromEnv,
  parseCimRows,
  sampleCapacityWithSampler,
  takeFreshSample,
  turnEstimateBytesFromEnv,
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

  it('headless-turn：zcode.cjs ∧ ¬app-server ∧ ¬--surface（E3 踩坑 3）', () => {
    expect(classifyProcess(row(9, 'ZCode.exe', 'ZCode.exe E:\\ZCode\\resources\\glm\\zcode.cjs --resume sess_x -p --mode yolo'))).toBe('headless-turn');
    expect(classifyProcess(row(10, 'ZCode.exe', 'ZCode.exe zcode.cjs --version'))).toBe('headless-turn');
  });

  it('--type 先于 cjs 规则：renderer 引用 zcode.cjs 不误归回合树', () => {
    expect(classifyProcess(row(11, 'ZCode.exe', 'ZCode.exe --type=renderer --x=zcode.cjs'))).toBe('shell');
  });

  it('plugin-host 与 app-server 的判定都先于 headless-turn', () => {
    expect(classifyProcess(row(12, 'ZCode.exe', 'ZCode.exe zcode.cjs __zcode-plugin-host'))).toBe('plugin-host');
    expect(classifyProcess(row(13, 'ZCode.exe', 'ZCode.exe zcode.cjs app-server'))).toBe('headless-appserver');
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
      row(6, 'ZCode.exe', 'ZCode.exe zcode.cjs --resume s1 -p', 300 * MB), // headless-turn
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
      row(1, 'ZCode.exe', 'zcode.cjs --resume a', 250 * MB),
      row(2, 'ZCode.exe', 'zcode.cjs --resume b', 640 * MB),
      row(3, 'ZCode.exe', 'zcode.cjs --resume c', 310 * MB),
    ]);
    expect(tree.headlessTurnCount).toBe(3);
    expect(tree.headlessTurnMaxRssBytes).toBe(640 * MB);
    expect(tree.steadyTreeBytes).toBe(0);
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
      const first = await sampleCapacityWithSampler({}, cacheFile, 1000, sampler);
      expect(first.degraded).toBe('cim-unavailable');
      const cached = await sampleCapacityWithSampler({}, cacheFile, 1000 + 1000, sampler);
      expect(cached).toEqual(degraded);
    } finally {
      cleanup();
    }
  });
});

describe('formatCapacityLines（panel 直出文本）', () => {
  it('绿样本：一行摘要，无 detail', () => {
    const s = sample();
    const lines = formatCapacityLines(s, judgeCapacity(s, {}));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('GREEN');
    expect(lines[0]).toContain('50.0%');
  });

  it('红样本：RED 头 + violated detail 逐行', () => {
    const s = sample({ headlessTurnCount: 1, headlessTurnMaxRssBytes: 900 * MB });
    const lines = formatCapacityLines(s, judgeCapacity(s, {}));
    expect(lines[0]).toContain('RED');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('session-limit');
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
