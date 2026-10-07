/**
 * where-tool —— `qqbot_where`：回答「我都在哪些场合」。
 *
 * ════════════════════════════════════════════════════════════════
 * 为什么要有它（2026-10-06 它自己在群里提的）
 * ════════════════════════════════════════════════════════════════
 *
 * 超管问它"你分别在哪几个群"，它答不出来，只能靠"这个会话里有没有别人插话"去**猜**，
 * 并且老老实实说"这是推断不是记录里写的"。那句诚实是对的，但**能修**：
 * 数据其实散在三个地方（下面"事实来源"），只是没人给它们拼起来。
 *
 * ⚠️⚠️ 本工具的头号纪律：**事实与推断必须分开写**
 *
 *   · **事实**：`groups.json` / `current-speaker.json` / `msgs/*.jsonl` 里**真读到的字段**；
 *   · **推断**：靠启发式猜出来的（比如"这个会话像群"）—— 必须显式标成【推断】，
 *     并说明依据；**不许冒充事实**。
 *   · **未知**：老记录（`data/history/*.jsonl`）里**只有 ts/role/text**，
 *     没有群号也没有场景 —— 那些数据**永远补不回来**，要主动声明这一点。
 *
 *   这条不是洁癖：它已经在群里说过一次"我只能猜"，如果工具把猜的说成事实，
 *   下次它会拿假事实当依据 —— 比"不知道"糟得多。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadScenes, sceneLabel } from './scenes.js';

export const WHERE_TOOL_NAME = 'qqbot_where';

const DESCRIPTION =
  'Answer "where have I been?" — which groups/private chats you have talked in, how much, and when last. '
  'Reads the adapter\'s group registry, the per-session speaker table, and the persisted message log. '
  'IMPORTANT: the output separates FACTS (fields actually read from disk) from INFERENCES (guesses). '
  'Never present an inference as a fact. Old records (before 2026-10-06) carry no group id and no scope — '
  'that data cannot be recovered, say so instead of guessing.';

function readJson(file) {
  try {
    if (!existsSync(file)) return null;
    const o = JSON.parse(readFileSync(file, 'utf8'));
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

function short(id) {
  return String(id ?? '').slice(0, 8);
}

function localTime(ms) {
  if (!ms) return '未知';
  try {
    return new Date(Number(ms)).toISOString().replace('T', ' ').slice(0, 16);
  } catch {
    return '未知';
  }
}

/** 扫落盘消息，按 (scope, peerId) 汇总 —— 这是**唯一**带场合信息的历史来源 */
function aggregate(files, maxLinesPerFile) {
  const agg = new Map();
  for (const f of files) {
    let lines;
    try {
      lines = readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(-maxLinesPerFile);
    } catch {
      continue;
    }
    for (const line of lines) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const scope = e.scope ?? null;
      const peer = e.peerId ?? null;
      const key = (scope ?? '?') + '|' + (peer ?? '?');
      if (!agg.has(key)) {
        agg.set(key, { scope, peerId: peer, msgs: 0, first: null, last: null, people: new Set() });
      }
      const a = agg.get(key);
      a.msgs++;
      if (e.at) {
        if (!a.first || e.at < a.first) a.first = e.at;
        if (!a.last || e.at > a.last) a.last = e.at;
      }
      if (e.name) a.people.add(e.name);
      else if (e.openid) a.people.add(short(e.openid));
    }
  }
  return [...agg.values()].sort((x, y) => (y.last ?? 0) - (x.last ?? 0));
}

export function registerWhereTool(ctx, cfg, logger, deps = {}) {
  const tools = (() => { try { return ctx.get('tools'); } catch { return undefined; } })();
  if (!tools?.register) {
    logger?.warn?.('拿不到 tools 服务，qqbot_where 未注册');
    return false;
  }
  const resolveSpeaker = deps.resolveSpeaker;

  tools.register({
    name: WHERE_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        detail: {
          type: 'string',
          description: 'Optional: "scenes" (default, list groups/private chats) or "people" (who talked in them).',
        },
      },
      required: [],
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
    async execute(args = {}) {
      try {
        const detail = String(args.detail ?? 'scenes').trim().toLowerCase();
        const dataDir = cfg.dataDir;

        // ── 事实来源①：群登记表（适配器入站时记的）
        const groups = readJson(join(dataDir, 'groups.json')) ?? {};
        const scenes = loadScenes(cfg);
        // ── 事实来源②：按会话的说话人表（含 scope / peerId）
        const speakers = readJson(join(dataDir, 'current-speaker.json')) ?? {};
        // ── 事实来源③：落盘消息（唯一带场合的历史）
        let msgFiles = [];
        try {
          const d = join(dataDir, 'msgs');
          if (existsSync(d)) {
            msgFiles = readdirSync(d).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort().map((n) => join(d, n));
          }
        } catch { /* 没有就没有 */ }
        const peopleByPeer = new Map();
        for (const f of msgFiles) {
          let lines = [];
          try { lines = readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { continue; }
          for (const line of lines) {
            let e; try { e = JSON.parse(line); } catch { continue; }
            const key = (e.scope ?? '?') + '|' + (e.peerId ?? '?');
            if (!peopleByPeer.has(key)) peopleByPeer.set(key, new Set());
            const who = e.name || (e.openid ? short(e.openid) : null);
            if (who) peopleByPeer.get(key).add(who);
          }
        }
        const agg = aggregate(msgFiles, 20000);

        const lines = [];
        lines.push('【你都在哪些场合】（前半是事实，后半是推断与未知 —— 别混着说）');
        lines.push('');

        // ── 事实 A：群登记表
        const gids = Object.keys(groups);
        lines.push(`■ 事实①：适配器登记的群 = ${gids.length} 个`);
        if (gids.length) {
          for (const g of gids) {
            const v = groups[g] ?? {};
            lines.push(`  · ${sceneLabel(scenes, 'group', g)}｜首见 ${String(v.firstSeen ?? '?').slice(0, 16).replace('T', ' ')}`
              + `｜最近 ${String(v.lastSeen ?? '?').slice(0, 16).replace('T', ' ')}｜累计 ${v.msgs ?? '?'} 条`);
          }
          lines.push('  ⚠️ **群里登记表里没有群名** —— QQ 平台侧就不把群名给机器人，所以只能按 openid 前 8 位认。');
          lines.push('     要名字的话：超管用 qqbot_scene 给这个场合起一个（纯显示层，不影响权限/分数/额度）。');
        } else {
          lines.push('  （一个都没有 —— 还没在任何群里被 @ 过）');
        }
        lines.push('');

        // ── 事实 B：按会话的说话人表（含场景）
        const spRows = Object.entries(speakers);
        lines.push(`■ 事实②：按会话记录的"最后说话的人" = ${spRows.length} 条`);
        for (const [sid, v] of spRows) {
          lines.push(`  · 会话 ${short(sid)}…｜场景=${v?.scope ?? '?'}｜对象=${short(v?.peerId)}…`
            + `｜人=${v?.name ?? short(v?.openid)}｜记录于 ${localTime(v?.at)}`);
        }
        lines.push('');

        // ── 事实 C：落盘消息（带场合）
        lines.push(`■ 事实③：落盘消息（${msgFiles.length} 天的文件）—— **只有这一份带场合信息**`);
        if (agg.length) {
          for (const a of agg) {
            const where = (a.scope === 'group' || a.scope === 'c2c')
              ? sceneLabel(scenes, a.scope, a.peerId) : '场景未记录';
            const who = [...(peopleByPeer.get((a.scope ?? '?') + '|' + (a.peerId ?? '?')) ?? [])];
            lines.push(`  · ${where}｜${a.msgs} 条｜${localTime(a.first)} → ${localTime(a.last)}`
              + (who.length ? `｜出现过：${who.join('、')}` : ''));
          }
        } else {
          lines.push('  （还没有落盘消息）');
        }
        lines.push('');

        // ── 推断区（明确标注）
        lines.push('■ 推断（**不是记录里写的**，说的时候必须带上"我猜"）');
        const histDir = join(dataDir, 'history');
        let histFiles = [];
        try {
          if (existsSync(histDir)) histFiles = readdirSync(histDir).filter((n) => n.endsWith('.jsonl'));
        } catch { /* ignore */ }
        lines.push(`  · \`data/history/\` 里还有 ${histFiles.length} 个会话文件，那些**只存 ts/role/text**，`
          + '没有群号也没有"群还是私聊" —— 所以谁要是问"某个老会话是在哪儿说的"，只能猜，而且**补不回来**。');
        const unknownSpeakers = spRows.filter(([, v]) => !v?.scope).length;
        if (unknownSpeakers) lines.push(`  · 有 ${unknownSpeakers} 条说话人记录没有场景字段 —— 它们来自更早的版本。`);
        lines.push('');

        // ── 附加：按场合列人
        if (detail === 'people' && agg.length) {
          lines.push('■ 按场合列人（事实③的子集）');
          for (const a of agg) {
            const key = (a.scope ?? '?') + '|' + (a.peerId ?? '?');
            const who = [...(peopleByPeer.get(key) ?? [])];
            const where = sceneLabel(scenes, a.scope, a.peerId);
            lines.push(`  · ${where}：${who.length ? who.join('、') : '（没有记到名字）'}`);
          }
          lines.push('');
        }

        // ── 给"我是谁"补一句：本轮的场合（工具层拿得到）
        try {
          const me = resolveSpeaker ? resolveSpeaker({}) : null;
          if (me?.openid) {
            lines.push(`（本轮跟你说话的是 ${me.name ?? short(me.openid)}；`
              + `这条信息来自本轮说话人解析，不是历史统计。）`);
          }
        } catch { /* ignore */ }

        return { text: lines.join('\n') };
      } catch (err) {
        return { text: `（查场合失败：${err?.message ?? err}）` };
      }
    },
  });

  logger?.info?.('qqbot_where 工具已注册（场合总览：事实与推断分开）');
  return true;
}
