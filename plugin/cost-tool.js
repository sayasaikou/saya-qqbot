/**
 * cost-tool —— `qqbot_cost`：**按场合算 token 账**。
 *
 * ════════════════════════════════════════════════════════════════
 * 为什么要有它（2026-10-06 · 超管点的 ⑥）
 * ════════════════════════════════════════════════════════════════
 *
 * 全量群消息打开之后（`[Chat history begins]` 每轮最多带 30 条），
 * **token 会随群活跃度线性涨** —— 但原来没人看得见"哪个群花得多"：
 * `data/usage/<日>.json` 只按**会话**记账（`bySession`），而"哪个群"根本不在里面。
 *
 * 本工具把两处拼起来：
 *   · **账**：`data/usage/<日>.json` 的 `total` 与 `bySession`
 *   · **归属**：`data/msgs/*.jsonl` 与 `current-speaker.json` 里的
 *     `sessionId ↔ (scope, peerId)` 对应关系
 * ⇒ 于是能回答"这个群今天花了多少""哪个群最贵""私聊占了多少"。
 *
 * ⚠️ 三条纪律（跟 `qqbot_where` 同一套）：
 *   ① **算不出归属的就明说"未归属"**，不许平摊、不许猜（老 usage 文件可能没有对应会话）；
 *   ② **钱不猜**。只报 token；要折算成钱得超管显式配 `costRatePerKToken`，**默认 0 = 不折算**
 *      （编一个单价出来比不报更糟）；
 *   ③ **只读**，不改任何账。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadScenes, sceneLabel } from './scenes.js';

export const COST_TOOL_NAME = 'qqbot_cost';

const DESCRIPTION =
  'Token spend broken down by SCENE (which group / private chat). '
  + 'Usage is recorded per session on disk, so this joins it with the session→scene mapping to answer '
  '"how much did this group cost today" / "which group is the most expensive". '
  + 'Sessions that cannot be mapped are reported as 未归属 (never averaged or guessed). '
  + 'Money is NOT estimated unless an explicit rate is configured. Read-only.';

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function short(id) {
  return String(id ?? '').slice(0, 8);
}

/** sessionId → {scope, peerId} 的映射（msgs 全量 + 说话人表兜底） */
function buildSessionMap(dataDir) {
  const map = new Map();
  // ① msgs/*.jsonl（含历史，最全）
  try {
    const d = join(dataDir, 'msgs');
    if (existsSync(d)) {
      for (const n of readdirSync(d)) {
        if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)) continue;
        let lines = [];
        try { lines = readFileSync(join(d, n), 'utf8').split('\n'); } catch { continue; }
        for (const line of lines) {
          if (!line) continue;
          let e; try { e = JSON.parse(line); } catch { continue; }
          if (e.sessionId && e.scope && e.peerId) {
            map.set(e.sessionId, { scope: e.scope, peerId: e.peerId });
          }
        }
      }
    }
  } catch { /* 没有就没有 */ }
  // ② 说话人表（最近会话的兜底）
  const sp = readJson(join(dataDir, 'current-speaker.json'), {});
  for (const [sid, v] of Object.entries(sp)) {
    if (v?.scope && v?.peerId && !map.has(sid)) map.set(sid, { scope: v.scope, peerId: v.peerId });
  }
  return map;
}

function usageDays(dataDir) {
  try {
    const d = join(dataDir, 'usage');
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n))
      .map((n) => n.replace('.json', ''))
      .sort();
  } catch {
    return [];
  }
}

function loadUsage(dataDir, day) {
  return readJson(join(dataDir, 'usage', `${day}.json`), { day, total: 0, bySession: {} });
}

export function registerCostTool(ctx, cfg, logger, deps = {}) {
  const tools = (() => { try { return ctx.get('tools'); } catch { return undefined; } })();
  if (!tools?.register) {
    logger?.warn?.('拿不到 tools 服务，qqbot_cost 未注册');
    return false;
  }

  tools.register({
    name: COST_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        day: { type: 'string', description: 'Which day (YYYY-MM-DD). Default: today.' },
        days: { type: 'number', description: 'With no day: how many recent days to sum (default 1, max 30).' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        // ⚠️ required 必须是**字符串数组**（或不写）—— 写成 false 会被工具层拒：
        //    "unsupported JSON schema: schema.required must be an array of strings"（实测踩过）
        required: ['text'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value?.text ?? '' }],
    },
    async execute(args = {}) {
      try {
        const allDays = usageDays(cfg.dataDir);
        if (!allDays.length) return { text: '（还没有用量记录）' };

        let picked;
        const explicit = String(args.day ?? '').trim();
        if (explicit) {
          if (!allDays.includes(explicit)) {
            return { text: `（没有 ${explicit} 的用量记录；有的日子：${allDays.join('、')}）` };
          }
          picked = [explicit];
        } else {
          const n = Math.min(Math.max(Number(args.days ?? 1), 1), 30);
          picked = allDays.slice(-n);
        }

        const scenes = loadScenes(cfg);
        const smap = buildSessionMap(cfg.dataDir);

        // 按场合汇总
        const byScene = new Map();
        let unmapped = 0;
        let grand = 0;
        const perDay = [];
        for (const day of picked) {
          const u = loadUsage(cfg.dataDir, day);
          const dayTotal = Number(u.total ?? 0);
          grand += dayTotal;
          perDay.push({ day, total: dayTotal });
          for (const [sid, tok] of Object.entries(u.bySession ?? {})) {
            const n = Number(tok ?? 0);
            const sc = smap.get(sid);
            if (!sc) { unmapped += n; continue; }
            const key = `${sc.scope}|${sc.peerId}`;
            if (!byScene.has(key)) byScene.set(key, { scope: sc.scope, peerId: sc.peerId, tokens: 0, sessions: new Set() });
            const rec = byScene.get(key);
            rec.tokens += n;
            rec.sessions.add(sid);
          }
        }

        const rate = Number(cfg.costRatePerKToken ?? 0);   // 元/千 token；0 = 不折算
        const lines = [];
        lines.push(`【按场合的 token 账】${picked.length === 1 ? picked[0] : picked[0] + ' ~ ' + picked[picked.length - 1]}`);
        lines.push(`合计 ${grand.toLocaleString('en-US')} token`
          + (rate > 0 ? `（按 ${rate} 元/千 token 折算 ≈ ${(grand / 1000 * rate).toFixed(2)} 元）`
            : '（**没有配单价，所以不折算成钱** —— 编一个单价出来比不报更糟）'));
        lines.push('');

        const rows = [...byScene.values()].sort((a, b) => b.tokens - a.tokens);
        if (rows.length) {
          lines.push('■ 按场合（多的在前）');
          for (const r of rows) {
            const label = sceneLabel(scenes, r.scope, r.peerId);
            const pct = grand > 0 ? ((r.tokens / grand) * 100).toFixed(1) : '0.0';
            lines.push(`  · ${label}｜${r.tokens.toLocaleString('en-US')} token（${pct}%）｜${r.sessions.size} 个会话`
              + (rate > 0 ? `｜≈ ${(r.tokens / 1000 * rate).toFixed(2)} 元` : ''));
          }
        } else {
          lines.push('■ 按场合：一个都没归属上（见下面"未归属"）');
        }
        lines.push('');
        if (unmapped > 0) {
          lines.push(`■ 未归属：${unmapped.toLocaleString('en-US')} token（${grand > 0 ? ((unmapped / grand) * 100).toFixed(1) : '0'}%）`);
          lines.push('  ⚠️ 这部分**算不出是哪个场合** —— 可能是更早的会话（那时还没开始落盘场合信息）。'
            + '**我不平摊、不猜**：要说清"这段不知道在哪花的"。');
        } else {
          lines.push('■ 未归属：无（每个会话都对应上了场合）');
        }

        if (picked.length > 1) {
          lines.push('');
          lines.push('■ 按天');
          for (const d of perDay) lines.push(`  · ${d.day}｜${d.total.toLocaleString('en-US')} token`);
        }

        lines.push('');
        lines.push('（口径：token = 输入 + 输出，按会话落盘在 data/usage/<日>.json；场合归属来自落盘消息与说话人表。）');
        return { text: lines.join('\n') };
      } catch (err) {
        return { text: `（算账失败：${err?.message ?? err}）` };
      }
    },
  });

  logger?.info?.('qqbot_cost 工具已注册（按场合算 token 账 · 不平摊不猜价）');
  return true;
}
