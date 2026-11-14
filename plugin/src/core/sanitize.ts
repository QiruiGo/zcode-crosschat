/**
 * M1 core-store: free-form name -> safe path/key segment.
 *
 * 1:1 port of dsh sanitizeKey (state.js:64-99): NFC normalize -> trim ->
 * lowercase -> fold every non letter/number run to `-` -> strip edge dashes.
 * Unicode letters and digits survive, so CJK names stay distinct and readable;
 * an ASCII-only whitelist would silently merge them onto one shared mailbox.
 *
 * v0.5.3（A11 修复）：同形字归一。Unicode 字母全保留的旧规则放进了「长得一样、
 * 码位不同」的名字——西里尔 с(U+0441) 混进 victim 得到 viсtim，花名册两个键并存，
 * 消息/回执/唤醒各走各的地址（adj052 A11：roster 同时有 victim 与 viсtim）。
 * 修复 = 清洗链加一步「混淆字母归一」：西里尔/希腊字母里与拉丁字母/数字**形近**
 * 的子集折到对应拉丁字符（Unicode TR39 混排混淆的可反混淆子集），再加全角拉丁
 * （U+FF01–U+FF5E，CJK 邻域最常见的同形源）折回 ASCII。归一发生在去重判定之前，
 * 同形名字从此撞在同一把 name_taken 闸上。
 *
 * 明确不做的（文档声明）：
 * - 非形近的西里尔/希腊字母（б г д ж …）不映射——按原样保留（纯西里尔/希腊名字
 *   仍是合法可读键，只有「与拉丁形近」的字母被折）；
 * - 数学字母数字（U+1D400+）、拉丁字母变形组合等其他混淆源超出本闸范围，由
 *   「名字即身份、注册即显式」的 roster 观测面兜底（归一范围声明见 README
 *   工具表 xc_register 行）。
 *
 * 幂等性：映射目标全是 ASCII 拉丁/数字，不再是任何映射键——sanitizeKey 可安全
 * 叠加调用（mailbox 路径对已是 key 的 agentKey 二次清洗，行为不变）。
 *
 * @module core/sanitize
 */
import { createHash } from 'node:crypto';
import { RESERVED_MEMBER_KEYS } from './types.js';

/** Longest key emitted before truncating and appending a digest. */
const MAX_KEY_LENGTH = 48;

/**
 * 成员花名长度上限（v0.6.1，红队四番战 安全对-2 修复）：与键长上限一致——
 * 超过它的名字会被 sanitizeKey 截断+拼摘要，键形与名形不再一致（静默变形），
 * 故在闸门口显式拒（对齐 peer 轴 PEER_NAME_MAX_LENGTH 的「到长即拒」口径）。
 */
export const MEMBER_NAME_MAX_LENGTH = MAX_KEY_LENGTH;

/** 队内轴花名严格校验的拒绝理由（error 码进 ToolError 信封）。 */
export type MemberNameRejection =
  | { ok: false; error: 'invalid_name'; name: string; message: string }
  | { ok: false; error: 'name_too_long'; name: string; message: string }
  | { ok: false; error: 'name_reserved'; name: string; message: string };

/**
 * v0.6.1（红队四番战 安全对-2 修复）：队内轴花名严格校验——注册/改名/
 * member-add 全路径同一道闸（对齐 peer 轴「严格文法 + 保留名」口径，两轴一致）。
 *
 * 背景（adjudication.md 安全对-2，P1）：sanitizeKey 的清洗链会把**不同写法**
 * 静默归一到**同一把键**——全角（Ａｌｉｃｅ→alice）、同形字（西里尔 с→c）、
 * 路径符/空白/控制符（a/b、a b、a\x01b → a-b）。攻击者先注册碰撞写法即可
 * 抢占他人花名、锁死真人，并把派给真人的任务（含敏感提示）重定向到自己
 * 邮箱。peer 轴用严格正则 `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` 直接拒这些写法，
 * 队内轴却静默收纳——两轴不一致即缺陷面。
 *
 * 判据（最小根因，不误伤合法流程）：**sanitizeKey 除了小写折叠外不得对本名
 * 做任何改动**。即名须已是规范键形（NFC + trim 后）：
 * - 放行：ASCII 字母/数字/单连字符（alice、alice-2、1bot）、Unicode 字母数字
 *   （小明、café——CJK/带音调名字保持合法可读，sanitize.ts 模块头纪律不变）、
 *   大小写（键仍小写，队内键大小写不敏感是既有文档化行为）；
 * - 拒绝：全角/同形字（折叠后 ≠ 原名）、路径符与空白（/ \ . .. 空格 → 变形）、
 *   控制字符（NUL/TAB → 连字符）、连续/边沿连字符（会被合并/剥除）、
 *   下划线（队内键用 -，_ 会被折成 - 从而与 - 形式碰撞）、超长（>48）。
 *
 * 幂等：通过校验的名再经 sanitizeKey 仍得同一键（本函数返回值即该键）。
 */
export function validateMemberName(raw: string): { ok: true; key: string } | MemberNameRejection {
  const reject = (
    error: MemberNameRejection['error'],
    message: string,
  ): MemberNameRejection => ({ ok: false, error, name: raw, message });

  if (typeof raw !== 'string') {
    return reject('invalid_name', `member name ${JSON.stringify(raw)} is not a string`);
  }
  const trimmed = raw.normalize('NFC').trim();
  if (trimmed === '') {
    return reject('invalid_name', `member name ${JSON.stringify(raw)} is empty after NFC+trim`);
  }
  if ([...trimmed].length > MEMBER_NAME_MAX_LENGTH) {
    return reject(
      'name_too_long',
      `member name is ${[...trimmed].length} characters; the limit is ${MEMBER_NAME_MAX_LENGTH} ` +
        '(longer names would be silently truncated into a different key)',
    );
  }
  const key = sanitizeKey(trimmed);
  // 碰撞归一闸：键必须与「仅小写折叠」后的名相等——任何折叠/替换/截断都意味着
  // 存在另一个写法会归一到同一把键（全角/同形/路径符/控制符/空白/连字符变形）。
  if (key !== trimmed.toLowerCase()) {
    return reject(
      'invalid_name',
      `member name ${JSON.stringify(raw)} would be silently normalized to key ${JSON.stringify(key)}; ` +
        'use the exact key form (letters/digits/single dashes; no fullwidth, homoglyphs, path or ' +
        'control characters, spaces, underscores or doubled dashes)',
    );
  }
  if ((RESERVED_MEMBER_KEYS as readonly string[]).includes(key)) {
    return reject(
      'name_reserved',
      `member name "${key}" is reserved (${RESERVED_MEMBER_KEYS.join('/')})`,
    );
  }
  return { ok: true, key };
}

/** Short stable digest, used to keep otherwise-colliding keys distinct. */
function keyDigest(name: string): string {
  return createHash('sha256').update(name).digest('hex').slice(0, 8);
}

/**
 * v0.5.3（A11 修复）：西里尔/希腊字母中与拉丁字母/数字形近的混淆子集 → 对应
 * 拉丁字符（键均为小写——清洗链先 toLowerCase 再映射）。选表依据 Unicode TR39
 * recommended confusables 的 {LATIN ↔ CYRILLIC/GREEK} 混排子集，只收「大写或
 * 小写形似拉丁」的字母；б г д ж п ф ц ч ш щ ъ ы ь э ю я 等非形近字母不进表。
 */
const HOMOGLYPH_TO_LATIN: Readonly<Record<string, string>> = {
  // --- 西里尔（Cyrillic，U+0400 块）---
  '\u0430': 'a', // а (looks like a)
  '\u0432': 'b', // в (uppercase В looks like B)
  '\u0435': 'e', // е (looks like e)
  '\u0437': '3', // з (looks like 3)
  '\u0455': 's', // ѕ (looks like s)
  '\u0456': 'i', // і (looks like i)
  '\u0458': 'j', // ј (looks like j)
  '\u043a': 'k', // к (looks like k)
  '\u043c': 'm', // м (uppercase М looks like M)
  '\u043d': 'h', // н (uppercase Н looks like H)
  '\u043e': 'o', // о (looks like o)
  '\u0440': 'p', // р (looks like p)
  '\u0441': 'c', // с (looks like c) —— adj052 A11 实测样本
  '\u0442': 't', // т (looks like t)
  '\u0443': 'y', // у (looks like y)
  '\u0445': 'x', // х (looks like x)
  '\u04bb': 'h', // һ (looks like h)
  '\u0501': 'd', // ԁ (looks like d)
  // --- 希腊（Greek，U+0370 块）---
  '\u03b1': 'a', // α (uppercase Α looks like A)
  '\u03b5': 'e', // ε (uppercase Ε looks like E)
  '\u03b7': 'h', // η (uppercase Η looks like H)
  '\u03b9': 'i', // ι (looks like i)
  '\u03ba': 'k', // κ (looks like k)
  '\u03bc': 'm', // μ (uppercase Μ looks like M)
  '\u03bd': 'v', // ν (lowercase looks like v)
  '\u03bf': 'o', // ο (looks like o)
  '\u03c1': 'p', // ρ (looks like p)
  '\u03c2': 's', // ς (final sigma)
  '\u03c3': 's', // σ (looks like s)
  '\u03c4': 't', // τ (looks like t)
  '\u03c5': 'u', // υ (looks like u)
  '\u03c7': 'x', // χ (looks like x)
};

/**
 * v0.5.3（A11 修复）：全角拉丁/符号（U+FF01–U+FF5E）→ ASCII（差 0xFEE0 的
 * NFKC 兼容折叠）。CJK 邻域输入法最常见的同形源：ｖｉｃｔｉｍ 与 victim。
 */
function foldFullwidth(ch: string): string {
  const code = ch.charCodeAt(0);
  return code >= 0xff01 && code <= 0xff5e ? String.fromCharCode(code - 0xfee0) : ch;
}

/**
 * v0.5.3（A11 修复）：混淆字母归一（导出仅测使用）。
 * 输入应为已小写的文本；非映射字符原样通过（幂等：目标全是 ASCII，不是映射键）。
 */
export function foldHomoglyphs(text: string): string {
  return [...text].map((ch) => foldFullwidth(HOMOGLYPH_TO_LATIN[ch] ?? ch)).join('');
}

/**
 * Fold a free-form name into a non-empty key safe as a single path segment.
 * A name with no letters or digits at all gets a digest rather than a shared
 * constant; over-long names are truncated with a digest appended, so names
 * sharing a long prefix stay distinct (CJK costs 3 bytes per char in UTF-8).
 */
export function sanitizeKey(name: string): string {
  const cleaned = foldHomoglyphs(name.normalize('NFC').trim().toLowerCase())
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  if (cleaned === '') return `k-${keyDigest(name)}`;
  const points = [...cleaned];
  if (points.length > MAX_KEY_LENGTH) {
    return `${points.slice(0, MAX_KEY_LENGTH).join('')}-${keyDigest(name)}`;
  }
  return cleaned;
}
