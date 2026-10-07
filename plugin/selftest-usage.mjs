/**
 * selftest-usage.mjs —— 锁住 T-018 那条链：**按人记账 → 落盘 → 回读**。
 *
 * 只测"记账与持久化"这一层（不碰插件其余部分）：用临时目录，按插件里 addUsage 的
 * 同一套写法跑，再回读校验。**不含**"插件在真实会话里能不能取到人"（那条靠 speaker 自测）。
 *
 * 跑法：node selftest-usage.mjs
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const t = (n, c, extra) => { if (c) { pass++; console.log('  PASS ' + n); } else { fail++; console.log('  FAIL ' + n + (extra ? '  ← ' + extra : '')); } };

const dir = mkdtempSync(join(tmpdir(), 'usage-'));
const usageDir = join(dir, 'usage');
mkdirSync(usageDir, { recursive: true });
const day = '2026-10-06';
const file = join(usageDir, `${day}.json`);

/** 复刻插件的写法（loadUsage → 累加 → 写回） */
function loadUsage() {
  try {
    const o = JSON.parse(readFileSync(file, 'utf8'));
    if (!o.bySession) o.bySession = {};
    if (!o.byOpenid) o.byOpenid = {};
    return o;
  } catch {
    return { day, total: 0, bySession: {}, byOpenid: {} };
  }
}
function addUsage(sessionId, tokens, openid = null) {
  const data = loadUsage();
  data.total += tokens;
  data.bySession[sessionId] = (data.bySession[sessionId] ?? 0) + tokens;
  if (openid) {
    const k = String(openid).toUpperCase();
    data.byOpenid[k] = (data.byOpenid[k] ?? 0) + tokens;
  }
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

const ADMIN = 'ADMIN0000000000000000000000000001';
const USER = 'USER00000000000000000000000000002';
const GROUP = 'group-session-1';

console.log('== 1. 群里两个人各说一句（同一个 session）==');
addUsage(GROUP, 1000, ADMIN);
addUsage(GROUP, 500, USER);
let d = loadUsage();
t('session 池 = 群总量 1500', d.bySession[GROUP] === 1500, JSON.stringify(d.bySession));
t('byOpenid 记了两个人', Object.keys(d.byOpenid).length === 2);
t('超管 1000', d.byOpenid[ADMIN] === 1000);
t('普通用户 500', d.byOpenid[USER] === 500);

console.log('== 2. 关键点：**个人量 ≠ 群总量** ==');
t('群池 1500 ≠ 个人 500（这就是要修的 bug 的反面）', d.bySession[GROUP] !== d.byOpenid[USER]);

console.log('== 3. 老文件（没有 byOpenid）也能升上来 ==');
writeFileSync(file, JSON.stringify({ day, total: 800, bySession: { [GROUP]: 800 } }, null, 2), 'utf8');
addUsage(GROUP, 200, USER);
d = loadUsage();
t('老文件被补上 byOpenid 字段', !!d.byOpenid);
t('老总量保留 + 新量累加', d.total === 1000, String(d.total));
t('byOpenid 只记新那一笔（老数据无法追溯，不编）', d.byOpenid[USER] === 200);

console.log('== 4. 取不到人时（openid=null）只记会话，不瞎记 ==');
addUsage(GROUP, 300, null);
d = loadUsage();
t('总量 +300', d.total === 1300, String(d.total));
t('byOpenid 没多出条目', Object.keys(d.byOpenid).length === 1, JSON.stringify(d.byOpenid));

console.log('== 5. 倍率语义（与插件 multiplierFor 一致：超管 2 / 陌生 0.33）==');
const capOf = (base, mult) => Math.round(base * mult);
t('基准 300k × 超管 2 = 600k', capOf(300000, 2) === 600000);
t('基准 300k × 陌生 0.33 = 99k', capOf(300000, 0.33) === 99000);
t('个人 500 < 个人额度 ⇒ 不该被限', d.byOpenid[USER] < capOf(300000, 1));

rmSync(dir, { recursive: true, force: true });
console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
process.exit(fail ? 1 : 0);
