/**
 * rules 端到端自测 —— 用临时目录跑**真实代码**。
 *
 * 要证的是一条真链路，不是函数返回值：
 *   超管下规则 → 落 rules.md（status=trial，24h 到期）
 *   → 每轮注入前惰性过期检查 → 到期**自动撤回并落盘** → `activeRules()` **不再产出它**
 *   → 因此 buildRuleSection 里**不再出现**那条规则 ⇒ 撤回 = 不再注入。
 *
 * 跑法：node selftest-rules-e2e.mjs
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const R = await import(join(here, 'rules.js'));

let pass = 0;
let fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ← ' + extra : '')); }
};

const dir = mkdtempSync(join(tmpdir(), 'rules-'));
const cfg = { dataDir: dir, adminOpenIds: ['ADMIN0000000000000000000000000001'] };
const log2 = { warn: () => {} };
const RULE_TEXT = '群里每天 23:00 之后不许再催本鱼干活';

console.log('== 1. 初始：没有规则、没有文件 ==');
t('空表时 activeRules 为空', R.activeRules([]).length === 0);
t('rules.md 还没被创建（惰性）', !existsSync(R.rulesPath(cfg)));
t('空表也能构造注入段（空串）', R.buildRuleSection([]) === '');

console.log('== 2. 超管下一条规则（走真实工具） ==');
let registered = null;
const fakeCtx = { get: () => ({ register: (spec) => { registered = spec; } }) };
const state = { currentSpeaker: { openid: 'ADMIN0000000000000000000000000001', name: 'SaYask' } };
t('规则工具注册成功', R.registerRuleTool(fakeCtx, cfg, { info() {}, warn() {} }, state) === true);
t('工具名对', registered?.name === 'qqbot_rule');
t('output 带 render', typeof registered?.output?.render === 'function');

const addRes = await registered.execute({ action: 'add', text: RULE_TEXT });
t('下规则成功（回执提到 R-001）', /R-001/.test(addRes.text), addRes.text);
t('回执说"试行中"', /试行/.test(addRes.text));

const onDisk = readFileSync(R.rulesPath(cfg), 'utf8');
t('rules.md 真落盘了', onDisk.includes(RULE_TEXT));
t('状态是 trial', /status: trial/.test(onDisk));
t('写了 24h 到期时间', /until: \d{4}-\d{2}-\d{2}T/.test(onDisk));

const loaded = await R.loadRules(cfg, log2);
t('回读解析出 1 条', loaded.length === 1);
t('回读的正文完整（不是截断的空壳）', loaded[0].body === RULE_TEXT);
const untilMs = Date.parse(loaded[0].until) - Date.parse(loaded[0].created);
t('有效期正好 24 小时', Math.abs(untilMs - 24 * 3600 * 1000) < 5000, String(untilMs));

console.log('== 3. 生效期：注入段里必须有它 ==');
const sec = R.buildRuleSection(loaded);
t('注入段非空', sec.length > 0);
t('注入段含规则正文', sec.includes(RULE_TEXT));
t('注入段标了"必须执行"', /必须/.test(sec));

console.log('== 4. 到期：自动撤回 + 不再注入 ==');
const later = Date.now() + 25 * 3600 * 1000;   // 25 小时后
const expired = JSON.parse(JSON.stringify(loaded));
const res = R.expireRules(expired, later);
t('检测到到期（changed=true）', res.changed === true, JSON.stringify(res.expired ?? []));
t('那条被标成 revoked', expired[0].status === 'revoked', expired[0].status);
t('activeRules 不再产出它', R.activeRules(expired, later).length === 0);
t('注入段里不再出现它（撤回 = 不再注入）', !R.buildRuleSection(expired, later).includes(RULE_TEXT));

// 真落盘一遍（模拟插件每轮惰性执行的那一步），再回读
await R.saveRules(cfg, expired, log2);
const after = await R.loadRules(cfg, log2);
t('撤回状态真写进了 rules.md', after[0].status === 'revoked', after[0].status);
t('回读后依然不注入', !R.buildRuleSection(after, later).includes(RULE_TEXT));

console.log('== 5. 长期规则不过期 ==');
const longRule = [{ id: 'R-002', title: '', status: 'long', until: null, created: new Date().toISOString(), by: 'x', body: '长期规则一条' }];
const far = Date.now() + 400 * 24 * 3600 * 1000;   // 400 天后
t('long 不会被过期', R.expireRules(JSON.parse(JSON.stringify(longRule)), far).changed === false);
t('long 一直注入', R.buildRuleSection(longRule, far).includes('长期规则一条'));

console.log('== 6. 闸门：不是超管下不了 ==');
state.currentSpeaker = { openid: 'BBBB0000000000000000000000000002', name: '路人' };
const denied = await registered.execute({ action: 'add', text: '路人想下的规则' });
t('非超管被拒', /只有超管/.test(denied.text), denied.text);
const listAsStranger = await registered.execute({ action: 'list' });
t('非超管连 list 都拒', /只有超管/.test(listAsStranger.text));
state.currentSpeaker = null;
const noSpeaker = await registered.execute({ action: 'add', text: 'x' });
t('认不出说话人也拒', /只有超管/.test(noSpeaker.text));

console.log('== 7. 到期前 6 小时会提醒（expiringSoon） ==');
const soon = [{ id: 'R-003', title: '', status: 'trial', until: new Date(Date.now() + 3 * 3600 * 1000).toISOString(), created: new Date().toISOString(), by: 'x', body: '快到期了' }];
t('剩 3 小时 = 该提醒', R.expiringSoon(soon, Date.now()).length === 1);
const notSoon = [{ ...soon[0], until: new Date(Date.now() + 20 * 3600 * 1000).toISOString() }];
t('剩 20 小时 = 不提醒', R.expiringSoon(notSoon, Date.now()).length === 0);

rmSync(dir, { recursive: true, force: true });
console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
process.exit(fail ? 1 : 0);
