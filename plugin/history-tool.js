/**
 * history-tool —— 群消息**落盘** + 给 agent 一个"翻历史"的口子。
 *
 * ════════════════════════════════════════════════════════════════
 * 为什么要有它（2026-10-06 · 超管实测提出）
 * ════════════════════════════════════════════════════════════════
 *
 * 适配器自带的 `historyBuffer` 是**纯内存的环形缓冲**（MemoryHistoryStore）：
 *   · 只留最近 N 条（我们配的 30）；
 *   · **每次回复后被清空**（clearGroupHistory，避免下次重复组包）；
 *   · 进程一重启就没了。
 * ⇒ 结果就是：**它只能记得"刚刚那一小段"**。
 *   超管实测的原话：「群全量消息 没实现，它没有我在 a 群说话的记忆」——
 *   a 群说的话，在 b 群问它，它不知道；隔一会儿再问，也不知道。
 *
 * 这里补的是**持久层**：把每条进来的用户消息按天追加到 JSONL，
 * 再给 agent 一个 `qqbot_history` 工具去翻。
 *
 * ⚠️ 边界（别搞混）：
 *   · 落盘**不改变**每轮注入的上下文 —— 不会让 token 变多（那才是要防的）；
 *   · 它只让"**被问到时能查**"。想让它主动记得，走共享记忆/关系层那条线。
 *
 * ⚠️ 隐私边界（这条是硬的，别越）：
 *   翻历史只能翻**当前说话人自己**的往来（或者是超管）。
 *   群里别人的闲聊，普通人不许通过这个工具翻出来。
 *   实现上：caller 的身份由注入层每轮刷新的 `resolveSpeaker()` 给出，
 *   与 `sender` 参数不一致时**直接拒绝**（除非是超管）。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const HISTORY_TOOL_NAME = 'qqbot_history';

const DESCRIPTION =
  'Look up earlier chat messages that were persisted to disk. '
  + 'The in-memory buffer only keeps the last ~30 messages of ONE group and is cleared after each reply, '
  + 'so use this when you need something older, or from another group/session. '
  + 'Returns matching messages oldest-first. '
  + 'Privacy: you may only read the CURRENT speaker\'s own messages (an admin may read anyone\'s).';

/** 每天一个文件，保留最近 N 天（老的自动不读、也不删 —— 删它没有收益，占不了多少） */
const KEEP_DAYS = 14;

function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function ensureDir(d) {
  try {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 把**每一条**进来的用户消息追加到 `<dataDir>/msgs/<YYYY-MM-DD>.jsonl`。
 *
 * ⚠️ 绝不能抛：落盘失败不能影响对话（这是本插件的头号设计规矩）。
 * 返回 true 表示真写进去了（验收判据用得上）。
 */
export function logIncomingMessage(cfg, entry) {
  try {
    const dir = join(cfg.dataDir, 'msgs');
    if (!ensureDir(dir)) return false;
    const file = join(dir, `${dayKey()}.jsonl`);
    appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 最近 KEEP_DAYS 天的日志文件（新的在前） */
function recentFiles(cfg) {
  const dir = join(cfg.dataDir, 'msgs');
  try {
    if (!existsSync(dir)) return [];
    const names = readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort().reverse();
    return names.slice(0, KEEP_DAYS).map((n) => join(dir, n));
  } catch {
    return [];
  }
}

function tailLines(file, maxLines) {
  try {
    const st = statSync(file);
    // 简单起见：文件不大（一天几千条 × 几百字节 ≈ 几 MB）就整读，再取尾。
    if (st.size > 8 * 1024 * 1024) return [];
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

/**
 * 查历史。
 * @returns {{items: Array, scanned: number, note?: string}}
 */
export function searchHistory(cfg, opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit ?? 30), 1), 200);
  const needle = (opts.text ?? '').trim();
  const sender = (opts.sender ?? '').trim().toUpperCase();
  const scope = (opts.scope ?? '').trim();
  const peerId = (opts.peerId ?? '').trim().toUpperCase();
  const sinceTs = opts.since ? Date.parse(String(opts.since)) : NaN;

  const out = [];
  let scanned = 0;
  // 从旧到新扫，最后取"最新的 limit 条"
  for (const f of recentFiles(cfg).reverse()) {
    for (const line of tailLines(f, 5000)) {
      scanned++;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (sender && String(e.openid ?? '').toUpperCase() !== sender) continue;
      if (scope && String(e.scope ?? '') !== scope) continue;
      if (peerId && String(e.peerId ?? '').toUpperCase() !== peerId) continue;
      if (Number.isFinite(sinceTs) && Number(e.at ?? 0) < sinceTs) continue;
      if (needle && !String(e.text ?? '').includes(needle)) continue;
      out.push(e);
    }
  }
  return { items: out.slice(-limit), scanned, note: `扫描 ${scanned} 条，命中 ${out.length} 条` };
}

export function registerHistoryTool(ctx, cfg, logger, deps = {}) {
  const tools = (() => { try { return ctx.get('tools'); } catch { return undefined; } })();
  if (!tools?.register) {
    logger?.warn?.('拿不到 tools 服务，qqbot_history 未注册');
    return false;
  }
  const resolveSpeaker = deps.resolveSpeaker;

  tools.register({
    name: HISTORY_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        sender: {
          type: 'string',
          description: 'Optional openid to filter by. Defaults to the CURRENT speaker (and you may not read others unless you are an admin).',
        },
        scope: { type: 'string', description: 'Optional: "group" or "c2c".' },
        peerId: { type: 'string', description: 'Optional group openid (only meaningful with scope=group).' },
        text: { type: 'string', description: 'Optional substring to search for.' },
        since: { type: 'string', description: 'Optional ISO time; only messages at/after it.' },
        limit: { type: 'number', description: 'How many messages to return (1-200, default 30).' },
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
      // ⚠️ 少了 render 会在注册时就报错（实测：`tool "qqbot_history" must declare output
      //    { schema, render, presentationMeta? }` —— 只在服务日志里，node --check 查不出）。
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args = {}, exec) {
      try {
        const admins = new Set(
          (cfg.adminOpenIds ?? []).map((s) => String(s).toUpperCase()),
        );
        const me = (() => {
          try { return resolveSpeaker ? resolveSpeaker(exec) : null; } catch { return null; }
        })();
        const myId = String(me?.openid ?? '').toUpperCase();
        const isAdmin = myId && admins.has(myId);

        let sender = String(args.sender ?? '').trim().toUpperCase();
        if (!sender) sender = myId;
        if (!sender) {
          return { text: '取不到当前说话人，也没给 sender —— 不查（宁可不查，也不翻错人的记录）。' };
        }
        if (!isAdmin && sender !== myId) {
          return { text: '只能查**当前说话人自己**的往来（隐私边界）。要查别人得是超管。' };
        }

        // 超管不传 sender 时，默认查全部（他常问"刚才群里说了啥"）
        const filterSender = (!args.sender && isAdmin) ? '' : sender;

        const { items, scanned } = searchHistory(cfg, {
          sender: filterSender,
          scope: args.scope,
          peerId: args.peerId,
          text: args.text,
          since: args.since,
          limit: args.limit,
        });

        if (!items.length) {
          return { text: `没有查到（${sender ? 'sender=' + filterSender.slice(0, 8) + '… ' : ''}共扫描 ${scanned} 条落盘消息）。`
            + '可能是：那段对话没被落盘（插件刚上线）、或者时间/关键词不对。' };
        }
        const lines = items.map((e) => {
          const who = e.name ?? String(e.openid ?? '').slice(0, 8);
          const where = e.scope === 'group' ? '群' : (e.scope === 'c2c' ? '私聊' : '?');
          const t = new Date(Number(e.at ?? 0)).toISOString().replace('T', ' ').slice(0, 19);
          return `[${t}] (${where}) ${who}: ${e.text}`;
        });
        return {
          text: `按时间从旧到新，共 ${items.length} 条（${scanned} 条里筛出来的）：\n` + lines.join('\n'),
        };
      } catch (err) {
        return { text: `查历史失败：${err?.message ?? err}` };
      }
    },
  });
  return true;
}
