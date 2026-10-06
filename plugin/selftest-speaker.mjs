/**
 * T-005 自测 —— 关系卡用的到底是「本轮说话人」还是「上一轮的人」。
 *
 * ════════════════════════════════════════════════════════════════
 * 为什么单独写这一份（2026-10-06）
 * ════════════════════════════════════════════════════════════════
 *
 * 这个 bug 的症状是"关系卡稳定慢一轮"，会把 A 的身份与好感度用在 B 头上 ——
 * 实测已经因此冤枉过一个正常用户（把别人的 -92 甩到超管脸上）。
 *
 * 根因**不是猜的**，是读 dsh 源码读出来的（dsh-agent-loop/lib/index.js）：
 *   一个 turn 里 907 行先 `systemPrompt.assemble()`，1046 行才 `append("user/message")`
 *   ⇒ 挂在 assemble 上的注入钩子，永远读不到本轮这条消息。
 *
 * 所以修法必须换**取人来源**（适配器入站落盘 → session 事件 → 不再退回全局）。
 * 这一层用假 ctx 跑真实 `apply()`，几秒钟验证；否则每验一次都要饲主去群里发消息。
 *
 * 跑法：
 *   E:\Node.js\node.exe C:\Users\xia54\.dsh\profiles\qqbot\node_modules\qqbot-memory\selftest-speaker.mjs
 * 退出码 0 = 全过；1 = 有失败
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from './index.js';

const TEST_DIR = process.env.QQBOT_TEST_DIR || join(tmpdir(), 'qqbot-speaker-selftest');

const ADMIN = 'A6446BC4FB7BB7FED179D260478E4903';   // 饲主（超管）
const OTHER = 'F968AB74E0B8FFE667A63C56A2F8568D';   // 另一个人（别的群/私聊里说话的）
const S1 = 'session-of-group-A';
const S2 = 'session-of-group-B';

let pass = 0;
let fail = 0;
let skipped = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  —— ' + detail : ''}`); }
}
function skip(name, why) { skipped++; console.log(`  ~ 跳过 ${name}（${why}）`); }

// 假 ctx：只提供插件真正用到的那几样
function makeCtx() {
  const handlers = {};
  const tools = { registered: [], register(def) { this.registered.push(def); } };
  const llm = { stream: () => (async function* () { yield { type: 'text-delta', text: '' }; })() };
  return {
    handlers,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    on(name, fn) { (handlers[name] ??= []).push(fn); },
    get(name) { return name === 'tools' ? tools : name === 'llm' ? llm : undefined; },
  };
}

/** 把 session/event 钩子当真实事件调一次（模拟"某人在某个会话里说了句话"） */
async function say(ctx, sessionId, name, openid, text) {
  for (const h of ctx.handlers['session/event'] ?? []) {
    await h(
      { header: { id: sessionId }, id: sessionId },
      { type: 'user/message', data: { content: [{ type: 'text', text: `[${name} (${openid})] ${text}` }], source: { kind: 'user' }, role: 'user', id: 'm-' + Math.random() } },
    );
  }
}

/** 把 system-prompt/assemble 钩子按注册顺序串起来跑一次，返回最终 assembly */
async function assemble(ctx, sessionId) {
  let assembly = { sections: [], tools: [] };
  const context = { session: { header: { id: sessionId }, id: sessionId } };
  for (const h of ctx.handlers['system-prompt/assemble'] ?? []) {
    const prev = assembly;
    assembly = await h(prev, context, async () => prev);
  }
  return assembly;
}

function section(assembly, name) {
  return (assembly?.sections ?? []).find((s) => s.name === name);
}

const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(String(e)));

console.log('=== T-005 关系卡说话人 自测 ===\n');

rmSync(TEST_DIR, { recursive: true, force: true });
mkdirSync(TEST_DIR, { recursive: true });

// 关系表：超管 + 另一个人
writeFileSync(join(TEST_DIR, 'relations.json'), JSON.stringify({
  [ADMIN]: {
    openid: ADMIN, name: 'SaYask', role: 'admin', score: 100, mute: false,
    firstSeen: '2026-10-05T14:05:06.672Z', lastSeen: '2026-10-05T14:05:06.672Z',
    todayDate: '2026-10-05', todayDelta: 0, notes: [], introShown: true,
  },
  [OTHER]: {
    openid: OTHER, name: 'Alt', role: 'user', score: -92, mute: false,
    firstSeen: '2026-10-05T14:45:37.222Z', lastSeen: '2026-10-05T14:45:37.222Z',
    todayDate: '2026-10-05', todayDelta: 0, notes: [], introShown: true,
  },
}, null, 2), 'utf8');

const cfg = {
  dataDir: TEST_DIR,
  relationFile: join(TEST_DIR, 'relations.json'),
  profileDir: TEST_DIR,          // 这里没有 cordis.patch.yml ⇒ qqbot_look 自然不注册，无害
  adminOpenIds: [ADMIN],
  relations: true,
  dailyTokenLimit: 0,            // 限额关着（测试期口径）⇒ 超额钩子早退
  dailySessionLimit: 0,
};

const ctx = makeCtx();
apply(ctx, cfg);
await new Promise((r) => setTimeout(r, 60));   // 让插件末尾那个自检 IIFE 跑完

const speakerPath = join(TEST_DIR, 'current-speaker.json');
const writeSpeaker = (obj) => writeFileSync(speakerPath, JSON.stringify(obj, null, 2), 'utf8');

// ── 场景 0：别的群里另一个人说话（把"全局最后说话人"污染成 OTHER）
await say(ctx, S2, 'Alt', OTHER, '随便说一句话');

// ── 场景 1：适配器落了盘 ⇒ 卡片必须是【本轮】那个人（超管），而不是全局里的 OTHER
writeSpeaker({ [S1]: { openid: ADMIN, name: 'SaYask', scope: 'group', peerId: 'g1', at: Date.now() } });
{
  const a = await assemble(ctx, S1);
  const rel = section(a, 'qqbot-memory:relation');
  check('场景1：注入了关系卡', !!rel, '没有 qqbot-memory:relation 段');
  const t = rel?.text ?? '';
  check('场景1：卡是超管的（openid 尾 4903）', t.includes('4903'), t.slice(0, 160));
  check('场景1：卡里没有别人的 openid 尾 568D', !t.includes('568D'), t.slice(0, 200));
  check('场景1：卡上写明了"本卡对应发言人"', t.includes('本卡对应发言人'), t.slice(-160));
  check('场景1：卡上给了对照纪律（以消息头为准）', t.includes('以消息头为准'));
}

// ── 场景 2：**取不到人时不许退回全局** —— 这是本次修复的核心回归点
rmSync(speakerPath, { force: true });
{
  const a = await assemble(ctx, S1);
  const rel = section(a, 'qqbot-memory:relation');
  check('场景2：取不到本轮说话人 ⇒ 不注入卡（宁缺勿错）', !rel,
    '注入了卡：' + String(rel?.text ?? '').slice(0, 120));
}

// ── 场景 3：两个来源打架时，**适配器那份赢**（它是唯一覆盖本轮的）
writeSpeaker({ [S1]: { openid: ADMIN, name: 'SaYask', scope: 'group', peerId: 'g1', at: Date.now() } });
await say(ctx, S1, 'Alt', OTHER, '在同一个会话里假装是上一条消息');   // 写进 speakerBySession[S1] = OTHER
{
  const a = await assemble(ctx, S1);
  const t = section(a, 'qqbot-memory:relation')?.text ?? '';
  check('场景3：适配器与 session 事件打架时以适配器为准（超管赢）', t.includes('4903') && !t.includes('568D'), t.slice(0, 200));
}

// ── 场景 4：兜底那一档仍然有效（没有适配器文件时，用 session 事件记的人）
rmSync(speakerPath, { force: true });
await say(ctx, S1, 'Alt', OTHER, '再假装说一句');
{
  const a = await assemble(ctx, S1);
  const t = section(a, 'qqbot-memory:relation')?.text ?? '';
  check('场景4：没有适配器文件时退回 session 事件那一档', t.includes('568D'), t.slice(0, 160));
}

// ── 场景 5：日志必须真的落盘（否则排查又是瞎的）
{
  const logPath = join(TEST_DIR, 'qqbot-memory.log');
  const ok = existsSync(logPath);
  const body = ok ? readFileSync(logPath, 'utf8') : '';
  check('场景5：插件自己的日志文件已生成', ok, logPath);
  check('场景5：日志里有内容且带时间戳', /\[qqbot-memory\] \d{4}-\d{2}-\d{2}T/.test(body), body.slice(0, 120));
}

// ── 场景 6：peer-registry（适配器侧的补丁）写盘行为
try {
  const { rememberPeer } = await import('../@tencent-connect/dsh-qqbot/dist/features/peer-registry.js');
  const cwd = join(TEST_DIR, 'fake-agent-cwd');
  mkdirSync(join(cwd, 'data'), { recursive: true });

  rememberPeer({ cwd, sessionId: 's-g1', scope: 'group', peerId: 'GROUP1', senderId: ADMIN, senderName: 'SaYask' });
  rememberPeer({ cwd, sessionId: 's-g2', scope: 'group', peerId: 'GROUP2', senderId: OTHER, senderName: 'Alt' });
  rememberPeer({ cwd, sessionId: 's-g1', scope: 'group', peerId: 'GROUP1', senderId: ADMIN, senderName: 'SaYask' });
  rememberPeer({ cwd, sessionId: 's-c2c', scope: 'c2c', peerId: ADMIN, senderId: ADMIN, senderName: 'SaYask' });

  const sp = JSON.parse(readFileSync(join(cwd, 'data', 'current-speaker.json'), 'utf8'));
  const gp = JSON.parse(readFileSync(join(cwd, 'data', 'groups.json'), 'utf8'));

  check('场景6：current-speaker.json 按会话记了人', sp['s-g1']?.openid === ADMIN && sp['s-c2c']?.openid === ADMIN);
  check('场景6：群登记表只记群、不记私聊', !!gp.GROUP1 && !!gp.GROUP2 && !gp[ADMIN]);
  check('场景6：同一个群重复说话会累加 msgs', gp.GROUP1?.msgs === 2, JSON.stringify(gp.GROUP1));
  check('场景6：首次见到会记 firstSeen', typeof gp.GROUP1?.firstSeen === 'string' && gp.GROUP1.firstSeen.length > 10);

  // TTL：两小时前的记录应当被剪掉
  rememberPeer({ cwd, sessionId: 's-old', scope: 'c2c', peerId: ADMIN, senderId: OTHER, senderName: 'Old', now: Date.now() - 2 * 60 * 60 * 1000 });
  rememberPeer({ cwd, sessionId: 's-new', scope: 'c2c', peerId: ADMIN, senderId: ADMIN, senderName: 'New' });
  const sp2 = JSON.parse(readFileSync(join(cwd, 'data', 'current-speaker.json'), 'utf8'));
  check('场景6：超过 1 小时的说话人记录被剪掉', !sp2['s-old'] && !!sp2['s-new'], JSON.stringify(Object.keys(sp2)));
} catch (err) {
  skip('场景6：peer-registry', '导入失败：' + String(err?.message ?? err).slice(0, 120));
}

// ── 场景 7：工具层的权限闸门 —— 它读的是全局值，现在由注入钩子按"本轮"刷新
{
  const adminTool = ctx.get('tools').registered.find((d) => d.name === 'qqbot_admin');
  check('场景7：注册了 qqbot_admin', !!adminTool);
  if (adminTool) {
    writeSpeaker({ [S1]: { openid: ADMIN, name: 'SaYask', scope: 'group', peerId: 'g1', at: Date.now() } });
    await assemble(ctx, S1);                       // 刷新全局 → 超管
    const ok = await adminTool.execute({ action: 'list' });
    check('场景7：超管说话后，管理指令放行', !String(ok?.text ?? '').includes('只有超管'), String(ok?.text ?? '').slice(0, 100));

    writeSpeaker({ [S1]: { openid: OTHER, name: 'Alt', scope: 'group', peerId: 'g1', at: Date.now() } });
    await assemble(ctx, S1);                       // 刷新全局 → 非超管
    const denied = await adminTool.execute({ action: 'list' });
    check('场景7：非超管说话后，管理指令被拒', String(denied?.text ?? '').includes('只有超管'), String(denied?.text ?? '').slice(0, 100));
  }
}

check('没有未处理的 Promise 拒绝', unhandled.length === 0, unhandled.slice(0, 2).join(' | '));
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败${skipped ? ` / ${skipped} 跳过` : ''} ===`);
process.exit(fail === 0 ? 0 : 1);
