/**
 * alarms.js —— 闹钟工具（**在 QQ 里直接用嘴设**）
 *
 * ════════════════════════════════════════════════════════════════
 * 它和谁配合
 * ════════════════════════════════════════════════════════════════
 *
 * 真正"到点叫醒"的是服务器上的 `~/qqbot-alarm.py` + systemd timer
 * （每 5 分钟跑一次，读 `~/qqbot/data/alarms.json`，用人格 + DeepSeek 生成一句话，
 *   再用 QQ 官方 API 主动推送）。
 *
 * 这一层只干一件事：**让饲主不用经过主 agent 就能加/删闹钟** ——
 * 他在 QQ 里说「每天 8 点叫我起床」，模型调这个工具把条目写进同一个 alarms.json。
 *
 * ── 群目标（2026-10-07 加，T-008 的"群提醒"）──────────────────
 * `target` 字段决定这条闹钟**响在哪里**：
 *   · 缺省 / `{scope:'c2c'}`        → 推到超管私聊（老条目就是这个，完全向后兼容）
 *   · `{scope:'group', peerId:'…'}` → 推到那个群
 * 在**群里**设的闹钟，目标**自动就是当前这个群**（零参数，模型不用猜群号）。
 * 在**私聊**里设群提醒，要先 `action:'groups'` 列群拿序号，再用 `group:'2'` 指定。
 *
 * ⚠️ **只有超管能用**（默认）：闹钟是主动外发消息（还花 API 额度），
 * 让陌生人能设 = 群能被远程刷屏。配置 `allowMemberGroupAlarms: true` 可放开
 * 「群成员只能给**本群**设」，但因为内容是模型生成的 ⇒ 等于开了个"陌生人借机器人向群里广播"
 * 的口子，**默认关着**。
 *
 * ⚠️ **两边都会写这个文件**（脚本写 `lastFired`、工具写条目）——
 * 低频场景，冲突概率低；真撞上最多丢一次"今天已发过"的标记（结果是同一天重发一次）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const ALARM_TOOL_NAME = 'qqbot_alarm';

/** 每个群最多几条群闹钟（防刷屏；只对"群目标"计数，私聊闹钟不受影响） */
export const MAX_PER_GROUP = 5;
/** 全局上限（沿用原值） */
export const MAX_TOTAL = 20;

export function alarmsPath(cfg) {
  return cfg.alarmFile || join(cfg.dataDir, 'alarms.json');
}

export function groupsPath(cfg) {
  return cfg.groupsFile || join(cfg.dataDir, 'groups.json');
}

export async function loadAlarms(cfg, logger) {
  const file = alarmsPath(cfg);
  try {
    if (!existsSync(file)) return [];
    const raw = JSON.parse(await readFile(file, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch (err) {
    logger?.warn?.(`读 alarms.json 失败（当作空表）: ${err?.message ?? err}`);
    return [];
  }
}

export async function saveAlarms(cfg, alarms, logger) {
  const file = alarmsPath(cfg);
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(alarms, null, 2), 'utf8');
    return true;
  } catch (err) {
    logger?.warn?.(`写 alarms.json 失败: ${err?.message ?? err}`);
    return false;
  }
}

/**
 * 群登记表（适配器入站时写的 `data/groups.json`）—— 只用来给"私聊里指定群"提供序号。
 * 按 `lastSeen` 倒序（最近活跃的排前面，序号更稳）。
 */
export function loadGroups(cfg) {
  try {
    const file = groupsPath(cfg);
    if (!existsSync(file)) return [];
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') return [];
    return Object.values(raw)
      .filter((g) => g && g.openid)
      .sort((a, b) => {
        const ta = a.lastSeen ? Date.parse(a.lastSeen) : 0;
        const tb = b.lastSeen ? Date.parse(b.lastSeen) : 0;
        return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
      });
  } catch {
    return [];
  }
}

export function shortId(id) {
  return String(id ?? '').slice(0, 8);
}

/** 这条闹钟响在哪 —— 给 list 显示用 */
export function describeTarget(a) {
  const t = a?.target;
  if (!t || String(t.scope ?? '').toLowerCase() !== 'group' || !t.peerId) return '私聊';
  return `群 ${shortId(t.peerId)}`;
}

/** 归一 target：认不出来一律当私聊（保守 —— 宁可发给他，也别发错群） */
export function normalizeTarget(input) {
  if (!input || typeof input !== 'object') return null;
  const scope = String(input.scope ?? '').toLowerCase();
  if (scope === 'group' && input.peerId) return { scope: 'group', peerId: String(input.peerId) };
  return null;
}

/** "8:00" / "08:00" / "8点" / "8点半" → "08:00"（认不出来返回 null） */
export function parseHHMM(input) {
  const s = String(input ?? '').trim();
  let m = /^(\d{1,2})\s*[:：]\s*(\d{1,2})$/.exec(s);
  if (!m) m = /^(\d{1,2})\s*点\s*(半)?$/.exec(s);
  if (!m) m = /^(\d{1,2})\s*点\s*(\d{1,2})\s*分?$/.exec(s);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  let mi = m[2] === '半' ? 30 : parseInt(m[2] ?? '0', 10);
  if (!Number.isFinite(mi)) mi = 0;
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
}

const WEEK_ALIAS = {
  mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6,
  '一': 0, '二': 1, '三': 2, '四': 3, '五': 4, '六': 5, '日': 6, '天': 6,
};
const WEEK_NAME = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const WEEK_CN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/**
 * 解析 repeat（T-021 定期提醒）。返回 `{kind:'once'} | {kind:'daily'} | {kind:'weekly', days:[0..6]}`。
 *
 * 接受：`once` / `daily`（每天）/ `weekday`（周一到周五）/ `weekend`（周六日）
 *      / `mon,wed,fri` / `周一,周三` / `一三五`（中文单字连写）
 * ⚠️ 认不出来就**当一次性的**（保守：宁可只响一次，也不要莫名其妙天天响）。
 */
export function parseRepeat(input) {
  const raw = String(input ?? '').trim().toLowerCase();
  if (!raw) return { kind: 'once' };
  if (raw === 'once' || raw.includes('一次') || raw.includes('只')) return { kind: 'once' };
  if (raw === 'daily' || raw.includes('每天') || raw.includes('天天') || raw === '每日') return { kind: 'daily' };
  if (raw === 'weekday' || raw.includes('工作日')) return { kind: 'weekly', days: [0, 1, 2, 3, 4] };
  if (raw === 'weekend' || raw.includes('周末')) return { kind: 'weekly', days: [5, 6] };
  // 逐个 token 找星期
  const days = new Set();
  for (const tok of raw.split(/[,，、\s/|]+/)) {
    if (!tok) continue;
    const eng = tok.replace(/^周|^星期/, '');
    if (WEEK_ALIAS[eng] !== undefined) { days.add(WEEK_ALIAS[eng]); continue; }
    // 中文单字连写：一三五
    const cn = /^[一二三四五六日天]+$/.test(eng) ? eng.split('') : [];
    for (const c of cn) if (WEEK_ALIAS[c] !== undefined) days.add(WEEK_ALIAS[c]);
  }
  if (days.size) return { kind: 'weekly', days: [...days].sort((a, b) => a - b) };
  return { kind: 'once' };
}

/** 人话描述 repeat（回给模型看，也是 list 里显示的） */
export function describeRepeat(a) {
  const r = a.repeat ?? a.repeatKind ?? 'once';
  if (r === 'daily') return '每天';
  if (r === 'once' || !r) return '只一次';
  const days = Array.isArray(r) ? r : parseRepeat(r).days ?? [];
  if (!days.length) return '只一次';
  if (days.length === 7) return '每天';
  if (days.join(',') === '0,1,2,3,4') return '工作日';
  if (days.join(',') === '5,6') return '周末';
  return days.map((d) => WEEK_CN[d]).join('、');
}

export function describeAlarm(a, i) {
  const on = a.enabled === false ? '（已停用）' : '';
  const last = a.lastFired ? `，上次 ${a.lastFired}` : '';
  let rep = '';
  try { rep = `${describeRepeat(a)} · `; } catch { rep = ''; }
  const where = describeTarget(a);
  return `${i + 1}. [→ ${where}] ${rep}${a.time}${on} —— ${a.prompt || a.text || '(没写内容)'}${last}`;
}

/** 某人能不能动这条闹钟 —— 超管随便动；群成员只能动**本群**的（开了开关时） */
export function canTouch(a, { isAdmin, groupId }) {
  if (isAdmin) return true;
  const t = normalizeTarget(a?.target);
  return Boolean(t && groupId && t.peerId === groupId);
}

const ALARM_DESC =
  'Super-admin only. Manages ALARMS that proactively send a message at a given time. '
  + 'A message can fire into the OWNER\'S PRIVATE CHAT (default) or INTO A GROUP. '
  + 'Use when he says things like "每天8点叫我起床" / "周三周五提醒我交作业" / "明天7点半提醒我" / '
  + '"把8点那个闹钟删了" / "列一下闹钟" / "8点提醒这个群开黑" / "每天中午提醒群里吃饭". '
  + 'HOW TO PICK THE TARGET: if the request comes FROM A GROUP, the alarm fires into THAT group '
  + 'automatically — just call add, do NOT ask for a group id. If you are in a private chat and he wants '
  + 'a group alarm, call action:"groups" first, then pass group:"<row number>". '
  + 'Times are server-local (CST). '
  + 'IMPORTANT: pass repeat whenever the request is recurring ("每天" / "每周三" / "周一到周五" / "周末"); '
  + 'omit it (or pass "once") for a one-off — a one-off disables itself after firing. '
  + 'If he says something like "3号提醒我交作业" with no repeat, it is a one-off: set repeat=once.';

export function registerAlarmTool(ctx, cfg, logger, state, hooks = {}) {
  const tools = ctx.get('tools');
  if (!tools?.register) {
    logger?.warn?.('拿不到 tools 服务，闹钟工具未注册');
    return false;
  }
  const st = state ?? {};
  const resolveSpeaker = typeof hooks.resolveSpeaker === 'function' ? hooks.resolveSpeaker : null;
  const allowMemberGroup = cfg.allowMemberGroupAlarms === true;

  tools.register({
    name: ALARM_TOOL_NAME,
    description: ALARM_DESC,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'list', 'remove', 'enable', 'disable', 'groups'],
          description: 'What to do. "groups" lists known groups with row numbers (needed only when setting a group alarm from a private chat).',
        },
        time: { type: 'string', description: 'For add: when, e.g. "08:00" (24h, server-local).' },
        prompt: {
          type: 'string',
          description: 'For add: what the alarm should be about, in the owner\'s own words. '
            + 'You will be given this later to compose the message — keep it factual, e.g. "叫他起床，问今天有没有早八" '
            + 'or (for a group alarm) "提醒群里今晚八点开黑".',
        },
        repeat: {
          type: 'string',
          description: 'For add: how often. "once" (default), "daily", "mon,wed,fri", "weekday", "weekend". '
            + 'Pass it whenever the request is recurring; omit for a one-off.',
        },
        group: {
          type: 'string',
          description: 'For add, private chat only: the row number from action:"groups", to fire the alarm into that group. '
            + 'Do NOT pass it when the request came from a group — that group is used automatically.',
        },
        index: { type: 'string', description: 'For remove/enable/disable: the row number from list.' },
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
      // 本轮说话人：优先按 exec 解析（多群并发时不会把 A 的指令算到 B 头上），拿不到再退回全局
      let sp = null;
      try { sp = resolveSpeaker?.(exec) ?? null; } catch { sp = null; }
      if (!sp?.openid) sp = st.currentSpeaker ?? null;

      const admins = (cfg.adminOpenIds ?? []).map((s) => String(s).toUpperCase());
      const isAdmin = Boolean(sp?.openid) && admins.includes(String(sp.openid).toUpperCase());
      const scope = String(sp?.scope ?? '').toLowerCase();
      const groupId = scope === 'group' ? (sp?.peerId ? String(sp.peerId) : null) : null;
      const inGroup = Boolean(groupId);

      // 权限闸门：非超管只有在"群里 + 开了开关"时才放行（且只能碰本群条目）
      if (!isAdmin && !(inGroup && allowMemberGroup)) {
        return { text: '（闹钟只有超管能设。）' };
      }

      const log2 = { warn: (m) => logger?.warn?.(m) };
      const action = String(args.action ?? '');
      try {
        const alarms = await loadAlarms(cfg, log2);

        if (action === 'groups') {
          const groups = loadGroups(cfg);
          if (!groups.length) return { text: '（还没有登记过任何群 —— 本鱼只有在群里被 @ 过才知道那个群。）' };
          const rows = groups.map((g, i) => {
            const seen = g.lastSeen ? String(g.lastSeen).slice(0, 10) : '?';
            return `${i + 1}. 群 ${shortId(g.openid)}（最近 ${seen}，${g.msgs ?? 0} 条）`;
          });
          return {
            text: `已知的群：\n${rows.join('\n')}\n`
              + '（在私聊里设群闹钟时说「第 N 个」；在群里直接说就行，不用指定。）',
          };
        }

        if (action === 'list') {
          const mine = isAdmin ? alarms : alarms.filter((a) => canTouch(a, { isAdmin, groupId }));
          if (!mine.length) return { text: '（还没有闹钟）' };
          const rows = mine.map((a) => describeAlarm(a, alarms.indexOf(a)));
          return { text: `当前 ${mine.length} 个闹钟：\n${rows.join('\n')}` };
        }

        if (action === 'add') {
          const t = parseHHMM(args.time);
          if (!t) return { text: `（时间没看懂：${args.time ?? '（没给）'} —— 用 08:00 这种格式，或者"8点"/"8点半"）` };
          const prompt = String(args.prompt ?? '').trim();
          if (!prompt) return { text: '（得说清这个闹钟要提醒什么）' };
          if (alarms.length >= MAX_TOTAL) return { text: `（闹钟太多了（上限 ${MAX_TOTAL} 个），先删几个）` };

          // 目标：群里设 ⇒ 就是本群；私聊里可以用 group:"N" 指定
          let target = inGroup ? { scope: 'group', peerId: groupId } : null;
          if (!inGroup && String(args.group ?? '').trim()) {
            const groups = loadGroups(cfg);
            const gi = parseInt(String(args.group).trim(), 10);
            if (!Number.isFinite(gi) || gi < 1 || gi > groups.length) {
              return { text: `（没有第 ${args.group} 个群 —— 先 action:"groups" 看一下清单）` };
            }
            target = { scope: 'group', peerId: String(groups[gi - 1].openid) };
          }
          if (!isAdmin && target && target.peerId !== groupId) {
            return { text: '（只能给本群设。）' };
          }
          if (target) {
            const sameGroup = alarms.filter((a) => normalizeTarget(a.target)?.peerId === target.peerId).length;
            if (sameGroup >= MAX_PER_GROUP) {
              return { text: `（这个群已经有 ${MAX_PER_GROUP} 个提醒了，先删几个再设。）` };
            }
          }

          const rep = parseRepeat(args.repeat);
          const item = { time: t, prompt, enabled: true };
          if (target) item.target = target;
          if (rep.kind === 'daily') item.repeat = 'daily';
          else if (rep.kind === 'weekly') item.repeat = rep.days;
          else item.repeat = 'once';
          alarms.push(item);
          await saveAlarms(cfg, alarms, log2);
          const when = describeRepeat(item);
          const tail = rep.kind === 'once'
            ? '（响一次就停。要天天响就说"每天"。）'
            : `（${when}都响。要改要删随时说。）`;
          const where = target ? `**发在 ${describeTarget(item)}**` : '**发在你私聊**';
          return { text: `闹钟加好了：**${when} ${t}** ${where} —— ${prompt}\n${tail}` };
        }

        // 下面三个都要按序号找
        const idx = parseInt(String(args.index ?? '').trim(), 10);
        if (!Number.isFinite(idx) || idx < 1 || idx > alarms.length) {
          return { text: '（要指定是哪一个 —— 先让我列一下闹钟，然后说"第 N 个"）' };
        }
        const a = alarms[idx - 1];
        if (!canTouch(a, { isAdmin, groupId })) {
          return { text: '（这条闹钟不在本群，动不了。）' };
        }
        if (action === 'remove') {
          alarms.splice(idx - 1, 1);
          await saveAlarms(cfg, alarms, log2);
          return { text: `删掉了：[→ ${describeTarget(a)}] ${a.time} —— ${a.prompt || a.text || ''}` };
        }
        if (action === 'enable' || action === 'disable') {
          a.enabled = action === 'enable';
          await saveAlarms(cfg, alarms, log2);
          return { text: `${a.time} 那个闹钟（→ ${describeTarget(a)}）${a.enabled ? '开回来了' : '先停用'}了。` };
        }
        return { text: `（不认识的 action：${action}）` };
      } catch (err) {
        logger?.warn?.(`闹钟工具失败: ${err?.message ?? err}`);
        return { text: '（闹钟没改成，看日志）' };
      }
    },
  });

  // ⚠️ 这行的文案是**被 `qqbot-post-upgrade.sh` 的 `tool registered` 检查 grep 的**：
  //    必须含 "<工具名> … 注册成功" 这个形状，否则自检发现不了"闹钟工具掉了"（2026-10-07 补）。
  logger?.info?.(`闹钟工具 ${ALARM_TOOL_NAME} 注册成功`
    + (allowMemberGroup ? '（群成员也可给本群设）' : '（仅超管）'));
  return true;
}
