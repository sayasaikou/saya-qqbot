/**
 * alarms.js —— 闹钟工具（**在 QQ 里直接用嘴设**）
 *
 * ════════════════════════════════════════════════════════════════
 * 它和谁配合
 * ════════════════════════════════════════════════════════════════
 *
 * 真正"到点叫醒"的是服务器上的 `~/qqbot-alarm.py` + systemd timer
 * （每 5 分钟跑一次，读 `~/qqbot/data/alarms.json`，用人格 + DeepSeek 生成一句话，
 *   再用 QQ 官方 API 主动私聊推送）。
 *
 * 这一层只干一件事：**让饲主不用经过主 agent 就能加/删闹钟** ——
 * 他在 QQ 里说「每天 8 点叫我起床」，模型调这个工具把条目写进同一个 alarms.json。
 *
 * ⚠️ **只有超管能用**：闹钟是往**他**私聊推消息的（还花 API 额度），
 * 让陌生人能设 = 他能被人远程刷屏。
 *
 * ⚠️ **两边都会写这个文件**（脚本写 `lastFired`、工具写条目）——
 * 低频场景，冲突概率低；真撞上最多丢一次"今天已发过"的标记（结果是同一天重发一次）。
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const ALARM_TOOL_NAME = 'qqbot_alarm';

export function alarmsPath(cfg) {
  return cfg.alarmFile || join(cfg.dataDir, 'alarms.json');
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

export function describeAlarm(a, i) {
  const on = a.enabled === false ? '（已停用）' : '';
  const last = a.lastFired ? `，上次 ${a.lastFired}` : '';
  return `${i + 1}. ${a.time}${on} —— ${a.prompt || a.text || '(没写内容)'}${last}`;
}

const ALARM_DESC =
  'Super-admin only. Manages the owner\'s ALARMS: at the given time the bot proactively sends '
  + 'him a private message (an alarm clock). Use when he says things like "每天8点叫我起床" / '
  + '"明天7点半提醒我" / "把8点那个闹钟删了" / "列一下闹钟". Times are server-local (CST).';

export function registerAlarmTool(ctx, cfg, logger, state) {
  const tools = ctx.get('tools');
  if (!tools?.register) {
    logger?.warn?.('拿不到 tools 服务，闹钟工具未注册');
    return false;
  }
  const st = state ?? {};

  tools.register({
    name: ALARM_TOOL_NAME,
    description: ALARM_DESC,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'remove', 'enable', 'disable'], description: 'What to do.' },
        time: { type: 'string', description: 'For add: when, e.g. "08:00" (24h, server-local).' },
        prompt: {
          type: 'string',
          description: 'For add: what the alarm should be about, in the owner\'s own words. '
            + 'You will be given this later to compose the message — keep it factual, e.g. "叫他起床，问今天有没有早八".',
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
    async execute(args) {
      const sp = st.currentSpeaker;
      const admins = (cfg.adminOpenIds ?? []).map((s) => String(s).toUpperCase());
      if (!sp?.openid || !admins.includes(String(sp.openid).toUpperCase())) {
        return { text: '（闹钟只有超管能设。）' };
      }
      const log2 = { warn: (m) => logger?.warn?.(m) };
      const action = String(args.action ?? '');
      try {
        const alarms = await loadAlarms(cfg, log2);

        if (action === 'list') {
          return {
            text: alarms.length
              ? `当前 ${alarms.length} 个闹钟：\n` + alarms.map(describeAlarm).join('\n')
              : '（还没有闹钟）',
          };
        }

        if (action === 'add') {
          const t = parseHHMM(args.time);
          if (!t) return { text: `（时间没看懂：${args.time ?? '（没给）'} —— 用 08:00 这种格式，或者"8点"/"8点半"）` };
          const prompt = String(args.prompt ?? '').trim();
          if (!prompt) return { text: '（得说清这个闹钟要提醒什么）' };
          if (alarms.length >= 20) return { text: '（闹钟太多了，先删几个）' };
          alarms.push({ time: t, prompt, enabled: true });
          await saveAlarms(cfg, alarms, log2);
          return {
            text: `闹钟加好了：**${t}** —— ${prompt}\n（到点它会主动私聊你。要改要删随时说。）`,
          };
        }

        // 下面三个都要按序号找
        const idx = parseInt(String(args.index ?? '').trim(), 10);
        if (!Number.isFinite(idx) || idx < 1 || idx > alarms.length) {
          return { text: `（要指定是哪一个 —— 先让我列一下闹钟，然后说"第 N 个"）` };
        }
        const a = alarms[idx - 1];
        if (action === 'remove') {
          alarms.splice(idx - 1, 1);
          await saveAlarms(cfg, alarms, log2);
          return { text: `删掉了：${a.time} —— ${a.prompt || a.text || ''}` };
        }
        if (action === 'enable' || action === 'disable') {
          a.enabled = action === 'enable';
          await saveAlarms(cfg, alarms, log2);
          return { text: `${a.time} 那个闹钟${a.enabled ? '开回来了' : '先停用'}了。` };
        }
        return { text: `（不认识的 action：${action}）` };
      } catch (err) {
        logger?.warn?.(`闹钟工具失败: ${err?.message ?? err}`);
        return { text: '（闹钟没改成，看日志）' };
      }
    },
  });

  logger?.info?.('闹钟层已加载：工具 ' + ALARM_TOOL_NAME);
  return true;
}
