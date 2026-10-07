/**
 * selftest-audit.mjs —— 锁住审计层的四条硬纪律：
 *   ① **只记"谁 / 何时 / 哪个工具 / 参数键名与少量白名单值"，绝不把正文抄进去**；
 *   ② 写不进去也不能抛（审计失败不能挡对话）；
 *   ③ **时间戳是本地时间**（带偏移），老的 UTC-only 记录读出来也不能早 8 小时；
 *   ④ **不落 `ok` 键** —— 记的是"发起执行"，不是最终结果，免得把发起当成成功。
 * 跑法：node selftest-audit.mjs
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// ⚠️ 必须走 pathToFileURL：Windows 下 import('C:\...') 会报 ERR_UNSUPPORTED_ESM_URL_SCHEME
//    （云端是 Linux 所以一直没暴露 —— 2026-10-07 在本机上跑才发现）
const { writeAudit, readAudit, localStampOf, AUDIT_KEEP_DAYS } = await import(pathToFileURL(join(here, 'audit.js')).href);

let pass = 0, fail = 0;
const t = (n, c, extra) => { if (c) { pass++; console.log('  PASS ' + n); } else { fail++; console.log('  FAIL ' + n + (extra ? '  ← ' + extra : '')); } };

const dir = mkdtempSync(join(tmpdir(), 'audit-'));
const cfg = { dataDir: dir };
const LONG_PROMPT = '一个很长的提示词'.repeat(20);

console.log('== 1. 写入 ==');
// ⚠️ 故意**不传 ok**（内建工具那条路就是这么写的）：落盘里就不该出现 ok 键，
//    否则读侧会把"发起执行"当成"执行成功"（2026-10-07 修）。
t('写成功', writeAudit(cfg, {
  tool: 'qqbot_draw',
  actor: 'abc123',
  actorName: 'SaYask',
  args: { prompt: LONG_PROMPT, variant: 'shojo', secretish: 'x'.repeat(50) },
}) === true);
t('审计目录出现了', existsSync(join(dir, 'audit')));

console.log('== 2. 读回 + 隐私边界 ==');
const r = readAudit(cfg, { days: 3 });
t('读回 1 条', r.items.length === 1, JSON.stringify(r.items.length));
const e = r.items[0] ?? {};
t('记了工具名', e.tool === 'qqbot_draw');
t('记了人（openid 大写）', e.actor === 'ABC123', String(e.actor));
t('白名单参数留了值', e.args?.kept?.variant === 'shojo');
t('白名单里的长文本只留长度', typeof e.args?.kept?.prompt__len === 'number');
t('**正文没被抄进审计**', !JSON.stringify(e).includes('一个很长的提示词'));
t('非白名单参数只留长度', e.args?.kept?.secretish__len === 50);
t('非白名单参数列进了 otherKeys', (e.args?.otherKeys ?? []).includes('secretish'));

console.log('== 3. 过滤 ==');
t('按 actor 命中', readAudit(cfg, { actor: 'abc123' }).items.length === 1);
t('按 actor 不命中', readAudit(cfg, { actor: 'zzz' }).items.length === 0);
t('按 tool 命中', readAudit(cfg, { tool: 'qqbot_draw' }).items.length === 1);
t('保留 30 天', AUDIT_KEEP_DAYS === 30);

console.log('== 4. 时间戳是本地的（2026-10-07 修：文件名按本地日期滚，时间戳也得是本地） ==');
const dayOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const nowMs = Date.now();
t('新记录带 atLocal', typeof e.atLocal === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}$/.test(e.atLocal), String(e.atLocal));
t('atLocal 指的是同一时刻（±5 秒）', Math.abs(new Date(localStampOf(e)).getTime() - nowMs) < 5000, localStampOf(e));
t('atLocal 的日期＝本地日期（≠ UTC 日期时会现形）', localStampOf(e).slice(0, 10) === dayOf(new Date()), localStampOf(e));
t('老记录（只有 UTC 的 at）换算成本地', localStampOf({ at: '2026-10-07T01:05:18.717Z' }) === (() => {
  const d = new Date('2026-10-07T01:05:18.717Z');
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
})(), localStampOf({ at: '2026-10-07T01:05:18.717Z' }));
t('UTC 01:05 显示成本地钟点（+08 环境＝09）', new Date('2026-10-07T01:05:18.717Z').getHours() === 9, String(new Date('2026-10-07T01:05:18.717Z').getHours()));
t('atLocal 优先于 at', localStampOf({ at: '2026-10-07T01:05:18.717Z', atLocal: '2026-10-07 10:26:30 +08:00' }) === '2026-10-07 10:26:30 +08:00');
t('坏值不抛、原样返回', localStampOf({ at: 'not-a-date' }) === 'not-a-date');
t('缺字段返回空串', localStampOf({}) === '' && localStampOf(undefined) === '');

console.log('== 5. 落盘里不出现 ok 键（发起 ≠ 结果） ==');
const dayFile = join(dir, 'audit', readdirSync(join(dir, 'audit')).filter((n) => n.endsWith('.jsonl')).sort().pop() ?? '');
const firstLine = readFileSync(dayFile, 'utf8').trim().split('\n')[0];
t('落盘第一条没有 ok 字段', JSON.parse(firstLine).ok === undefined, firstLine.slice(0, 120));
t('落盘里也没有正文', !firstLine.includes('一个很长的提示词'));
t('落盘里有 atLocal', typeof JSON.parse(firstLine).atLocal === 'string');

console.log('== 6. 坏环境不炸 ==');
// ⚠️ 别拿 /proc 当"不可写目录"的样本 —— 在 /proc 下写会**挂住**（2026-10-06 实测：
//    自检脚本因此卡死，还留下几个僵尸 node 进程）。改成"只读目录"（确定性 EACCES）
//    与"不存在的普通路径"（确定性 ENOENT）。
const roDir = mkdtempSync(join(tmpdir(), 'audit-ro-'));
if (process.platform === 'win32') {
  // ⚠️ Windows 上 chmod 只是设只读位，写进"只读目录"照样成功 ⇒ 这条断言在 Windows
  //    恒失败，而它**只在云端（Linux）才有意义**。跳过而不是改判据 —— 判据没错。
  console.log('  SKIP 目标不可写 ⇒ 返回 false、不抛（Windows 上 chmod 不生效，云端 Linux 才验）');
} else {
  chmodSync(roDir, 0o500);
  const roChild = join(roDir, 'data');
  t('目标不可写 ⇒ 返回 false、不抛', writeAudit({ dataDir: roChild }, { tool: 'x' }) === false);
  chmodSync(roDir, 0o700);
}
rmSync(roDir, { recursive: true, force: true });
t('读不存在的目录 ⇒ 空结果、不抛', readAudit({ dataDir: '/tmp/definitely-missing-xyz-123' }, {}).items.length === 0);

rmSync(dir, { recursive: true, force: true });
console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
process.exit(fail ? 1 : 0);
