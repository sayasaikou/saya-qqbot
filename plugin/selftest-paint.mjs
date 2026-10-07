/**
 * qqbot_paint 自测（T-003）—— 四道闸 + 兜底链 + 落盘 + 计数。
 *
 * ⚠️ **不联网**：两个 provider 都注入假的，测的是决策与闸门；真链路另有 --live。
 * 跑法：
 *   E:\Node.js\node.exe C:\Users\xia54\.dsh\profiles\qqbot\node_modules\qqbot-memory\selftest-paint.mjs
 *   …同上… --live     # 真出图（走 CF→智谱真链路），会花掉当天的免费额度，一个人跑的时候用
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerPaintTool, screenPrompt, readUsage, PAINT_TOOL_NAME } from './paint-tool.js';

const LIVE = process.argv.includes('--live');
const TEST_DIR = process.env.QQBOT_TEST_DIR || join(tmpdir(), 'qqbot-paint-selftest');
const ADMIN = 'AAAA0000000000000000000000000001';
const OTHER = 'BBBB0000000000000000000000000002';
const SID = 'session-of-some-chat';

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

console.log('=== qqbot_paint 自测 ===\n');

// ── 内容闸（纯函数）
check('内容闸：放行正常提示词', screenPrompt('a cute blue whale maid girl, anime style') === null);
check('内容闸：拦住 nsfw', /不允许/.test(screenPrompt('nsfw anime girl') ?? ''));
check('内容闸：拦住中文色情词', /不允许/.test(screenPrompt('画一张涩图') ?? ''));
check('内容闸：拦住真人肖像', /不允许/.test(screenPrompt('画马斯克在火星') ?? ''));
check('内容闸：拦住血腥', /不允许/.test(screenPrompt('gore battle scene') ?? ''));
check('内容闸：太短不放行', /太短/.test(screenPrompt('a') ?? ''));
check('内容闸：太长不放行', /太长/.test(screenPrompt('x'.repeat(801)) ?? ''));

rmSync(TEST_DIR, { recursive: true, force: true });
mkdirSync(TEST_DIR, { recursive: true });

const cfg = {
  dataDir: TEST_DIR,
  adminOpenIds: [ADMIN],
  paintEnabled: true,
  paintDailyLimit: 3,
  paintOnlyAdmin: true,
};

const FAKE_JPG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4, 5, 6, 7, 8]);
const exec = (who) => ({ agent: { session: { id: SID } }, who });

// ── 正常出图（CF 成功）
{
  const ctx = makeCtx();
  let cfCalls = 0; let zpCalls = 0;
  registerPaintTool(ctx, cfg, { info: () => {}, warn: () => {} }, {
    resolveSpeaker: (e) => (e?.who ? { openid: e.who, name: 'x' } : null),
    cf: async () => { cfCalls++; return FAKE_JPG; },
    zhipu: async () => { zpCalls++; return FAKE_JPG; },
  });
  const tool = ctx._tools.registered.find((d) => d.name === PAINT_TOOL_NAME);
  check('注册了 qqbot_paint', !!tool);

  const r = await tool.execute({ prompt: 'a blue whale, anime style' }, exec(ADMIN));
  check('正常出图：报成功且带路径', /画好了/.test(r.text) && /图片路径：/.test(r.text), String(r.text).slice(0, 120));
  check('正常出图：走的是 CF 主线路', /cloudflare/.test(r.text));
  check('正常出图：**提醒必须再调 qqbot_send_file**', /qqbot_send_file/.test(r.text));
  check('正常出图：智谱没被调用（主线路成功就不该兜底）', zpCalls === 0, `zpCalls=${zpCalls}`);
  const m = /图片路径：(.+\.jpg)/.exec(r.text);
  check('正常出图：文件真的落盘了', !!m && existsSync(m[1].trim()), m ? m[1] : '(没解析到路径)');
  check('正常出图：当日计数 +1', (readUsage(TEST_DIR)[new Date().toLocaleDateString('sv-SE')] ?? 0) === 1);

  // ── 闸门③：仅超管
  const denied = await tool.execute({ prompt: 'a cat' }, exec(OTHER));
  check('非超管 ⇒ 被拒', /只有超管/.test(denied.text), denied.text);
  const unknown = await tool.execute({ prompt: 'a cat' }, { agent: { session: { id: SID } } });
  check('认不出说话人 ⇒ 被拒', /只有超管/.test(unknown.text), unknown.text);

  // ── 闸门④：内容闸要**在发请求之前**拦住
  const before = cfCalls;
  const blocked = await tool.execute({ prompt: 'nsfw stuff' }, exec(ADMIN));
  check('内容闸 ⇒ 拦住且不发请求', /不画/.test(blocked.text) && cfCalls === before, blocked.text);

  // ── 闸门②：每日上限（上限 3，已用 1）
  const r2 = await tool.execute({ prompt: 'a dog' }, exec(ADMIN));
  const r3 = await tool.execute({ prompt: 'a bird' }, exec(ADMIN));
  check('上限前两张正常', /画好了/.test(r2.text) && /画好了/.test(r3.text));
  const over = await tool.execute({ prompt: 'a fish' }, exec(ADMIN));
  const cfBefore = cfCalls;
  check('到上限 ⇒ 直接拒绝', /到上限/.test(over.text), over.text);
  check('到上限 ⇒ **连请求都不发**', cfCalls === cfBefore, `cfCalls ${cfBefore} -> ${cfCalls}`);
}

// ── 兜底链：CF 挂 ⇒ 智谱接住
{
  rmSync(join(TEST_DIR, 'paint-usage.json'), { force: true });
  const ctx = makeCtx();
  let zpCalls = 0;
  registerPaintTool(ctx, cfg, { info: () => {}, warn: () => {} }, {
    resolveSpeaker: () => ({ openid: ADMIN, name: 'SaYask' }),
    cf: async () => { throw new Error('CF HTTP 429 quota exceeded'); },
    zhipu: async () => { zpCalls++; return FAKE_JPG; },
  });
  const tool = ctx._tools.registered.find((d) => d.name === PAINT_TOOL_NAME);
  const r = await tool.execute({ prompt: 'a whale' }, { agent: { session: { id: SID } } });
  check('CF 挂 ⇒ 智谱接住', /画好了/.test(r.text) && /zhipu/.test(r.text), String(r.text).slice(0, 140));
  check('CF 挂 ⇒ 智谱确实被调了一次', zpCalls === 1);
}

// ── 两条都挂 ⇒ 如实报错，且两个原因都在
{
  rmSync(join(TEST_DIR, 'paint-usage.json'), { force: true });
  const ctx = makeCtx();
  registerPaintTool(ctx, cfg, { info: () => {}, warn: () => {} }, {
    resolveSpeaker: () => ({ openid: ADMIN, name: 'SaYask' }),
    cf: async () => { throw new Error('CF 凭据不在'); },
    zhipu: async () => { throw new Error('智谱 HTTP 401 令牌已过期'); },
  });
  const tool = ctx._tools.registered.find((d) => d.name === PAINT_TOOL_NAME);
  const r = await tool.execute({ prompt: 'a whale' }, { agent: { session: { id: SID } } });
  check('两条都挂 ⇒ 报失败', /画不出来/.test(r.text), String(r.text).slice(0, 120));
  check('两条都挂 ⇒ 两个原因都在', /CF/.test(r.text) && /智谱/.test(r.text), String(r.text).slice(0, 200));
  check('两条都挂 ⇒ 失败不计数', (readUsage(TEST_DIR)[new Date().toLocaleDateString('sv-SE')] ?? 0) === 0);
}

// ── 开关能关掉
{
  const ctx = makeCtx();
  registerPaintTool(ctx, { ...cfg, paintEnabled: false }, { info: () => {}, warn: () => {} }, {
    resolveSpeaker: () => ({ openid: ADMIN, name: 'SaYask' }),
    cf: async () => FAKE_JPG,
  });
  const tool = ctx._tools.registered.find((d) => d.name === PAINT_TOOL_NAME);
  const r = await tool.execute({ prompt: 'a whale' }, { agent: { session: { id: SID } } });
  check('paintEnabled=false ⇒ 拒绝', /关着/.test(r.text), r.text);
}

// ── 真链路（--live）
if (LIVE) {
  console.log('\n--- --live：走真 CF / 智谱 出图 ---');
  rmSync(join(TEST_DIR, 'paint-usage.json'), { force: true });
  const ctx = makeCtx();
  registerPaintTool(ctx, { ...cfg, paintDailyLimit: 5 }, { info: (m) => console.log('    ' + m), warn: (m) => console.log('    ' + m) }, {
    resolveSpeaker: () => ({ openid: ADMIN, name: 'SaYask' }),
  });
  const tool = ctx._tools.registered.find((d) => d.name === PAINT_TOOL_NAME);
  const r = await tool.execute({ prompt: 'a small cute blue whale, flat illustration, plain background' },
    { agent: { session: { id: SID } } });
  check('--live 真出图成功', /画好了/.test(r.text), String(r.text).slice(0, 300));
  console.log('    ' + String(r.text).split('\n')[0]);
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail === 0 ? 0 : 1);
