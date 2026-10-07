/**
 * selftest-quiz.mjs —— 锁住 T-022「抽问/背题」：
 *   ① 判分（选择题/填空/代码题/判不准时别瞎判）
 *   ② 抽题 → 答题 → 记分 → stats 的闭环
 *   ③ **隐私闸门**：群里拒绝、非超管拒绝
 * 跑法：node selftest-quiz.mjs
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { grade, registerQuizTool } = await import(join(here, 'quiz-tool.js'));

let pass = 0, fail = 0;
const t = (n, c, extra) => { if (c) { pass++; console.log('  PASS ' + n); } else { fail++; console.log('  FAIL ' + n + (extra ? '  ← ' + extra : '')); } };

const ADMIN = 'ADMIN0000000000000000000000000001';
const OTHER = 'OTHER0000000000000000000000000002';
const dir = mkdtempSync(join(tmpdir(), 'quiz-'));
const bankFile = join(dir, 'bank.json');
writeFileSync(bankFile, JSON.stringify({
  questions: [
    { id: 'q1', topic: '指针', level: 'EXAM', type: 'choice', q: 'p+1 是什么？', options: ['加1字节', '加一个int'], answer: 'B', why: '按类型宽度走' },
    { id: 'q2', topic: '数组', level: 'BASIC', type: 'fill', q: 'int a[5] 合法下标？', answer: ['0~4', '0-4'], why: '从 0 开始' },
    { id: 'q3', topic: '函数', level: 'BASIC', type: 'code', q: '求最大值的函数体', answer: ['int m=a[0]; for(...) ...; return m;'], keywords: ['for', 'return'], why: '初值取 a[0]' },
    { id: 'q4', topic: '字符串', level: 'BASIC', type: 'fill', q: 'char* s 与 char s[] 的区别', answer: ['指针 vs 数组'], keywords: ['指针', '数组'], why: '能否改内容' },
  ],
}), 'utf8');
const cfg = { dataDir: dir, quizBankFile: bankFile, adminOpenIds: [ADMIN] };

console.log('== 1. 判分：选择题 ==');
const q1 = { type: 'choice', options: ['加1字节', '加一个int'], answer: 'B' };
t('回 "B" ⇒ 对', grade(q1, 'B').verdict === 'right');
t('回 "b" ⇒ 对（大小写不敏感）', grade(q1, 'b').verdict === 'right');
t('回 "A" ⇒ 错', grade(q1, 'A').verdict === 'wrong');
t('回选项文字 ⇒ 也能判对', grade(q1, '加一个int').verdict === 'right');
t('回选项文字（选错那个）⇒ 错', grade(q1, '加1字节').verdict === 'wrong');
t('回乱七八糟 ⇒ 判不准（不瞎判）', grade(q1, '我不知道啦').verdict === 'unclear');

console.log('== 2. 判分：填空 ==');
const q2 = { type: 'fill', answer: ['0~4', '0-4'] };
t('完全一致 ⇒ 对', grade(q2, '0~4').verdict === 'right');
t('另一种写法 ⇒ 对', grade(q2, '0-4').verdict === 'right');
t('包在句子里 ⇒ 对', grade(q2, '合法下标是 0~4 吧').verdict === 'right');
// ⚠️ 纯数字答错（"1~5" vs "0~4"）⇒ **诚实的 unclear**：机器判不准就别硬判，
//    由它把参考答案摆出来让他自己核。真正能确定判错的是"成分不对"（下面那条）。
t('纯数字答错 ⇒ 判不准（不硬判）', grade(q2, '1~5').verdict === 'unclear');
t('答成完全不相干的东西 ⇒ 判错', grade(q2, 'blue whale').verdict === 'wrong');
t('答错但仍是数字 ⇒ 不硬判错（诚实优先）', grade(q2, '0~3').verdict !== 'right');

console.log('== 3. 判分：代码题（关键词）==');
const q3 = { type: 'code', answer: ['x'], keywords: ['for', 'return'] };
t('关键词齐 ⇒ 对', grade(q3, 'int m=a[0]; for(int i=1;i<n;i++){} return m;').verdict === 'right');
t('少一个关键词但答得不短 ⇒ 判不准（交给他自己核）', grade(q3, 'int m=a[0]; return m;').verdict === 'unclear');
t('基本没写 ⇒ 错', grade(q3, '不会写').verdict === 'wrong');
t('空答案 ⇒ 判不准', grade(q3, '   ').verdict === 'unclear');

console.log('== 4. 隐私与身份闸门 ==');
async function run(sp, args) {
  let spec = null;
  const ctx = { get: () => ({ register: (s) => { spec = s; } }) };
  registerQuizTool(ctx, cfg, { info() {}, warn() {} }, { resolveSpeaker: () => sp });
  return (await spec.execute(args, {})).text;
}
const c2c = { openid: ADMIN, name: 'SaYask', scope: 'c2c' };
const grp = { openid: ADMIN, name: 'SaYask', scope: 'group' };
const other = { openid: OTHER, name: '某人', scope: 'c2c' };
t('群里 ⇒ 拒绝', (await run(grp, { action: 'draw' })).includes('只在私聊'));
t('非超管私聊 ⇒ 拒绝', (await run(other, { action: 'draw' })).includes('只有超管'));
t('取不到说话人 ⇒ 拒绝（保守）', (await run(null, { action: 'draw' })).includes('只在私聊'));
t('超管私聊 ⇒ 抽到题', (await run(c2c, { action: 'draw' })).includes('【'));

console.log('== 5. 闭环：抽 → 答 → 记分 → stats ==');
const drawn = await run(c2c, { action: 'draw' });
const idm = /id=(\w+)/.exec(drawn);
t('抽题时带了判分用的 id', !!idm, drawn.slice(0, 80));
const right = await run(c2c, { action: 'answer', text: 'B' });
t('答 B ⇒ 走判分（对或错都行，别是报错）', right.length > 10 && !right.includes('出错了'), right.slice(0, 60));
const dontknow = await run(c2c, { action: 'answer', text: '不会' });
t('回"不会" ⇒ 给答案 + 记错题', dontknow.includes('正确答案') && dontknow.includes('错题'), dontknow.slice(0, 60));
const st = await run(c2c, { action: 'stats' });
t('stats 有内容', st.includes('做题') || st.includes('还没有记录'), st.slice(0, 60));
const pr = JSON.parse(readFileSync(join(dir, 'quiz-progress.json'), 'utf8'));
t('进度真的落盘了', !!pr.byTopic, JSON.stringify(Object.keys(pr)));
t('进度里没有题库正文（只记分数）', !JSON.stringify(pr).includes('按类型宽度走'));
t('reset 清空', (await run(c2c, { action: 'reset' })).includes('清空'));
const pr2 = JSON.parse(readFileSync(join(dir, 'quiz-progress.json'), 'utf8'));
t('清空后 byTopic 为空', Object.keys(pr2.byTopic).length === 0);

console.log('== 6. 弱项优先抽题（错得多的主题权重更高）==');
const cfg2 = { ...cfg, dataDir: mkdtempSync(join(tmpdir(), 'quiz2-')) };
writeFileSync(join(cfg2.dataDir, 'quiz-progress.json'), JSON.stringify({
  byTopic: { 指针: { right: 0, wrong: 9 }, 数组: { right: 9, wrong: 0 } }, byId: {}, recent: [],
}), 'utf8');
let pointerHits = 0;
for (let i = 0; i < 40; i++) {
  let spec = null;
  const ctx = { get: () => ({ register: (s) => { spec = s; } }) };
  registerQuizTool(ctx, cfg2, { info() {}, warn() {} }, { resolveSpeaker: () => c2c });
  const txt = (await spec.execute({ action: 'draw' }, {})).text;
  if (txt.includes('指针')) pointerHits++;
}
t('40 次抽样里"指针"（错得多）出现占多数', pointerHits >= 20, `指针出现 ${pointerHits}/40`);

rmSync(dir, { recursive: true, force: true });
rmSync(cfg2.dataDir, { recursive: true, force: true });
console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
process.exit(fail ? 1 : 0);
