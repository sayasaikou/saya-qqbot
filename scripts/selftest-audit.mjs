/**
 * selftest-audit.mjs —— 锁住审计层的两条硬纪律：
 *   ① **只记"谁 / 何时 / 哪个工具 / 参数键名与少量白名单值"，绝不把正文抄进去**；
 *   ② 写不进去也不能抛（审计失败不能挡对话）。
 * 跑法：node selftest-audit.mjs
 */
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { writeAudit, readAudit, AUDIT_KEEP_DAYS } = await import(join(here, 'audit.js'));

let pass = 0, fail = 0;
const t = (n, c, extra) => { if (c) { pass++; console.log('  PASS ' + n); } else { fail++; console.log('  FAIL ' + n + (extra ? '  ← ' + extra : '')); } };

const dir = mkdtempSync(join(tmpdir(), 'audit-'));
const cfg = { dataDir: dir };
const LONG_PROMPT = '一个很长的提示词'.repeat(20);

console.log('== 1. 写入 ==');
t('写成功', writeAudit(cfg, {
  tool: 'qqbot_draw',
  actor: 'abc123',
  actorName: 'SaYask',
  args: { prompt: LONG_PROMPT, variant: 'shojo', secretish: 'x'.repeat(50) },
  ok: true,
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

console.log('== 4. 坏环境不炸 ==');
// ⚠️ 别拿 /proc 当"不可写目录"的样本 —— 在 /proc 下写会**挂住**（2026-10-06 实测：
//    自检脚本因此卡死，还留下几个僵尸 node 进程）。改成"只读目录"（确定性 EACCES）
//    与"不存在的普通路径"（确定性 ENOENT）。
const roDir = mkdtempSync(join(tmpdir(), 'audit-ro-'));
chmodSync(roDir, 0o500);
const roChild = join(roDir, 'data');
t('目标不可写 ⇒ 返回 false、不抛', writeAudit({ dataDir: roChild }, { tool: 'x' }) === false);
chmodSync(roDir, 0o700);
rmSync(roDir, { recursive: true, force: true });
t('读不存在的目录 ⇒ 空结果、不抛', readAudit({ dataDir: '/tmp/definitely-missing-xyz-123' }, {}).items.length === 0);

rmSync(dir, { recursive: true, force: true });
console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
process.exit(fail ? 1 : 0);
