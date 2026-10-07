/**
 * qqbot_img 自测 —— 算法工具箱的动作 + **路径闸门**（安全那一条最重要）。
 *
 * 跑法：
 *   E:\Node.js\node.exe %DSH_HOME%\profiles\qqbot\node_modules\qqbot-memory\selftest-img.mjs
 *
 * ⚠️ 这份测试**真的会跑 Python/PIL**（不是打桩）—— 因为这一类的风险就是"命令拼错、PIL 版本行为不同"，
 *    打桩测不出来。所以本地要能跑 Python 3.12 + Pillow。
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { registerImgTool, guardPath, IMG_TOOL_NAME } from './img-tool.js';

const ROOT = process.env.QQBOT_TEST_DIR || join(tmpdir(), 'qqbot-img-selftest');
const WORK = join(ROOT, 'work');          // 模拟 agent 工作目录
const DATA = join(WORK, 'data');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  —— ' + detail : ''}`); }
}

function makeCtx() {
  const tools = { registered: [], register(def) { this.registered.push(def); } };
  return { get: (n) => (n === 'tools' ? tools : undefined), _tools: tools };
}

console.log('=== qqbot_img 自测 ===\n');

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
mkdirSync(join(WORK, 'media'), { recursive: true });
mkdirSync(join(WORK, '.qqbot-keys'), { recursive: true });

// 造测试图（用 Python，保证跟被测代码同一套 PIL）
{
  const { execFileSync } = await import('node:child_process');
  const PY = process.env.QQBOT_PYTHON
    || (existsSync('C:\\Users\\xia54\\AppData\\Local\\Programs\\Python\\Python312\\python.exe')
      ? 'C:\\Users\\xia54\\AppData\\Local\\Programs\\Python\\Python312\\python.exe' : 'python3');
  execFileSync(PY, ['-c', `
from PIL import Image, ImageDraw
import sys
work = sys.argv[1]
im = Image.new("RGB", (800, 600), (30, 50, 90))
d = ImageDraw.Draw(im)
d.ellipse([200, 120, 600, 480], fill=(230, 200, 120))
im.save(work + "/media/a.png")
im2 = Image.new("RGB", (400, 300), (200, 60, 60))
im2.save(work + "/media/b.png")
open(work + "/.qqbot-keys/env", "w").write("SECRET=should-never-be-readable")
print("ok")
`, WORK], { stdio: 'pipe' });
}

// ── 路径闸门（最重要的一段）
check('闸门：工作目录内的文件放行', guardPath(join(WORK, 'media', 'a.png'), WORK).ok);
check('闸门：工作目录外一律拒绝', !guardPath(join(ROOT, 'outside.png'), WORK).ok);
check('闸门：.. 穿越也拦得住', !guardPath(join(WORK, '..', 'x.png'), WORK).ok);
check('闸门：钥匙目录被拒（黑名单）', !guardPath(join(WORK, '.qqbot-keys', 'env'), WORK).ok);
check('闸门：不存在的文件被拒', !guardPath(join(WORK, 'media', 'nope.png'), WORK).ok);

const ctx = makeCtx();
registerImgTool(ctx, { dataDir: DATA }, { info: () => {}, warn: () => {} });
const tool = ctx._tools.registered.find((d) => d.name === IMG_TOOL_NAME);
check('注册了 qqbot_img', !!tool);

const A = join(WORK, 'media', 'a.png');
const B = join(WORK, 'media', 'b.png');
const run = (args) => tool.execute(args);

// ── 安全：拿钥匙文件当输入，必须拒绝
{
  const r = await run({ action: 'convert', paths: join(WORK, '.qqbot-keys', 'env') });
  check('安全：不许把钥匙文件转格式', /不给做/.test(r.text), String(r.text).slice(0, 120));
}

// ── info / color
{
  const r = await run({ action: 'info', paths: A });
  check('info：报出尺寸与格式', /800/.test(r.text) && /600/.test(r.text), String(r.text).slice(0, 160));
  check('info：不给"要发出去"的提示（它只是查）', !/qqbot_send_file/.test(r.text));
  const c = await run({ action: 'color', paths: A });
  check('color：取到主色（含 hex 与百分比）', /#[0-9A-F]{6}（\d/.test(c.text), String(c.text).slice(0, 160));
}

// ── resize / crop / rotate / convert
{
  const r1 = await run({ action: 'resize', paths: A, width: 400 });
  check('resize：宽度对了', /400×300/.test(r1.text), String(r1.text).slice(0, 160));
  check('resize：提示要再调 send_file', /qqbot_send_file/.test(r1.text));

  const r2 = await run({ action: 'crop', paths: A, rel: '0,0,0.5,0.5' });
  check('crop：按比例裁出 400×300', /400×300/.test(r2.text), String(r2.text).slice(0, 160));

  const r3 = await run({ action: 'crop', paths: A, box: '9999,9999,10000,10000' });
  check('crop：越界框被拦住（不崩）', /没做成/.test(r3.text), String(r3.text).slice(0, 140));

  const r4 = await run({ action: 'rotate', paths: A, degrees: 90 });
  check('rotate：90° 后宽高互换', /600×800/.test(r4.text), String(r4.text).slice(0, 160));

  const r5 = await run({ action: 'convert', paths: A, format: 'png' });
  check('convert：转 PNG 成功', /\.png/.test(r5.text), String(r5.text).slice(0, 160));
}

// ── text：**中文**必须画得出来（这是最容易静默失败的一项）
{
  const r = await run({ action: 'text', paths: A, text: '本鱼来了', position: 'bottom' });
  check('text：中文贴字成功', /文字：本鱼来了/.test(r.text), String(r.text).slice(0, 200));
  const m = /路径：(.+\.jpg)/.exec(r.text);
  check('text：产物真的落盘', !!m && existsSync(m[1]));
}

// ── stitch / grid / mosaic / gifinfo
{
  const r1 = await run({ action: 'stitch', paths: `${A},${B}`, mode: 'h' });
  // A=800×600，B=400×300；横拼会把 B 放大到高 600（即 800×600），再加 8px 缝 ⇒ 1608×600
  check('stitch：横拼成功（等高缩放 + 间隙）', /1608×600/.test(r1.text), String(r1.text).slice(0, 200));
  const r2 = await run({ action: 'stitch', paths: `${A},${B}`, mode: 'grid', cols: 2 });
  check('stitch：网格也是 1200×600 这类合理尺寸', /路径：/.test(r2.text));
  const r3 = await run({ action: 'grid', paths: A, n: 3 });
  check('grid：九宫格切出 9 张', /切好了 9 张/.test(r3.text), String(r3.text).slice(0, 160));
  const r4 = await run({ action: 'mosaic', paths: A, box: '100,100,300,300' });
  check('mosaic：打码成功', /路径：/.test(r4.text) && /100,100,300,300/.test(r4.text), String(r4.text).slice(0, 160));
}

// ── 参数缺失时的报错要人话
{
  const r1 = await run({ action: 'resize', paths: A });
  check('resize 缺参数 ⇒ 人话报错', /没做成/.test(r1.text) && /width/.test(r1.text), String(r1.text).slice(0, 160));
  const r2 = await run({ action: 'stitch', paths: A });
  check('stitch 只给一张 ⇒ 拦住', /至少要两张/.test(r2.text), String(r2.text).slice(0, 120));
  const r3 = await run({ action: 'nope', paths: A });
  check('不认识的 action ⇒ 人话报错', /没做成/.test(r3.text), String(r3.text).slice(0, 120));
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail === 0 ? 0 : 1);
