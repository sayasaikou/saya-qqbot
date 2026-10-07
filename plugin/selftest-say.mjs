/**
 * qqbot_say 自测（T-002）—— 主动发文字的闸门、目标解析、失败提示。
 *
 * 跑法：
 *   E:\Node.js\node.exe C:\Users\xia54\.dsh\profiles\qqbot\node_modules\qqbot-memory\selftest-say.mjs
 *   …同上… --live     # ⚠️ **真的会发一条**到超管私聊（验证 HTTP 那条链路，不走假发送器）
 *
 * 为什么要有 `--live`：假发送器只能证明"决策对了"，证明不了"发得出去"。
 * 真发送那条路只在 `~/qqbot-alarm.py` / `~/qqbot-announce.py` 上验过，
 * 这是**插件侧**第一次走，所以留一个显式开关给一次性验证用。
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseTarget, defaultTargetFrom, registerSayTool, SAY_TOOL_NAME } from './say-tool.js';

const LIVE = process.argv.includes('--live');
const TEST_DIR = process.env.QQBOT_TEST_DIR || join(tmpdir(), 'qqbot-say-selftest');
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

console.log('=== qqbot_say 自测 ===\n');

// ── 纯函数：目标解析
check('parseTarget: c2c 形式', parseTarget('c2c:ABC')?.scope === 'c2c');
check('parseTarget: group 形式', parseTarget('group:XYZ')?.targetId === 'XYZ');
check('parseTarget: 去空格', parseTarget('  c2c: A1  ')?.targetId === 'A1');
check('parseTarget: 拒绝非法 kind', parseTarget('dm:ABC') === undefined);
check('parseTarget: 拒绝空 id', parseTarget('c2c:') === undefined);
check('parseTarget: 拒绝没有冒号', parseTarget('ABC') === undefined);
check('defaultTargetFrom: 群会话', defaultTargetFrom({ S: { scope: 'group', peerId: 'G9' } }, 'S')?.scope === 'group');
check('defaultTargetFrom: 私聊会话', defaultTargetFrom({ S: { scope: 'c2c', peerId: 'U9' } }, 'S')?.targetId === 'U9');
check('defaultTargetFrom: 认不出就返回 undefined', defaultTargetFrom({}, 'S') === undefined);

// ── 工具本体（假发送器）
rmSync(TEST_DIR, { recursive: true, force: true });
mkdirSync(TEST_DIR, { recursive: true });
writeFileSync(join(TEST_DIR, 'current-speaker.json'), JSON.stringify({
  [SID]: { openid: ADMIN, name: 'SaYask', scope: 'c2c', peerId: ADMIN, at: Date.now() },
}), 'utf8');

const cfg = { dataDir: TEST_DIR, adminOpenIds: [ADMIN] };
const sent = [];
const fakeSend = async (scope, id, text) => { sent.push({ scope, id, text }); return '{}'; };

const ctx = makeCtx();
const registered = registerSayTool(ctx, cfg, { info: () => {}, warn: () => {} }, {
  send: fakeSend,
  resolveSpeaker: (exec) => {
    const who = exec?.who;
    return who ? { openid: who, name: 'x' } : null;
  },
});
check('工具注册成功', registered === true);
const tool = ctx._tools.registered.find((d) => d.name === SAY_TOOL_NAME);
check('注册了 qqbot_say', !!tool);

if (tool) {
  const asAdmin = (extra = {}) => ({ agent: { session: { id: SID } }, who: ADMIN, ...extra });
  const asOther = (extra = {}) => ({ agent: { session: { id: SID } }, who: OTHER, ...extra });

  // 闸门
  const denied = await tool.execute({ text: '你好' }, asOther());
  check('非超管 ⇒ 被拒', String(denied.text).includes('只有超管'), denied.text);
  check('非超管 ⇒ 一个字都没发', sent.length === 0);

  const noSpeaker = await tool.execute({ text: '你好' }, { agent: { session: { id: SID } } });
  check('认不出说话人 ⇒ 被拒', String(noSpeaker.text).includes('只有超管'), noSpeaker.text);

  // 正文校验
  const empty = await tool.execute({ text: '   ' }, asAdmin());
  check('空正文 ⇒ 不发', String(empty.text).includes('没给正文'));
  const tooLong = await tool.execute({ text: 'x'.repeat(2001) }, asAdmin());
  check('超长正文 ⇒ 拦下', String(tooLong.text).includes('太长'), String(tooLong.text).slice(0, 60));

  // 默认目标 = 当前会话
  const ok1 = await tool.execute({ text: '本鱼测试一句' }, asAdmin());
  check('超管 + 省略 target ⇒ 发到当前会话', sent.length === 1 && sent[0].scope === 'c2c' && sent[0].id === ADMIN,
    JSON.stringify(sent));
  check('返回值报出目标', String(ok1.text).includes('已主动发送'), ok1.text);

  // 显式 target
  await tool.execute({ text: '发到群里', target: 'group:G123' }, asAdmin());
  check('显式 target 生效', sent.length === 2 && sent[1].scope === 'group' && sent[1].id === 'G123');
  const badT = await tool.execute({ text: 'x', target: 'dm:zzz' }, asAdmin());
  check('非法 target ⇒ 拦下且不发', String(badT.text).includes('格式不对') && sent.length === 2);

  // 失败提示：群权限错误要给"改私聊"的建议
  const ctx2 = makeCtx();
  registerSayTool(ctx2, cfg, { info: () => {}, warn: () => {} }, {
    send: async () => { throw new Error('HTTP 400 {"message":"主动消息失败, 无权限","code":40034105}'); },
    resolveSpeaker: () => ({ openid: ADMIN, name: 'SaYask' }),
  });
  const tool2 = ctx2._tools.registered.find((d) => d.name === SAY_TOOL_NAME);
  const gFail = await tool2.execute({ text: 'x', target: 'group:G1' }, { agent: { session: { id: SID } } });
  check('群发送失败 ⇒ 回报原因并提示改私聊', String(gFail.text).includes('40034105') && String(gFail.text).includes('私聊'),
    String(gFail.text).slice(0, 120));
  const cFail = await tool2.execute({ text: 'x' }, { agent: { session: { id: SID } } });
  check('私聊失败 ⇒ 不硬扯群权限', !String(cFail.text).includes('改私聊'), String(cFail.text).slice(0, 80));
}

// ── 真发送（只在显式 --live 时跑）
if (LIVE) {
  console.log('\n--- --live：真的发一条到超管私聊 ---');
  const ctxL = makeCtx();
  registerSayTool(ctxL, cfg, { info: (m) => console.log('    ' + m), warn: (m) => console.log('    ' + m) }, {
    resolveSpeaker: () => ({ openid: ADMIN, name: 'SaYask' }),
  });
  const toolL = ctxL._tools.registered.find((d) => d.name === SAY_TOOL_NAME);
  const r = await toolL.execute(
    { text: '【链路自检】qqbot_say 已上线 —— 这条是它自己主动发的，不是回复。', target: `c2c:${ADMIN}`, reason: 'selftest --live' },
    { agent: { session: { id: SID } } },
  );
  check('--live 真发送成功', String(r.text).includes('已主动发送'), r.text);
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail === 0 ? 0 : 1);
