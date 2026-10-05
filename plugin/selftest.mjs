/**
 * look-tool 的端到端自测 —— 用假 ctx / 假 llm 跑**真实代码**。
 *
 * ════════════════════════════════════════════════════════════════
 * 为什么必须写这个
 * ════════════════════════════════════════════════════════════════
 *
 * 这条看图链路本鱼改了七八轮，其中**连续三个 bug 都是同一类**：
 *   · 加 regions 校验时忘了夹进画幅 → 裁出空块 → 全崩
 *   · 正则替换范围写到下一个函数 → 误删 cmd_refine
 *   · 引用了 if 块内声明的 `r`      → `r is not defined` → 整条链路挂掉
 *
 * **`node --check` 和 `py_compile` 一个都查不出来**，因为它们是语法检查，
 * 而这几个都是作用域 / 逻辑错。代价是每轮都要饲主发一次 QQ 消息才发现。
 *
 * 所以写这个：**本地用假数据把真实代码跑一遍**，几秒钟出结果。
 * 凡是"改完只能靠人肉实测"的东西，都该有这么一份。
 *
 * 跑法：
 *   E:\Node.js\node.exe C:\Users\xia54\.dsh\profiles\qqbot\node_modules\qqbot-memory\selftest.mjs
 * 退出码 0 = 全过；1 = 有失败
 */

import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { registerLookTool } from './look-tool.js';

const TEST_DIR = 'E:\\dsh-qqbot\\data\\_selftest';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  —— ' + detail : ''}`); }
}

/** 假 llm：记录被问过什么，按需返回预设答案 */
function makeFakeLlm(answers) {
  const calls = [];
  return {
    calls,
    stream(options) {
      const prompt = options.messages?.[0]?.content?.find((c) => c.type === 'text')?.text ?? '';
      calls.push({ prompt, model: options.model });
      // 逐条匹配预设答案，找不到就给个兜底
      let reply = '（默认回答）';
      for (const [needle, ans] of answers) {
        if (prompt.includes(needle)) { reply = ans; break; }
      }
      return (async function* () {
        yield { type: 'text-delta', text: reply };
      })();
    },
  };
}

/** 假 attachments */
const fakeAttachments = {
  async saveImage({ data, mediaType, name }) {
    return { kind: 'image', id: 'fake-' + (name ?? 'x'), mediaType, bytes: data?.length ?? 0 };
  },
};

/** 假 tools 注册表 */
function makeFakeTools() {
  const registered = [];
  return { registered, register(def) { registered.push(def); } };
}

// ──────────────────────────────────────────────────────────── 主测试

console.log('=== look-tool 自测 ===\n');

const fakeTools = makeFakeTools();
const logger = { info: () => {}, warn: () => {} };

const visionCfg = { provider: 'dashscope', model: 'qwen3-vl-plus', maxTokens: 2048 };

const cfg = { dataDir: TEST_DIR };

// 准备测试图：造一张 3000x2000 的大图（会走完整流程：定位+裁+增强+可能超分）
await rm(TEST_DIR, { recursive: true, force: true });
await mkdir(TEST_DIR, { recursive: true });

const bigImg = join(TEST_DIR, 'big.png');
const smallImg = join(TEST_DIR, 'small.png');
try {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const PY = 'C:\\Users\\xia54\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';
  await run(PY, ['-c', `
from PIL import Image, ImageDraw
for name, size in [('big.png',(3000,2000)), ('small.png',(600,400))]:
    im = Image.new('RGB', size, (40,50,90))
    d = ImageDraw.Draw(im)
    # 画个"人形"在中偏右上，顺便让边缘密度有分布
    cx, cy = int(size[0]*0.55), int(size[1]*0.5)
    d.ellipse([cx-120, cy-260, cx+120, cy-20], fill=(230,210,200))
    d.rectangle([cx-160, cy-20, cx+160, cy+300], fill=(200,120,140))
    im.save(r'${TEST_DIR.replace(/\\/g, '\\\\')}\\\\' + name)
print('ok')
`], { timeout: 60000 });
  check('测试图生成', existsSync(bigImg) && existsSync(smallImg));
} catch (err) {
  check('测试图生成', false, String(err?.message ?? err).slice(0, 120));
}

// 注册工具
const llm = makeFakeLlm([
  ['格子编号', 'CELLS=B2 B3 C2 C3'],      // 定位：选格子
  ['看看这块', '（对裁块的回答）'],          // 裁块提问
  ['默认', '（整图回答）'],
]);

let regOk = false;
try {
  regOk = registerLookTool({ get: (n) => (n === 'tools' ? fakeTools : n === 'llm' ? llm : fakeAttachments) },
    cfg, logger, visionCfg);
} catch (err) {
  check('registerLookTool 不抛异常', false, String(err?.message ?? err));
}
check('工具注册成功', regOk === true);
check('注册了 qqbot_look', fakeTools.registered.some((d) => d.name === 'qqbot_look'));

const def = fakeTools.registered.find((d) => d.name === 'qqbot_look');

// ── 测试 1：大图（走完整流程）
if (def) {
  try {
    const res = await def.execute(
      { image: bigImg, question: '这是什么' },
      { signal: undefined },
    );
    const text = String(res?.text ?? '');
    check('大图：不抛异常', true);
    check('大图：返回了文本', text.length > 0);
    check('大图：提到主体框', text.includes('主体框'), text.slice(0, 120));
    check('大图：指出模型选的格子', text.includes('B2') || text.includes('格子'), text.slice(0, 200));
    check('大图：没有 r is not defined', !text.includes('is not defined'), text.slice(0, 200));
    check('大图：没有"这一块看失败"', !text.includes('看失败'), text.slice(0, 200));
    const crops = existsSync(join(TEST_DIR, 'look'));
    check('大图：生成了裁块目录', crops);
  } catch (err) {
    check('大图：不抛异常', false, String(err?.message ?? err).slice(0, 200));
  }

  // ── 测试 2：小图（整图路径）
  try {
    const res = await def.execute({ image: smallImg, question: '这是什么' }, {});
    const text = String(res?.text ?? '');
    check('小图：不抛异常', true);
    check('小图：返回了文本', text.length > 0);
    check('小图：没有 r is not defined', !text.includes('is not defined'), text.slice(0, 120));
  } catch (err) {
    check('小图：不抛异常', false, String(err?.message ?? err).slice(0, 200));
  }

  // ── 测试 3：模型指定越界区域（上一轮炸过的场景）
  try {
    const res = await def.execute(
      { image: bigImg, question: '这块是什么', regions: ['2200,1350,3000,1600'] },
      {},
    );
    const text = String(res?.text ?? '');
    check('越界区域：不抛异常', true);
    check('越界区域：不产生空块错误', !text.includes('看失败'), text.slice(0, 150));
  } catch (err) {
    check('越界区域：不抛异常', false, String(err?.message ?? err).slice(0, 200));
  }

  // ── 测试 4：完全越界的区域（应被过滤掉，不崩）
  try {
    const res = await def.execute(
      { image: bigImg, question: 'x', regions: ['99999,99999,99999,99999'] },
      {},
    );
    check('全越界区域：不崩', String(res?.text ?? '').length > 0);
  } catch (err) {
    check('全越界区域：不崩', false, String(err?.message ?? err).slice(0, 150));
  }
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail === 0 ? 0 : 1);
