/**
 * history-tool 自测 —— 用临时目录跑**真实代码**，不碰线上数据。
 * 跑法：node selftest-history.mjs
 */
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { logIncomingMessage, searchHistory, registerHistoryTool } = await import(join(here, 'history-tool.js'));

let pass = 0;
let fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  PASS ' + name); } else { fail++; console.log('  FAIL ' + name); } };

const dir = mkdtempSync(join(tmpdir(), 'hist-'));
const cfg = { dataDir: dir, adminOpenIds: ['ADMIN0000000000000000000000000001'] };

console.log('== 1. 落盘 ==');
const base = Date.now();
t('写入返回 true', logIncomingMessage(cfg, {
  at: base, sessionId: 's1', scope: 'group', peerId: 'G1',
  openid: 'AAAA0000000000000000000000000001', name: '甲', text: '第一条',
}) === true);
for (let i = 2; i <= 12; i++) {
  logIncomingMessage(cfg, {
    at: base + i * 1000, sessionId: 's1', scope: 'group', peerId: 'G1',
    openid: 'AAAA0000000000000000000000000001', name: '甲', text: '第' + i + '条',
  });
}
logIncomingMessage(cfg, {
  at: base + 20000, sessionId: 's2', scope: 'group', peerId: 'G2',
  openid: 'BBBB0000000000000000000000000002', name: '乙', text: '另一个群的话',
});
const files = readdirSync(join(dir, 'msgs'));
t('生成了按天分片的文件', files.length === 1 && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(files[0]));
const raw = readFileSync(join(dir, 'msgs', files[0]), 'utf8').trim().split('\n');
t('13 条都写进去了', raw.length === 13);
t('每行是合法 JSON', raw.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }));

console.log('== 2. 按人查 ==');
const r1 = searchHistory(cfg, { sender: 'AAAA0000000000000000000000000001', limit: 50 });
t('甲的 12 条全查到', r1.items.length === 12);
t('不含乙的话', r1.items.every((e) => e.name === '甲'));
t('旧→新排序', r1.items[0].text === '第一条' && r1.items[11].text === '第12条');

console.log('== 3. limit 取最新 ==');
const r2 = searchHistory(cfg, { sender: 'AAAA0000000000000000000000000001', limit: 3 });
t('只回 3 条', r2.items.length === 3);
t('回的是最新的 3 条', r2.items[2].text === '第12条' && r2.items[0].text === '第10条');

console.log('== 4. 按群 / 关键词 / 时间 ==');
t('按 peerId 过滤', searchHistory(cfg, { peerId: 'G2' }).items.length === 1);
t('关键词命中', searchHistory(cfg, { text: '第12' }).items.length === 1);
t('关键词不命中 = 空', searchHistory(cfg, { text: '不存在的话' }).items.length === 0);
// ⚠️ 断言要按真实精度写：at = base + i*1000，所以 since=base+10000 时
//    第 10 条正好落在边界上、算命中 ⇒ 是 3 条，不是 2 条。
//    （首版写成 2 条是断言错，不是过滤器错 —— 靠自测抓出来的。）
const r3 = searchHistory(cfg, { sender: 'AAAA0000000000000000000000000001', since: new Date(base + 10000).toISOString() });
t('since 过滤（含边界）', r3.items.length === 3 && r3.items[0].text === '第10条' && r3.items[2].text === '第12条');

console.log('== 5. 工具闸门（隐私边界）==');
let registered = null;
const fakeCtx = { get: () => ({ register: (spec) => { registered = spec; } }) };
const ok = registerHistoryTool(fakeCtx, cfg, { info() {}, warn() {} }, {
  resolveSpeaker: () => ({ openid: 'AAAA0000000000000000000000000001', name: '甲' }),
});
t('注册成功', ok === true && registered?.name === 'qqbot_history');
t('output 带 render（少它会在真服务里注册失败）', typeof registered?.output?.render === 'function');

const call = (args, speaker) => {
  const ctx2 = { get: () => ({ register: (spec) => { registered = spec; } }) };
  registerHistoryTool(ctx2, cfg, { info() {}, warn() {} }, { resolveSpeaker: () => speaker });
  return registered.execute(args, {});
};

const asJia = await call({}, { openid: 'AAAA0000000000000000000000000001', name: '甲' });
t('普通人默认只查到自己的', asJia.text.includes('第12条') && !asJia.text.includes('另一个群的话'));
const asJiaPeek = await call({ sender: 'BBBB0000000000000000000000000002' }, { openid: 'AAAA0000000000000000000000000001', name: '甲' });
t('普通人查别人 = 被拒', asJiaPeek.text.includes('隐私边界'));
const asAdmin = await call({ limit: 50 }, { openid: 'ADMIN0000000000000000000000000001', name: '超管' });
t('超管默认能看全部', asAdmin.text.includes('另一个群的话') && asAdmin.text.includes('第12条'));
const noSpeaker = await call({}, null);
t('取不到说话人 = 拒绝查询', noSpeaker.text.includes('取不到当前说话人'));

console.log('== 6. 坏数据不炸 ==');
logIncomingMessage(cfg, { at: base, sessionId: 's9', scope: 'group', openid: null, name: null, text: '无名' });
t('openid 为 null 也能写', searchHistory(cfg, { text: '无名' }).items.length === 1);

rmSync(dir, { recursive: true, force: true });
console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
process.exit(fail ? 1 : 0);
