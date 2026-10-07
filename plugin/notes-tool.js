/**
 * notes-tool —— `qqbot_notes`：读超管自己的资料（**只读窗口**）。
 *
 * ════════════════════════════════════════════════════════════════
 * 这是什么（2026-10-06 超管点的 ②）
 * ════════════════════════════════════════════════════════════════
 *
 * 超管的真实处境：人常在教室/实验室，**电脑不在手边**，想查的是**自己的**东西
 * （排障记录、备考计划、选购对比、项目文档），而不是网上的通用答案。
 *
 * 所以本机有一个同步器（`sync-notes-to-qqbot.ps1`）**每天**把四类目录里的
 * **.md / .txt** 推到云端 `~/notes/`，这个工具负责读。
 *
 * ⚠️⚠️ 三条硬边界（写死，别松）
 *
 *   ① **只读**。工具只做 list / search / read，**没有任何写入/删除能力**。
 *      云端的 `~/notes/` 也被同步器 `chmod -R a-w` 钉成只读了。
 *   ② **只读白名单内的文本**。`notesRoot` 必须落在 `allowPrefixes` 里；
 *      后缀只认 `allowExts`（默认 .md/.txt）。
 *      **路径穿越**（`..`）与**符号链接**一律拒。
 *   ③ **敏感名硬拦**。即便某个文件被误同步上来，文件名命中 `denyPatterns`
 *      （key / token / secret / password / 密码 / 私人 …）也**一律不读**。
 *
 * 另：读文件**默认截断**（默认 6000 字符，最多 20000）—— 一份文档几万字，
 * 全塞进上下文既贵又会把本轮对话挤掉。要更多就分次读（`offset`）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';

export const NOTES_TOOL_NAME = 'qqbot_notes';

const DESCRIPTION =
  'Read the owner\'s own documents (troubleshooting notes, study plans, purchase shortlists, project docs). '
  + 'These are mirrored from his workstation daily and are READ-ONLY. '
  + 'Use this when a question is about HIS own setup/history rather than general knowledge. '
  + 'Actions: "list" (what is available), "search" (find files, optionally by text), "read" (one file, truncated). '
  + 'Paths are relative to the notes root, e.g. "排障记录/蓝屏诊断-20260918.md". '
  + 'PRIVACY: private documents are NOT readable in a group chat at all — in a group this tool only sees '
  + 'the public subset. If it refuses, tell the owner to ask in private instead of working around it.';

const DEFAULT_PREFIXES = ['排障记录', '学习资料', '选购', 'QQ机器人'];
const DEFAULT_EXTS = ['.md', '.txt'];
const DENY = /(?:^|[\/\\._-])(key|token|secret|password|passwd|credential|credentials|env)(?:[\/\\._-]|$)|密码|密钥|凭据|私人/i;

const MAX_READ_DEFAULT = 6000;
const MAX_READ_CAP = 20000;

/**
 * 这份资料是公开的还是私密的（T-020 · 与人格里的「隐私边界」配套）。
 *
 * 划法：顶层目录 公开\ ⇒ 公开；私密\ ⇒ 私密；**其余一律默认私密**。
 * 保守优先：多挡一个的代价是"换个场合再问"，放过去一个的代价是**发出去就收不回**。
 */
function isPrivatePath(rel, ctx) {
  const parts = String(rel ?? '').split(/[/\\]+/).filter(Boolean);
  if (!parts.length) return true;              // 说不清就是私密
  // 残留的旧式标记目录（万一有人手工放了个 公开/ 或 私密/ 子目录）
  if (parts[0] === '公开') return false;
  if (parts[0] === '私密') return true;
  // 真正的判据：**这份文件落在哪个根里**
  const rel2 = parts.join('/');
  if (ctx?.publicRoot && existsSync(join(ctx.publicRoot, rel2))) return false;
  if (ctx?.privateRoot && existsSync(join(ctx.privateRoot, rel2))) return true;
  return true;                                  // 两个根都没有 ⇒ 保守当私密
}

/** 场合：'c2c' = 私聊、'group' = 群。取不到当群处理（保守）。 */
function isGroupScene(sp) {
  return String(sp?.scope ?? '').toLowerCase() !== 'c2c';
}

function safeResolve(root, rel, prefixes, exts) {
  if (!rel || typeof rel !== 'string') return { err: '（没给路径）' };
  if (isAbsolute(rel)) return { err: '（只接受相对路径）' };
  const cleaned = normalize(rel).replace(/^[/\\]+/, '');
  if (cleaned.includes('..')) return { err: '（路径里不许有 ..）' };
  const parts = cleaned.split(/[/\\]+/);
  if (parts.length < 2) return { err: '（要给"目录/文件名"，比如 排障记录/xxx.md）' };
  if (!prefixes.includes(parts[0])) {
    return { err: `（只能读这几类：${prefixes.join('、')}）` };
  }
  if (DENY.test(cleaned)) return { err: '（这个文件名看着像敏感内容，按规矩不读）' };
  const ext = cleaned.slice(cleaned.lastIndexOf('.')).toLowerCase();
  if (!exts.includes(ext)) return { err: `（只读 ${exts.join(' / ')}）` };
  const full = join(root, cleaned);
  const relCheck = relative(root, full);
  if (relCheck.startsWith('..') || relCheck.split(sep).includes('..')) return { err: '（越界了）' };
  if (!existsSync(full)) return { err: `（没有这个文件：${cleaned}）` };
  return { full, rel: cleaned };
}

function walk(root, prefixes, exts, depth = 0) {
  const out = [];
  if (depth > 4) return out;
  let entries = [];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(root, e.name);
    if (e.isDirectory()) {
      if (depth === 0) {
        if (!prefixes.includes(e.name)) continue;
        out.push(...walk(full, prefixes, exts, depth + 1));
      } else {
        out.push(...walk(full, prefixes, exts, depth + 1));
      }
      continue;
    }
    if (!e.isFile()) continue;              // 符号链接等一律跳过
    const lower = e.name.toLowerCase();
    if (!exts.some((x) => lower.endsWith(x))) continue;
    if (DENY.test(full)) continue;
    let size = 0;
    try { size = statSync(full).size; } catch { continue; }
    out.push({ full, size, Root: root });
  }
  return out;
}

export function registerNotesTool(ctx, cfg, logger, deps = {}) {
  const resolveSpeaker = deps.resolveSpeaker;
  const tools = (() => { try { return ctx.get('tools'); } catch { return undefined; } })();
  if (!tools?.register) {
    logger?.warn?.('拿不到 tools 服务，qqbot_notes 未注册');
    return false;
  }
  const rootPublic = String(cfg.notesRoot ?? '').trim();
  const rootPrivate = String(cfg.notesPrivateRoot ?? '').trim();
  // ⚠️ 这里**故意不判断目录是否存在**（2026-10-06 踩过）：同步器可能还没跑过第一次，
  //    而插件注册发生在很久以前 —— 那时判一次"不存在"，就**永久**排除了这个根。
  //    改成每次 execute 时再判（见下面 roots 的构造）。
  const wantPublic = !!rootPublic;
  const wantPrivate = !!rootPrivate;
  if (!wantPublic && !wantPrivate) {
    logger?.info?.('qqbot_notes 未注册（两个根都没配）');
    return false;
  }
  const prefixes = Array.isArray(cfg.notesPrefixes) && cfg.notesPrefixes.length
    ? cfg.notesPrefixes.map(String) : DEFAULT_PREFIXES;
  const exts = Array.isArray(cfg.notesExts) && cfg.notesExts.length
    ? cfg.notesExts.map((s) => String(s).toLowerCase()) : DEFAULT_EXTS;

  tools.register({
    name: NOTES_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'search', 'read'], description: 'What to do.' },
        path: { type: 'string', description: 'For read: relative path like "排障记录/xxx.md".' },
        contains: { type: 'string', description: 'For search: only files whose text contains this substring.' },
        limit: { type: 'number', description: 'For list/search: how many entries (default 50).' },
        offset: { type: 'number', description: 'For read: start at this character (default 0).' },
        maxChars: { type: 'number', description: 'For read: how many characters (default 6000, cap 20000).' },
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
        const action = String(args.action ?? '').trim();

        // 场合：私聊 vs 群（取不到说话人 ⇒ 当群处理，保守）
        const sp = (() => { try { return resolveSpeaker?.(exec) ?? null; } catch { return null; } })();
        const inGroup = isGroupScene(sp);

        // 根的选择（T-020）：
        //   群聊 —— **只给公开根**（私密档连列都不列）
        //   私聊 —— 两个根都给
        // ⚠️ **每次调用**重新判存在（不能用注册时算好的值 —— 同步可能还没跑过第一次）
        const roots = [];
        if (wantPublic && existsSync(rootPublic)) roots.push(rootPublic);
        if (wantPrivate && !inGroup && existsSync(rootPrivate)) roots.push(rootPrivate);
        if (!roots.length) {
          return { text: inGroup
            ? '（这个场合没有公开资料可读 —— 私密档只在私聊里能读。）'
            : '（还没有资料同步上来。）' };
        }
        // 私聊里顺便数一下私密档，好在末尾提醒"还有更私人的那些"
        const privateNames = (() => {
          if (inGroup || !wantPrivate || !existsSync(rootPrivate)) return [];
          try {
            return walk(rootPrivate, prefixes, exts).map((f) => relative(rootPrivate, f.full).split(sep).join('/'));
          } catch { return []; }
        })();

        if (action === 'list') {
          const limit = Math.min(Math.max(Number(args.limit ?? 50), 1), 200);
          let files = roots.flatMap((r) => walk(r, prefixes, exts)).sort((a, b) => a.full.localeCompare(b.full));
          if (inGroup) {
            // 群聊里只留"来自公开根"的（根的归属是同步器定的，最准）
            files = files.filter((f) => String(f.Root) === String(rootPublic));
          }
          if (!files.length) return { text: '（这一层还没有资料 —— 可能还没同步上来）' };
          const lines = files.slice(0, limit).map((f) => {
            const rel = relative(f.Root, f.full).split(sep).join("/");
            return `· ${rel}（${Math.round(f.size / 1024)} KB）`;
          });
          const privNote = privateNames.length
            ? `\n\n⚠️ 另外**私聊里**还能读 ${privateNames.length} 份更私人的（${privateNames.map((n) => n.split('/').pop()).join('、')}）`
              + ' —— 那些**群里一个字都不许提**，要用只能让他私聊问。'
            : '';
          return {
            text: `超管的资料共 ${files.length} 份（只读，每天从他那台机器同步过来）：\n` + lines.join('\n') + privNote
              + (files.length > limit ? `\n…还有 ${files.length - limit} 份（调大 limit 看更多）` : '')
              + '\n\n（读某一份用 action=read + path；找不到就 search。）',
          };
        }

        if (action === 'search') {
          const limit = Math.min(Math.max(Number(args.limit ?? 50), 1), 200);
          const needle = String(args.contains ?? '').trim();
          let files = roots.flatMap((r) => walk(r, prefixes, exts)).sort((a, b) => a.full.localeCompare(b.full));
          if (inGroup) {
            // 群聊里只留"来自公开根"的（同上）
            files = files.filter((f) => String(f.Root) === String(rootPublic));
          }
          const hits = [];
          for (const f of files) {
            const rel = relative(f.Root, f.full).split(sep).join("/");
            if (!needle) { hits.push(`· ${rel}`); continue; }
            let text = '';
            try { text = readFileSync(f.full, 'utf8'); } catch { continue; }
            if (text.includes(needle)) {
              // 顺带给出命中那一行的上下文（比只给文件名有用得多）
              const i = text.indexOf(needle);
              const line = text.slice(Math.max(0, text.lastIndexOf('\n', i) + 1), text.indexOf('\n', i) === -1 ? undefined : text.indexOf('\n', i)).trim();
              hits.push(`· ${rel}\n    ↳ ${line.slice(0, 160)}`);
            }
            if (hits.length >= limit) break;
          }
          if (!hits.length) return { text: `（没有文件包含「${needle}」）` };
          return { text: `命中 ${hits.length} 份：\n` + hits.join('\n'), };
        }

        if (action === 'read') {
          let r = { err: null };
          let rRoot = null;
          for (const rr of roots) {
            const got = safeResolve(rr, args.path, prefixes, exts);
            if (!got.err) { r = got; rRoot = rr; break; }
            r = got;
          }
          if (r.err) return { text: r.err };
          // ⚠️ 硬拦（人格里那条「隐私边界」的代码侧配套）：**来自私密根的东西，群里不许读**。
          //    判据用"它来自哪个根"，不用路径（路径里没有标记 —— 同步器剥掉了）。
          if (inGroup && String(rRoot) === String(rootPrivate)) {
            return { text: '（这份是**私密资料**，群里不读。让超管**私聊**问本鱼 —— '
              + '或者他愿意的话，把要用的那一段自己贴出来。）' };
          }
          const maxChars = Math.min(Math.max(Number(args.maxChars ?? MAX_READ_DEFAULT), 1), MAX_READ_CAP);
          const offset = Math.max(Number(args.offset ?? 0), 0);
          let text = '';
          try { text = readFileSync(r.full, 'utf8'); } catch (err) {
            return { text: `（读不了：${err?.message ?? err}）` };
          }
          const total = text.length;
          const slice = text.slice(offset, offset + maxChars);
          const more = offset + slice.length < total;
          return {
            text: `【${r.rel}】（共 ${total} 字符，本次从 ${offset} 起取 ${slice.length}）\n`
              + '————————————————————————\n' + slice
              + (more ? `\n————————————————————————\n（还有 ${total - offset - slice.length} 字符没读 —— 要接着看就把 offset 设成 ${offset + slice.length}）` : '\n————————————————————————\n（读完了）'),
          };
        }

        return { text: `（不认识的 action：${action}；只有 list / search / read）` };
      } catch (err) {
        return { text: `（读资料失败：${err?.message ?? err}）` };
      }
    },
  });

  logger?.info?.(`qqbot_notes 工具已注册（只读 · 白名单 ${prefixes.join('/')}`
    + ` · 公开根 ${rootPublic || '（无）'} · 私密根 ${rootPrivate || '（无）'}）`);
  return true;
}
