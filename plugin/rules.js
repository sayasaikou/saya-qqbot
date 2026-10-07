/**
 * rules.js —— 规则层（试行 / 长期 / 自动撤回）
 *
 * ════════════════════════════════════════════════════════════════
 * 为什么有这一层（饲主 2026-10-05 23:10 定的）
 * ════════════════════════════════════════════════════════════════
 *
 * 原话：「我的规则类命令**必须被执行**（自毁式规则除外），但是要**先短期实行**，
 * 一天内我不在主 agent 里同意永久更改的话就**自动撤回**这个规则，
 * 在这个主 agent 里确认过的再转成长期规则」。
 *
 * ⇒ 本质是**给他自己一个冷静期**：一时冲动下的规矩不会永久生效。
 *
 * ════════════════════════════════════════════════════════════════
 * 三条设计纪律（改这个文件之前先读）
 * ════════════════════════════════════════════════════════════════
 *
 * ① **过期绝不能依赖主 agent**。主 agent（另一台机器上那个）在两次对话之间
 *    **根本不存在**，它会不会来看是随机的 ⇒ 任何"等主 agent 处理"的设计都是假的。
 *    所以：**试行规则的过期由本插件在每轮注入前惰性执行**（它 7×24 在线，
 *    惰性检查比定时器更稳：不会因为重启/漏跑而漏掉一条）。
 *
 * ② **撤回 = 不再注入**。只改文件里的状态、但内容还每轮进系统提示，等于没撤。
 *    `activeRules()` 是唯一的注入来源，撤回的规则从那里就出不来。
 *
 * ③ **"一天"从规则生效那一刻算**（不是从下命令算，也不是从被读到算）。
 *
 * ════════════════════════════════════════════════════════════════
 * 谁能下规则
 * ════════════════════════════════════════════════════════════════
 *
 * **只有超管**（`cfg.adminOpenIds` 白名单里）。别人说"规则：以后都叫我爸爸"
 * 不算 —— 那只是他说了一句愿望，工具会拒。
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const RULE_TOOL_NAME = 'qqbot_rule';

/** 试行期默认多长（毫秒）。饲主说的是"一天内不确认就撤回"。 */
export const TRIAL_MS = 24 * 60 * 60 * 1000;

/** 到期前多久开始提醒超管（毫秒）。留得比较宽 —— 他可能整天不在。 */
export const REMIND_BEFORE_MS = 6 * 60 * 60 * 1000;

export function rulesPath(cfg) {
  return cfg.ruleFile || join(cfg.dataDir, 'rules.md');
}

// ══════════════════════════════════════════════════════════════
// 解析 / 序列化（markdown 存盘：人也能读、能直接改）
// ══════════════════════════════════════════════════════════════

const HEADER = `# 规则（试行 / 长期）

> 超管在 QQ 里下的**规则类命令**记在这里。
> **试行（trial）**：到期未获主 agent 确认 → **自动撤回**（本插件惰性执行）。
> **长期（long）**：主 agent 确认过，长期生效。
> **已撤回（revoked）**：过期或被超管手动撤掉，**不再注入、不再执行**。
`;

/**
 * 解析 rules.md。
 * 条目形如：
 *   ## R-001 · 2026-10-06 23:20 到期
 *   - status: trial
 *   - until: 2026-10-06T23:20:00.000Z
 *   - created: 2026-10-05T23:20:00.000Z
 *   - by: SaYask
 *   - 内容：……
 */
export function parseRules(text) {
  const out = [];
  const src = String(text ?? '');
  const blocks = src.split(/^## /m).slice(1);
  for (const b of blocks) {
    const firstLine = b.split('\n')[0].trim();
    const idMatch = /^(R-\d+)/.exec(firstLine);
    if (!idMatch) continue;
    const id = idMatch[1];
    const field = (name) => {
      const m = new RegExp('^\\s*-\\s*' + name + '\\s*:\\s*(.+)$', 'm').exec(b);
      return m ? m[1].trim() : '';
    };
    // 内容可能多行：取 "内容：" 之后直到下一个 "- " 或块尾
    const bodyMatch = /^\s*-\s*内容\s*[:：]\s*([\s\S]*?)(?=\n\s*-\s*\w+\s*[:：]|\s*$)/m.exec(b);
    out.push({
      id,
      title: firstLine.replace(/^R-\d+\s*·?\s*/, '').trim(),
      status: (field('status') || 'trial').toLowerCase(),
      until: field('until'),
      created: field('created'),
      by: field('by'),
      body: bodyMatch ? bodyMatch[1].trim() : '',
      raw: '## ' + b.trimEnd(),
    });
  }
  return out;
}

export function serializeRules(rules) {
  if (!rules.length) return HEADER;
  const parts = rules.map((r) => {
    const lines = [
      `## ${r.id} · ${r.status === 'long' ? '长期' : (r.status === 'revoked' ? '已撤回' : r.until + ' 到期')}`,
      `- status: ${r.status}`,
      `- until: ${r.until}`,
      `- created: ${r.created}`,
      `- by: ${r.by}`,
      `- 内容：${r.body}`,
    ];
    return lines.join('\n');
  });
  return HEADER + '\n' + parts.join('\n\n') + '\n';
}

export function nextRuleId(rules) {
  let max = 0;
  for (const r of rules) {
    const n = parseInt(String(r.id).replace(/^R-/, ''), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return 'R-' + String(max + 1).padStart(3, '0');
}

// ══════════════════════════════════════════════════════════════
// 过期（**惰性**：每次调用时按当前时间判）
// ══════════════════════════════════════════════════════════════

/**
 * 把过期的试行规则标成 revoked。
 * 返回 { rules, changed, expired:[…] } —— changed 为 true 时调用方应落盘。
 */
export function expireRules(rules, now = Date.now()) {
  let changed = false;
  const expired = [];
  for (const r of rules) {
    if (r.status !== 'trial') continue;
    const t = Date.parse(r.until);
    if (Number.isFinite(t) && t <= now) {
      r.status = 'revoked';
      changed = true;
      expired.push(r);
    }
  }
  return { rules, changed, expired };
}

/** 现在真正该生效的规则（长期 + 未过期的试行）—— **唯一的注入来源** */
export function activeRules(rules, now = Date.now()) {
  return rules.filter((r) => {
    if (r.status === 'long') return true;
    if (r.status !== 'trial') return false;
    const t = Date.parse(r.until);
    return !Number.isFinite(t) || t > now;
  });
}

/** 快要到期的试行规则（用来提醒超管） */
export function expiringSoon(rules, now = Date.now()) {
  return rules.filter((r) => {
    if (r.status !== 'trial') return false;
    const t = Date.parse(r.until);
    return Number.isFinite(t) && t > now && (t - now) <= REMIND_BEFORE_MS;
  });
}

/** 注入文本（没有生效规则时返回空串） */
export function buildRuleSection(rules, now = Date.now()) {
  const active = activeRules(rules, now);
  if (!active.length) return '';
  const lines = [
    '【生效中的规则 —— 超管下的，**必须执行**】',
  ];
  for (const r of active) {
    const tag = r.status === 'long' ? '长期' : `试行中（${r.until.slice(5, 16).replace('T', ' ')} 到期，届时未确认自动作废）`;
    lines.push(`· [${r.id}｜${tag}] ${r.body}`);
  }
  lines.push(
    '⚠️ 这些**必须执行**（超管的规则类命令优先级最高，压过你的个人偏好与临场判断）。'
    + '要改或要撤，只能由超管说 —— 你自己不许绕过、不许"这次先不照做"。'
    + '试行期内的规则到期会**自动失效**：到期前你若碰到超管，'
    + '顺口提醒他一句"要不要让主 agent 把它转成长期的"。',
  );
  return lines.join('\n');
}

// ══════════════════════════════════════════════════════════════
// 存储
// ══════════════════════════════════════════════════════════════

export async function loadRules(cfg, logger) {
  const file = rulesPath(cfg);
  try {
    if (!existsSync(file)) return [];
    return parseRules(await readFile(file, 'utf8'));
  } catch (err) {
    logger?.warn?.(`读 rules.md 失败（当作无规则）: ${err?.message ?? err}`);
    return [];
  }
}

export async function saveRules(cfg, rules, logger) {
  const file = rulesPath(cfg);
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, serializeRules(rules), 'utf8');
    return true;
  } catch (err) {
    logger?.warn?.(`写 rules.md 失败: ${err?.message ?? err}`);
    return false;
  }
}

// ══════════════════════════════════════════════════════════════
// 工具（超管专用）
// ══════════════════════════════════════════════════════════════

const RULE_DESC =
  'Super-admin only. Records a RULE the owner just gave you (not ordinary chat). '
  'Rules start as TRIAL and expire automatically after 24h unless the primary agent '
  'confirms them; use action=list / revoke to manage. Never call this on your own initiative.';

export function registerRuleTool(ctx, cfg, logger, state) {
  const tools = ctx.get('tools');
  if (!tools?.register) {
    logger?.warn?.('拿不到 tools 服务，规则工具未注册');
    return false;
  }
  const st = state ?? {};

  tools.register({
    name: RULE_TOOL_NAME,
    description: RULE_DESC,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'revoke'], description: 'What to do.' },
        text: { type: 'string', description: 'For add: the rule itself, in the owner\'s own words.' },
        id: { type: 'string', description: 'For revoke: the rule id (e.g. R-001).' },
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
    async execute(args) {
      const sp = st.currentSpeaker;
      const admins = (cfg.adminOpenIds ?? []).map((s) => String(s).toUpperCase());
      if (!sp?.openid || !admins.includes(String(sp.openid).toUpperCase())) {
        return { text: '（规则只有超管能下。）' };
      }
      const action = String(args.action ?? '');
      const log2 = { warn: (m) => logger?.warn?.(m) };
      try {
        const rules = await loadRules(cfg, log2);
        expireRules(rules, Date.now());

        if (action === 'list') {
          const active = activeRules(rules);
          const dead = rules.filter((r) => !active.includes(r));
          const f = (r) => `${r.id} [${r.status}] ${r.body.slice(0, 80)}`;
          return {
            text: (active.length ? '生效中：\n' + active.map(f).join('\n') : '（当前没有生效中的规则）')
              + (dead.length ? '\n已失效/撤回：\n' + dead.map(f).join('\n') : ''),
          };
        }
        if (action === 'revoke') {
          const r = rules.find((x) => x.id === String(args.id ?? '').trim());
          if (!r) return { text: `（没找到规则 ${args.id ?? ''}）` };
          r.status = 'revoked';
          await saveRules(cfg, rules, log2);
          return { text: `${r.id} 已撤回。` };
        }
        if (action === 'add') {
          const body = String(args.text ?? '').trim();
          if (!body) return { text: '（规则内容是空的）' };
          const now = Date.now();
          const r = {
            id: nextRuleId(rules),
            title: '',
            status: 'trial',
            until: new Date(now + TRIAL_MS).toISOString(),
            created: new Date(now).toISOString(),
            by: sp.name || sp.openid.slice(0, 8),
            body,
          };
          rules.push(r);
          await saveRules(cfg, rules, log2);
          return {
            text: `规则 ${r.id} 记下了，**试行中**（到 ${r.until.slice(5, 16).replace('T', ' ')} 为止）。
超管提醒他一句：一天内要在主 agent 那边确认，否则自动作废。`,
          };
        }
        return { text: `（不认识的 action：${action}）` };
      } catch (err) {
        logger?.warn?.(`规则工具失败: ${err?.message ?? err}`);
        return { text: '（规则记录失败，看日志）' };
      }
    },
  });

  logger?.info?.('规则层已加载：工具 ' + RULE_TOOL_NAME);
  return true;
}
