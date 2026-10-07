/**
 * quiz-tool —— `qqbot_quiz`：**抽问 / 背题**（贴着超管那份 C 语言备考计划）。
 *
 * ════════════════════════════════════════════════════════════════
 * 为什么要有它（2026-10-06 · 超管点的 ②）
 * ════════════════════════════════════════════════════════════════
 *
 * 他 2026-11 有 C 语言考试，手上有一份 45 天计划（在**私密档**里）。
 * `qqbot_notes` 已经能"读出来念给他"，但**念 ≠ 练**。
 * 这个工具负责"**问**"：抽一题 → 他答 → 判对错 → 记错题 → 下次优先补不会的。
 *
 * ════════════════════════════════════════════════════════════════
 * 四条纪律
 * ════════════════════════════════════════════════════════════════
 *
 * ① **只在私聊用**。题库来自**私密档**，题面里可能有他的学习安排 ⇒
 *    群里一律拒绝（**同 `qqbot_notes` 的隐私两档**）。
 * ② **只有超管能抽**（跟闹钟 / 发消息 / 出图同一道闸）。
 * ③ **判分要能说清依据**：选择题按字母、填空按"归一化后包含"、代码题按关键词。
 *    **判不准就明说"这题我判不准，你自己对一下答案"** —— 不许糊弄成对或错。
 * ④ **记性写在他自己的数据目录**（`data/quiz-progress.json`，不在只读资料区）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const QUIZ_TOOL_NAME = 'qqbot_quiz';

const DESCRIPTION =
  'Quiz the owner on his study material (C language exam prep): draw a question, grade his answer, '
  + 'track which topics he keeps getting wrong. PRIVATE-CHAT ONLY (the question bank comes from private '
  + 'documents), and super-admin only. '
  + 'Actions: "draw" (get a question — omit topic for a mixed draw, weighted toward weak topics), '
  + '"answer" (grade his reply), "stats" (per-topic accuracy), "reset" (clear progress). '
  + 'When grading is ambiguous, say so instead of guessing.';

const RECENT_SKIP = 6;          // 最近抽过的别马上再抽

function norm(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[；;。.，,、]$/, '')
    .replace(/（/g, '(').replace(/）/g, ')')
    .replace(/＝/g, '=').replace(/！/g, '!').replace(/？/g, '?');
}

function loadBank(cfg, logger) {
  const f = String(cfg.quizBankFile ?? '').trim();
  if (!f || !existsSync(f)) return null;
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    const qs = Array.isArray(j) ? j : j.questions;
    return Array.isArray(qs) && qs.length ? { meta: j.meta ?? {}, questions: qs } : null;
  } catch (err) {
    logger?.warn?.(`题库读不了：${err?.message ?? err}`);
    return null;
  }
}

function progressPath(cfg) {
  return cfg.quizProgressFile || join(cfg.dataDir, 'quiz-progress.json');
}

function loadProgress(cfg) {
  try {
    const p = progressPath(cfg);
    if (existsSync(p)) {
      const j = JSON.parse(readFileSync(p, 'utf8'));
      return { byTopic: j.byTopic ?? {}, byId: j.byId ?? {}, recent: j.recent ?? [] };
    }
  } catch { /* 读坏了就从零开始，别挡着用 */ }
  return { byTopic: {}, byId: {}, recent: [] };
}

function saveProgress(cfg, pr, logger) {
  try {
    const p = progressPath(cfg);
    const d = p.slice(0, p.lastIndexOf('/'));
    if (d && !existsSync(d)) mkdirSync(d, { recursive: true });
    writeFileSync(p, JSON.stringify(pr, null, 1), 'utf8');
  } catch (err) {
    logger?.warn?.(`进度写不了：${err?.message ?? err}`);
  }
}

/** 判分：返回 {verdict:'right'|'wrong'|'unclear', why} */
export function grade(q, raw) {
  const a = norm(raw);
  if (!a) return { verdict: 'unclear', why: '（没看到答案内容）' };

  if (q.type === 'choice') {
    const letter = /^[a-d]$/.exec(a) || (/^[a-d][).、]/.exec(a) || [])[0];
    const pick = letter ? letter[0].toUpperCase() : null;
    const correct = String(q.answer ?? '').trim().toUpperCase();
    if (pick) {
      return pick === correct
        ? { verdict: 'right', why: `选 ${pick}` }
        : { verdict: 'wrong', why: `你选了 ${pick}，正确答案是 ${correct}` };
    }
    // 他可能直接把选项文字打出来
    const idx = (q.options ?? []).findIndex((o) => norm(o) && a.includes(norm(o)));
    if (idx >= 0) {
      const pick2 = 'ABCD'[idx];
      return pick2 === correct
        ? { verdict: 'right', why: `选 ${pick2}（按内容判的）` }
        : { verdict: 'wrong', why: `你选的是 ${pick2}「${q.options[idx]}」，正确答案是 ${correct}` };
    }
    return { verdict: 'unclear', why: '（没认出你选的是哪一项 —— 回 A/B/C/D 就行）' };
  }

  // 填空 / 代码：先按"答案变体"归一化比对，再按关键词
  const answers = Array.isArray(q.answer) ? q.answer : [q.answer];
  for (const exp of answers) {
    const e = norm(exp);
    if (!e) continue;
    if (a === e) return { verdict: 'right', why: `与参考答案一致` };
    // 填空：他可能把答案写进一句话里 ⇒ 允许"答案被包含"。
    // ⚠️ **只允许单向**（a 里含 e）。
    //    双向包含（e 里含 a）是错的：错答「1~5」会被参考答案「0~4」的变形包住，
    //    于是**答错也判对** —— 自测直接抓出来了（2026-10-06）。
    //    另外短答案（<=3 字）不接受包含判定，避免"4"命中"0~4"这种偶然。
    if (q.type === 'fill' && e.length >= 2 && a.length >= e.length && a.includes(e)) {
      return { verdict: 'right', why: `包含参考答案「${exp}」` };
    }
  }
  const kws = (q.keywords ?? []).map(norm).filter(Boolean);
  if (kws.length) {
    const missing = kws.filter((k) => !a.includes(k));
    if (!missing.length) return { verdict: 'right', why: `关键点都写到了（${kws.join(' / ')}）` };
    // 差一个关键词、且答案不是"明显离谱的短句" ⇒ 交给模型判断
    if (missing.length === 1 && a.length >= 8) {
      return { verdict: 'unclear', why: `少了一个关键点（${missing[0]}）—— 这题你自己再核一下` };
    }
    return { verdict: 'wrong', why: `少了关键点：${missing.join(' / ')}` };
  }
  // 填空题的参考答案是明确的短答案 ⇒ 跟他写的一点都不沾边，就是**错**，不用装"判不准"。
  // （代码题才容易"意思对但写法不同"，那才交给 unclear。）
  // ⚠️ 判据要**诚实**：字符重合这种启发式不靠谱（"1~5" 里有个 "1" 就跟 "0~4" 重合了）。
  //    真正能确定判错的是**成分不对**：参考答案是数字/符号，他答的是文字。
  //    纯数字答错（"1~5" vs "0~4"）⇒ 老实说判不准，别硬判。
  if (q.type === 'fill') {
    const joined = norm(answers.filter(Boolean).join(' '));
    const expAlpha = /[a-z]/.test(joined);
    const ansAlpha = /[a-z]/.test(a);
    if (!expAlpha && ansAlpha) return { verdict: 'wrong', why: '跟参考答案不是一回事' };
  }
  return { verdict: 'unclear', why: '（这题我判不准 —— 你自己对一下参考答案）' };
}

export function registerQuizTool(ctx, cfg, logger, deps = {}) {
  const resolveSpeaker = deps.resolveSpeaker;
  const tools = (() => { try { return ctx.get('tools'); } catch { return undefined; } })();
  if (!tools?.register) {
    logger?.warn?.('拿不到 tools 服务，qqbot_quiz 未注册');
    return false;
  }
  const bank0 = loadBank(cfg, logger);
  if (!bank0) {
    logger?.info?.('qqbot_quiz 未注册（题库文件不存在或为空）');
    return false;
  }

  tools.register({
    name: QUIZ_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['draw', 'answer', 'stats', 'reset'], description: 'What to do.' },
        topic: { type: 'string', description: 'For draw: restrict to one topic (e.g. 指针). Omit for a mixed draw.' },
        level: { type: 'string', enum: ['BASIC', 'EXAM'], description: 'For draw: restrict to a level.' },
        text: { type: 'string', description: 'For answer: his reply, verbatim.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args = {}, exec) {
      try {
        // ① 场合：只在私聊（题库来自私密档 —— 与 qqbot_notes 同一条隐私纪律）
        const sp = (() => { try { return resolveSpeaker?.(exec) ?? null; } catch { return null; } })();
        if (String(sp?.scope ?? '').toLowerCase() !== 'c2c') {
          return { text: '（抽问只在私聊里做 —— 题目来自私密资料，群里不合适。）' };
        }
        // ② 身份：只有超管
        const admins = (cfg.adminOpenIds ?? []).map((x) => String(x).toUpperCase());
        if (!sp?.openid || !admins.includes(String(sp.openid).toUpperCase())) {
          return { text: '（抽问只有超管能用。）' };
        }

        const bank = loadBank(cfg, logger) ?? bank0;
        const action = String(args.action ?? '');
        const pr = loadProgress(cfg);

        if (action === 'draw') {
          let pool = bank.questions.slice();
          const topic = String(args.topic ?? '').trim();
          if (topic) pool = pool.filter((q) => String(q.topic ?? '').includes(topic));
          const level = String(args.level ?? '').trim().toUpperCase();
          if (level) pool = pool.filter((q) => String(q.level ?? '').toUpperCase() === level);
          if (!pool.length) return { text: `（题库里没有符合这个条件的题：${topic || ''} ${level || ''}）` };

          // 弱项优先：正确率低的主题加权；但别把没做过的题饿死
          const weight = (q) => {
            const t = pr.byTopic?.[q.topic] ?? { right: 0, wrong: 0 };
            const seen = t.right + t.wrong;
            if (!seen) return 3;                       // 没做过 → 中等偏上
            const acc = t.right / seen;
            return 1 + Math.round((1 - acc) * 6);      // 错得越多权重越高
          };
          const fresh = pool.filter((q) => !(pr.recent ?? []).includes(q.id));
          const use = fresh.length ? fresh : pool;
          const bag = [];
          for (const q of use) for (let i = 0; i < weight(q); i++) bag.push(q);
          const pick = bag[Math.floor(Math.random() * bag.length)] ?? use[0];

          pr.recent = [...(pr.recent ?? []), pick.id].slice(-RECENT_SKIP);
          saveProgress(cfg, pr, logger);

          const head = `【${pick.topic} · ${pick.level === 'BASIC' ? '基础层' : '考试层'}】`;
          let body = `${head}\n${pick.q}`;
          if (pick.type === 'choice' && Array.isArray(pick.options)) {
            body += '\n' + pick.options.map((o, i) => `  ${'ABCD'[i]}. ${o}`).join('\n');
          }
          const t = pr.byTopic?.[pick.topic];
          const tail = t && (t.right + t.wrong) > 0
            ? `\n\n（这个主题你之前 ${t.right} 对 / ${t.wrong} 错。）直接回答案就行，回"不会"也可以。`
            : '\n\n（直接回答案就行；回"不会"我给你讲。）';
          return {
            text: body + tail
              + `\n\n<!-- 判分用，别念出来：id=${pick.id} answer=${JSON.stringify(pick.answer)} -->`,
          };
        }

        if (action === 'answer') {
          // 找"最近抽的那道题"
          const lastId = (pr.recent ?? [])[pr.recent.length - 1];
          const q = bank.questions.find((x) => x.id === lastId);
          if (!q) return { text: '（没找到刚抽的题 —— 先让我抽一题。）' };
          const raw = String(args.text ?? '').trim();
          if (/^(不会|不知道|忘了|不懂|跳过|pass)$/i.test(raw)) {
            const t = pr.byTopic[q.topic] ?? { right: 0, wrong: 0 };
            t.wrong = (t.wrong ?? 0) + 1;
            pr.byTopic[q.topic] = t;
            const idRec = pr.byId[q.id] ?? { right: 0, wrong: 0 };
            idRec.wrong = (idRec.wrong ?? 0) + 1;
            pr.byId[q.id] = idRec;
            saveProgress(cfg, pr, logger);
            return {
              text: `没关系，这题记进错题了。\n**正确答案**：${Array.isArray(q.answer) ? q.answer[0] : q.answer}\n**为什么**：${q.why ?? '（没写解析）'}\n\n（这个主题现在 ${t.right} 对 / ${t.wrong} 错。要再来一题就说"再来"。）`,
            };
          }
          const g = grade(q, raw);
          const t = pr.byTopic[q.topic] ?? { right: 0, wrong: 0 };
          const rec = pr.byId[q.id] ?? { right: 0, wrong: 0 };
          if (g.verdict === 'right') { t.right++; rec.right++; }
          else if (g.verdict === 'wrong') { t.wrong++; rec.wrong++; }
          pr.byTopic[q.topic] = t;
          pr.byId[q.id] = rec;
          saveProgress(cfg, pr, logger);

          const ans = Array.isArray(q.answer) ? q.answer[0] : q.answer;
          if (g.verdict === 'right') {
            return { text: `✅ 对了 —— ${g.why}。\n**解析**：${q.why ?? ''}\n\n（${q.topic}：${t.right} 对 / ${t.wrong} 错。要下一题就说"再来"。）` };
          }
          if (g.verdict === 'wrong') {
            return { text: `❌ 不对 —— ${g.why}。\n**正确答案**：${ans}\n**为什么**：${q.why ?? ''}\n\n（${q.topic}：${t.right} 对 / ${t.wrong} 错。）` };
          }
          return {
            text: `🤔 ${g.why}\n**参考答案**：${ans}\n**为什么**：${q.why ?? ''}\n\n`
              + '（要按参考答案给你判，就说一句"算我对"或"算我错"。）',
          };
        }

        if (action === 'stats') {
          const rows = Object.entries(pr.byTopic ?? {})
            .map(([k, v]) => ({ topic: k, right: v.right ?? 0, wrong: v.wrong ?? 0 }))
            .filter((r) => r.right + r.wrong > 0)
            .sort((a, b) => (a.right / (a.right + a.wrong)) - (b.right / (b.right + b.wrong)));
          if (!rows.length) return { text: '（还没有记录 —— 抽几题就有了。）' };
          const total = rows.reduce((s, r) => s + r.right + r.wrong, 0);
          const lines = rows.map((r) => {
            const acc = Math.round((r.right / (r.right + r.wrong)) * 100);
            return `  · ${r.topic}：${r.right} 对 / ${r.wrong} 错（${acc}%）`;
          });
          const worst = rows[0];
          const untried = [...new Set(bank.questions.map((q) => q.topic))]
            .filter((t) => !(pr.byTopic?.[t] && (pr.byTopic[t].right + pr.byTopic[t].wrong) > 0));
          return {
            text: `做题 ${total} 道，按正确率从低到高：\n${lines.join('\n')}`
              + (worst ? `\n\n最该补的是 **${worst.topic}**（${Math.round((worst.right / (worst.right + worst.wrong)) * 100)}%）。` : '')
              + (untried.length ? `\n还没抽过的主题：${untried.join('、')}。` : '')
              + '\n\n（说"考我 Pointer"或"考我指针"就能只抽那个主题。）',
          };
        }

        if (action === 'reset') {
          saveProgress(cfg, { byTopic: {}, byId: {}, recent: [] }, logger);
          return { text: '（记录清空了。题库没动。）' };
        }

        return { text: `（不认识的 action：${action}）` };
      } catch (err) {
        logger?.warn?.(`抽问工具失败：${err?.message ?? err}`);
        return { text: '（抽问出错了，看日志）' };
      }
    },
  });

  logger?.info?.(`qqbot_quiz 工具已注册（题 ${bank0.questions.length} 道 · 仅超管 · 只在私聊）`);
  return true;
}
