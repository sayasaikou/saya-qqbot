/**
 * audit.js —— 工具调用的**审计留痕**（对外开放前的必需品，2026-10-06 立）。
 *
 * ════════════════════════════════════════════════════════════════
 * 为什么要有它
 * ════════════════════════════════════════════════════════════════
 *
 * 现在的日志记的是"机器人说了什么"，不是"**谁**让它去干了什么"。
 * 一旦它进了更多群（对外开放），出问题时第一个要回答的就是这个问题：
 *
 *   · 谁在什么时候让它画了图？（生图要花钱）
 *   · 谁在什么时候改了别人的好感度/身份？（管理动作）
 *   · 谁在什么时候翻了超管的资料？（只读窗口也有边界）
 *
 * 没有这份记录，事后只能翻聊天记录猜 —— 而群消息**默认不落盘**（只有跟它有关的才落）。
 *
 * ⚠️ 三条纪律
 *   ① **只记"谁 + 何时 + 做了什么 + 结果码"**，不记正文 —— 工具参数里可能有
 *      别人的昵称、链接、甚至超管的私人内容；审计不等于把对话再抄一份。
 *   ② **敏感工具名之外的参数一概不落**（下面 `ARGS_KEEP` 是白名单，别的只留键名）。
 *   ③ **写不进去不能挡对话**（本插件一贯口径），失败只记一行 warn。
 *
 * 落地：`<dataDir>/audit/<YYYY-MM-DD>.jsonl`，保留 30 天（读的时候按天截断）。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** 这些参数值允许落盘（其余只记键名 —— 避免把别人的话抄进审计里） */
const ARGS_KEEP = new Set(['action', 'kind', 'variant', 'scope', 'target', 'id', 'limit']);

/** 保留天数（读侧截断；文件本身不删，占不了多少地方） */
export const AUDIT_KEEP_DAYS = 30;

export function auditDir(cfg) {
  return join(cfg.dataDir, 'audit');
}

/**
 * 记一条。
 * @param {object} cfg
 * @param {object} entry { tool, actor, actorName, args, ok, note }
 */
export function writeAudit(cfg, entry) {
  try {
    const d = auditDir(cfg);
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    const day = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const name = `${day.getFullYear()}-${p(day.getMonth() + 1)}-${p(day.getDate())}.jsonl`;

    // 参数只留白名单里的值 + 其余键名
    let argSummary = null;
    if (entry.args && typeof entry.args === 'object') {
      const kept = {};
      const keys = [];
      for (const [k, v] of Object.entries(entry.args)) {
        if (ARGS_KEEP.has(k)) {
          kept[k] = typeof v === 'string' ? String(v).slice(0, 60) : v;
        } else {
          keys.push(k);
          if (typeof v === 'string') kept[`${k}__len`] = v.length;   // 长度可用于排查，不算正文
        }
      }
      argSummary = { kept, otherKeys: keys };
    }

    const rec = {
      at: new Date().toISOString(),
      tool: String(entry.tool ?? '?'),
      actor: entry.actor ? String(entry.actor).toUpperCase() : null,
      actorName: entry.actorName ?? null,
      ok: entry.ok !== false,
      args: argSummary,
      ...(entry.note ? { note: String(entry.note).slice(0, 200) } : {}),
    };
    appendFileSync(join(d, name), JSON.stringify(rec) + '\n', 'utf8');
    return true;
  } catch {
    return false;   // 审计写不进去不能挡对话
  }
}

/** 读最近 N 天的审计（新的在前），可按 actor / tool 过滤 */
export function readAudit(cfg, { days = 3, actor = '', tool = '', limit = 200 } = {}) {
  const dir = auditDir(cfg);
  const out = [];
  try {
    if (!existsSync(dir)) return { items: [], files: 0 };
    const files = readdirSync(dir)
      .filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
      .sort()
      .reverse()
      .slice(0, Math.min(Math.max(Number(days) || 3, 1), AUDIT_KEEP_DAYS));
    let scanned = 0;
    for (const f of files) {
      let lines = [];
      try { lines = readFileSync(join(dir, f), 'utf8').split('\n'); } catch { continue; }
      for (const line of lines.reverse()) {          // 新的在前
        if (!line) continue;
        scanned++;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (actor && String(e.actor ?? '') !== String(actor).toUpperCase()) continue;
        if (tool && String(e.tool ?? '') !== tool) continue;
        out.push(e);
        if (out.length >= limit) break;
      }
      if (out.length >= limit) break;
    }
    return { items: out, files: files.length, scanned };
  } catch {
    return { items: [], files: 0 };
  }
}
