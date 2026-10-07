/**
 * selftest-alarm.mjs —— 锁住闹钟层的解析、判定与**群目标**。
 * 跑法：node selftest-alarm.mjs
 *
 * 两组：
 *   A. 纯函数（repeat 解析 / 人话描述 / target 归一 / 谁能动哪条）
 *   B. 端到端（假 ctx + 假临时目录，跑真实的 registerAlarmTool → execute → 落盘回读）
 */
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseRepeat, describeRepeat, describeAlarm,
  normalizeTarget, describeTarget, canTouch, loadGroups,
  registerAlarmTool, ALARM_TOOL_NAME, MAX_PER_GROUP,
} from './alarms.js';

let pass = 0, fail = 0;
const t = (n, c, extra) => { if (c) { pass++; console.log('  PASS ' + n); } else { fail++; console.log('  FAIL ' + n + (extra ? '  ← ' + extra : '')); } };
const rep = (x) => JSON.stringify(parseRepeat(x));

console.log('== 1. 一次性（缺省与显式）==');
t('不传 ⇒ once', rep(undefined) === '{"kind":"once"}', rep(undefined));
t('空串 ⇒ once', rep('') === '{"kind":"once"}', rep(''));
t('"once" ⇒ once', rep('once') === '{"kind":"once"}');
t('"只一次" ⇒ once', parseRepeat('只一次').kind === 'once');
t('认不出来的词 ⇒ 保守当 once', parseRepeat('随便吧').kind === 'once');

console.log('== 2. 每天 ==');
t('"daily" ⇒ daily', parseRepeat('daily').kind === 'daily');
t('"每天" ⇒ daily', parseRepeat('每天').kind === 'daily');
t('"天天" ⇒ daily', parseRepeat('天天').kind === 'daily');
t('"每日8点" 含"每日" ⇒ daily', parseRepeat('每日').kind === 'daily');

console.log('== 3. 工作日 / 周末 ==');
t('"weekday" ⇒ 0-4', JSON.stringify(parseRepeat('weekday').days) === '[0,1,2,3,4]');
t('"工作日" ⇒ 0-4', JSON.stringify(parseRepeat('工作日').days) === '[0,1,2,3,4]');
t('"weekend" ⇒ 5,6', JSON.stringify(parseRepeat('weekend').days) === '[5,6]');
t('"周末" ⇒ 5,6', JSON.stringify(parseRepeat('周末').days) === '[5,6]');

console.log('== 4. 指定星期（各种写法）==');
t('"mon,wed,fri"', JSON.stringify(parseRepeat('mon,wed,fri').days) === '[0,2,4]');
t('"周三,周五"', JSON.stringify(parseRepeat('周三,周五').days) === '[2,4]');
t('"周三、周五"（顿号）', JSON.stringify(parseRepeat('周三、周五').days) === '[2,4]');
t('"星期一" ⇒ 0', JSON.stringify(parseRepeat('星期一').days) === '[0]');
t('"一三五"（中文连写）', JSON.stringify(parseRepeat('一三五').days) === '[0,2,4]');
t('"周日" ⇒ 6', JSON.stringify(parseRepeat('周日').days) === '[6]');
t('"周天" ⇒ 6（口语）', JSON.stringify(parseRepeat('周天').days) === '[6]');
t('乱序自动排序去重', JSON.stringify(parseRepeat('fri,mon,fri').days) === '[0,4]');

console.log('== 5. 人话描述（回给模型看）==');
t('daily ⇒ 每天', describeRepeat({ repeat: 'daily' }) === '每天');
t('once ⇒ 只一次', describeRepeat({ repeat: 'once' }) === '只一次');
t('缺省 ⇒ 只一次', describeRepeat({}) === '只一次');
t('[0,1,2,3,4] ⇒ 工作日', describeRepeat({ repeat: [0, 1, 2, 3, 4] }) === '工作日');
t('[5,6] ⇒ 周末', describeRepeat({ repeat: [5, 6] }) === '周末');
t('[0,2,4] ⇒ 周一、周三、周五', describeRepeat({ repeat: [0, 2, 4] }) === '周一、周三、周五');
t('7 天 ⇒ 每天', describeRepeat({ repeat: [0, 1, 2, 3, 4, 5, 6] }) === '每天');

console.log('== 6. list 的展示行 ==');
const line = describeAlarm({ time: '08:00', prompt: '叫他起床', repeat: 'daily' }, 0);
t('带重复方式', line.includes('每天') && line.includes('08:00'), line);
t('停用会标出来', describeAlarm({ time: '08:00', enabled: false }, 0).includes('已停用'));
t('老条目（无 target）显示"私聊"', describeAlarm({ time: '08:00' }, 0).includes('[→ 私聊]'), describeAlarm({ time: '08:00' }, 0));

console.log('== 7. target 归一（群目标，T-008）==');
t('无 target ⇒ 私聊（null）', normalizeTarget(undefined) === null);
t('c2c ⇒ 当私聊（null）', normalizeTarget({ scope: 'c2c' }) === null);
t('群但没 peerId ⇒ 私聊（保守）', normalizeTarget({ scope: 'group' }) === null);
t('串进来的垃圾 ⇒ null', normalizeTarget('not-an-openid') === null);
t('合法群 ⇒ 归一成 {scope,peerId}', JSON.stringify(normalizeTarget({ scope: 'GROUP', peerId: 123 })) === '{"scope":"group","peerId":"123"}');
t('describeTarget：群显示前 8 位', describeTarget({ target: { scope: 'group', peerId: '11111111111111111111111111111111' } }) === '群 11111111');
t('describeTarget：无 target ⇒ 私聊', describeTarget({}) === '私聊');

console.log('== 8. 谁能动哪条（canTouch）==');
const gA = '11111111111111111111111111111111';
const gB = '22222222222222222222222222222222';
t('超管：私聊条目也随便动', canTouch({ time: '08:00' }, { isAdmin: true, groupId: null }) === true);
t('超管：别群条目也能动', canTouch({ target: { scope: 'group', peerId: gB } }, { isAdmin: true, groupId: gA }) === true);
t('群成员：本群条目 ⇒ 能动', canTouch({ target: { scope: 'group', peerId: gA } }, { isAdmin: false, groupId: gA }) === true);
t('群成员：别群条目 ⇒ 不能动', canTouch({ target: { scope: 'group', peerId: gB } }, { isAdmin: false, groupId: gA }) === false);
t('群成员：私聊条目 ⇒ 不能动', canTouch({ time: '08:00' }, { isAdmin: false, groupId: gA }) === false);

// ── 下面是端到端：假 ctx + 临时目录 ────────────────────────────────
const dir = await mkdtemp(join(tmpdir(), 'alarm-selftest-'));
const ADMIN = 'AAAA0000000000000000000000000001';
const MEMBER = 'BBBB0000000000000000000000000002';

await writeFile(join(dir, 'groups.json'), JSON.stringify({
  [gB]: { openid: gB, firstSeen: '2026-10-06T04:01:19.046Z', lastSeen: '2026-10-07T02:26:22.541Z', msgs: 9 },
  [gA]: { openid: gA, firstSeen: '2026-10-06T02:19:53.119Z', lastSeen: '2026-10-06T16:00:09.566Z', msgs: 57 },
}, null, 2), 'utf8');

const cfg = { dataDir: dir, adminOpenIds: [ADMIN] };
const alarmsFile = join(dir, 'alarms.json');
const readAlarms = async () => JSON.parse(await readFile(alarmsFile, 'utf8'));

let currentSp = null;
function makeCtx() {
  const box = { tool: null };
  return {
    box,
    get: (name) => (name === 'tools' ? { register: (tool) => { box.tool = tool; } } : null),
  };
}
const ctx = makeCtx();
const okReg = registerAlarmTool(ctx, cfg, { info: () => {}, warn: () => {} }, {},
  { resolveSpeaker: () => currentSp });
t('注册成功且工具名对', okReg === true && ctx.box.tool?.name === ALARM_TOOL_NAME);
const call = (args) => ctx.box.tool.execute(args, { agent: { session: { id: 'sid' } } });

console.log('== 9. 群登记表（loadGroups）==');
const groups = loadGroups(cfg);
t('读到 2 个群', groups.length === 2, String(groups.length));
t('按 lastSeen 倒序（最近的在 1 号）', groups[0]?.openid === gB, groups[0]?.openid);

console.log('== 10. 群里设闹钟（超管）⇒ 目标自动是本群 ==');
currentSp = { openid: ADMIN, name: 'SaYask', scope: 'group', peerId: gA };
let r = await call({ action: 'add', time: '8点', prompt: '提醒群里今晚八点开黑', repeat: 'daily' });
t('回话里点明"发在本群"', /发在.*群/.test(r.text), r.text);
let items = await readAlarms();
t('落盘 1 条', items.length === 1, String(items.length));
t('target.scope = group', items[0]?.target?.scope === 'group');
t('target.peerId = 当前群', items[0]?.target?.peerId === gA, items[0]?.target?.peerId);
t('repeat 保留 daily', items[0]?.repeat === 'daily');

console.log('== 11. 非超管在群里设（开关默认关）⇒ 拒 ==');
currentSp = { openid: MEMBER, name: '路人', scope: 'group', peerId: gA };
r = await call({ action: 'add', time: '9点', prompt: '刷屏' });
t('拒绝并说明只有超管能设', r.text.includes('超管'), r.text);
t('没有新增条目', (await readAlarms()).length === 1);

console.log('== 12. 私聊里超管设群闹钟（按序号指定）==');
currentSp = { openid: ADMIN, name: 'SaYask', scope: 'c2c', peerId: ADMIN };
r = await call({ action: 'add', time: '12:30', prompt: '提醒这个群吃饭', group: '1' });
items = await readAlarms();
t('落盘 2 条', items.length === 2, String(items.length));
t('第 2 条发到 1 号群（= 最近活跃的 gB）', items[1]?.target?.peerId === gB, items[1]?.target?.peerId);
r = await call({ action: 'add', time: '13:00', prompt: 'x', group: '99' });
t('越界序号 ⇒ 提示先看清单', r.text.includes('groups') || r.text.includes('第 99'), r.text);
t('越界没有落盘', (await readAlarms()).length === 2);

console.log('== 13. 私聊里设的就是私聊闹钟（老行为不变）==');
r = await call({ action: 'add', time: '7点半', prompt: '叫他起床' });
items = await readAlarms();
t('落盘 3 条', items.length === 3, String(items.length));
t('第 3 条没有 target（= 私聊）', items[2]?.target === undefined, JSON.stringify(items[2]));
t('回话说明发在私聊', r.text.includes('私聊'), r.text);

console.log('== 14. list 按目标区分显示 ==');
r = await call({ action: 'list' });
t('看得到"私聊"', r.text.includes('[→ 私聊]'), r.text.slice(0, 200));
t('看得到"群 "', r.text.includes('[→ 群 '), r.text.slice(0, 200));

console.log('== 15. groups 动作（列群拿序号）==');
r = await call({ action: 'groups' });
t('列出两个群', r.text.includes('1. 群 ') && r.text.includes('2. 群 '), r.text);

console.log('== 16. 群上限（同一群最多 ' + MAX_PER_GROUP + ' 条）==');
currentSp = { openid: ADMIN, name: 'SaYask', scope: 'group', peerId: gA };
await writeFile(alarmsFile, JSON.stringify(
  Array.from({ length: MAX_PER_GROUP }, (_, i) => ({ time: '0' + i + ':00', prompt: 'p' + i, target: { scope: 'group', peerId: gA } })),
  null, 2), 'utf8');
r = await call({ action: 'add', time: '10:00', prompt: '再来一条' });
t('到上限就拒', r.text.includes('已经有'), r.text);
t('没有落盘第 6 条', (await readAlarms()).length === MAX_PER_GROUP);
currentSp = { openid: ADMIN, name: 'SaYask', scope: 'c2c', peerId: ADMIN };
t('但换个群还能设（私聊里按序号指定）', (await call({ action: 'add', time: '10:00', prompt: 'p', group: '1' })).text.includes('加好了'));

console.log('== 17. 群成员（开关打开）只能碰本群 ==');
// 重置成干净状态：本群 1 条（1 号）+ 别群 1 条（2 号）—— 上面几节把状态改花了
await writeFile(alarmsFile, JSON.stringify([
  { time: '08:00', prompt: '本群的一条', target: { scope: 'group', peerId: gA } },
  { time: '09:00', prompt: '别群的一条', target: { scope: 'group', peerId: gB } },
], null, 2), 'utf8');
const cfg2 = { dataDir: dir, adminOpenIds: [ADMIN], allowMemberGroupAlarms: true };
const ctx2 = makeCtx();
registerAlarmTool(ctx2, cfg2, { info: () => {}, warn: () => {} }, {}, { resolveSpeaker: () => currentSp });
// 现有条目：5 条本群(gA) + 1 条 gB；当前在 gA 里说话的是普通成员
currentSp = { openid: MEMBER, name: '路人', scope: 'group', peerId: gA };
r = await ctx2.box.tool.execute({ action: 'add', time: '11:00', prompt: '本群提醒' }, {});
t('开关打开后群成员能在本群设', r.text.includes('加好了'), r.text);
// 找一条 gB 的条目（第 6 条，index=6）
r = await ctx2.box.tool.execute({ action: 'remove', index: '2' }, {});
t('动别群条目被拒', r.text.includes('不在本群'), r.text);
r = await ctx2.box.tool.execute({ action: 'list' }, {});
t('list 只列本群的（不含别群的）', !r.text.includes(gB.slice(0, 8)), r.text.slice(0, 200));

// 自己收拾干净（别在 /tmp 里留一地）；⚠️ 结果行**必须是最后一行** ——
// post-upgrade 脚本用 	ail -1 判   失败，多打一行就会被判成 FAIL（2026-10-07 踩过）。
await rm(dir, { recursive: true, force: true });

console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
process.exit(fail ? 1 : 0);
