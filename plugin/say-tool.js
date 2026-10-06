/**
 * say-tool.js —— 让「它自己」能主动发一条**文字**（T-002，2026-10-06）
 *
 * ════════════════════════════════════════════════════════════════
 * 为什么需要它
 * ════════════════════════════════════════════════════════════════
 *
 * 在这之前，它出站只有两件事：
 *   ① 跟着当前那条消息回文字（回哪儿由消息决定，它挑不了）；
 *   ② `qqbot_send_file`（能带 target 发文件，但发不了纯文字）。
 * ⇒ 饲主想「单独在私聊收到它的话」做不到 —— 不是它不愿意。
 *
 * 实现放在**插件**里而不是改适配器，理由：插件是本仓的代码（可版本化、可自测），
 * 而适配器那份是第三方包的编译产物，改一次就多一个"升级要重打"的补丁。
 * 发法沿用 `~/qqbot-alarm.py` 与 `~/qqbot-announce.py` 已经实测跑通的那套 HTTP。
 *
 * ════════════════════════════════════════════════════════════════
 * 三条硬纪律
 * ════════════════════════════════════════════════════════════════
 *
 * ① **只对超管开放**。主动消息要花钱（走它自己的 key 的那部分不算，但推送本身有频控），
 *    而且放开给陌生人 = 别人能远程让它去骚扰别人。闸门与 `qqbot_alarm` 一致。
 * ② **绝不打印凭据**。appId / secret / access_token 一律不进日志、不进返回值。
 * ③ **群聊大概率发不出去**（实测 `40034105 主动消息失败, 无权限`，见 2026-10-06 的
 *    升级播报记录）。所以群目标**不报错、只如实回报失败原因**，让模型知道换私聊。
 *
 * 默认目标 = **当前这条消息所在的会话**（靠适配器落的 `current-speaker.json` 里的
 * `scope` + `peerId` 反查），所以"回我私聊"这种话不需要模型去背 openid。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SAY_TOOL_NAME = 'qqbot_say';

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const API_BASE = 'https://api.sgroup.qq.com';
/** token 提前 5 分钟过期，避免边界上刚好失效 */
const TOKEN_SKEW_MS = 5 * 60 * 1000;

const DESCRIPTION =
  'Proactively send a TEXT message (not a reply to the current one). '
  + 'Use it when the owner (超管) asks you to message someone, or to say something in a chat '
  + 'that is not the current conversation. Omit `target` to send to the CURRENT conversation. '
  + '⚠️ Group targets are usually rejected by the platform (error 40034105, no permission) — '
  + 'if it fails, tell the owner instead of retrying.';

/** 解析显式 target（"c2c:openid" / "group:openid"），非法返回 undefined */
export function parseTarget(input) {
  if (typeof input !== 'string') return undefined;
  const s = input.trim();
  const idx = s.indexOf(':');
  if (idx <= 0) return undefined;
  const scope = s.slice(0, idx).trim().toLowerCase();
  const targetId = s.slice(idx + 1).trim();
  if (!targetId || (scope !== 'c2c' && scope !== 'group')) return undefined;
  return { scope, targetId };
}

/**
 * 默认目标：当前会话对应的人/群。
 * 数据来自适配器的 `features/peer-registry.js`（本项目第二个补丁）写的
 * `<dataDir>/current-speaker.json` —— 那里同时记了 `scope` 与 `peerId`。
 */
export function defaultTargetFrom(speakerTable, sessionId) {
  const rec = sessionId ? speakerTable?.[sessionId] : null;
  if (!rec?.peerId) return undefined;
  const scope = rec.scope === 'group' ? 'group' : 'c2c';
  return { scope, targetId: String(rec.peerId) };
}

/** 真发送：拿 app token → 打官方接口。token 带缓存，不每次都要。 */
function makeRealSender(logger) {
  let cached = { token: null, expiresAt: 0 };

  async function getToken() {
    if (cached.token && Date.now() < cached.expiresAt) return cached.token;
    const appId = process.env.QQBOT_APPID;
    const secret = process.env.QQBOT_SECRET;
    if (!appId || !secret) throw new Error('拿不到 QQBOT_APPID / QQBOT_SECRET（进程环境里没有）');
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId, clientSecret: secret }),
      signal: AbortSignal.timeout(20000),
    });
    const d = await r.json();
    if (!d?.access_token) throw new Error(`取 access token 失败：HTTP ${r.status}`);
    const ttl = (Number(d.expires_in) || 7200) * 1000;
    cached = { token: d.access_token, expiresAt: Date.now() + Math.max(ttl - TOKEN_SKEW_MS, 60_000) };
    return cached.token;
  }

  return async function send(scope, targetId, text) {
    const token = await getToken();
    const path = scope === 'group'
      ? `/v2/groups/${encodeURIComponent(targetId)}/messages`
      : `/v2/users/${encodeURIComponent(targetId)}/messages`;
    const r = await fetch(API_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${token}` },
      // 不带 msg_id = 主动消息
      body: JSON.stringify({ content: text, msg_type: 0, msg_seq: 1 }),
      signal: AbortSignal.timeout(20000),
    });
    const bodyText = await r.text();
    if (!r.ok) {
      // ⚠️ 错误原文里**没有**凭据，可以安全回报给模型
      throw new Error(`HTTP ${r.status} ${bodyText.slice(0, 200)}`);
    }
    logger?.info?.(`qqbot_say: 已主动发送 → ${scope}:${targetId.slice(0, 8)}…（${text.length} 字）`);
    return bodyText;
  };
}

/**
 * 注册工具。
 *
 * @param {object} ctx      插件上下文（取 tools 服务）
 * @param {object} cfg      插件配置
 * @param {object} logger
 * @param {object} deps
 * @param {(exec:object)=>object|null} deps.resolveSpeaker 按 exec 解析本轮说话人（判定超管）
 * @param {(scope:string,id:string,text:string)=>Promise<any>} [deps.send] 注入假发送器（自测用）
 */
export function registerSayTool(ctx, cfg, logger, deps = {}) {
  const tools = (() => { try { return ctx.get('tools'); } catch { return undefined; } })();
  if (!tools?.register) {
    logger?.warn?.('拿不到 tools 服务，qqbot_say 未注册');
    return false;
  }

  const send = deps.send ?? makeRealSender(logger);
  const resolveSpeaker = deps.resolveSpeaker;

  const readSpeakerTable = () => {
    try {
      const f = join(cfg.dataDir, 'current-speaker.json');
      if (!existsSync(f)) return {};
      const obj = JSON.parse(readFileSync(f, 'utf8'));
      return obj && typeof obj === 'object' ? obj : {};
    } catch { return {}; }
  };

  tools.register({
    name: SAY_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The message body to send. Plain text, kept short.' },
        target: {
          type: 'string',
          description: 'Optional. "c2c:<openid>" or "group:<openid>". '
            + 'Omit to send to the CURRENT conversation (recommended when the owner says "私聊我").',
        },
        reason: { type: 'string', description: 'Optional one-liner: why you are sending this (for the log).' },
      },
      required: ['text'],
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
    async execute(args, exec) {
      const text = String(args.text ?? '').trim();
      if (!text) return { text: '（没给正文，没发）' };
      if (text.length > 2000) return { text: '（太长了，主动消息会被截断；精简到 2000 字以内再发）' };

      // ── 闸门：只有超管能主动发
      const sp = (() => {
        try { return resolveSpeaker?.(exec) ?? null; } catch { return null; }
      })();
      const admins = (cfg.adminOpenIds ?? []).map((s) => String(s).toUpperCase());
      if (!sp?.openid || !admins.includes(String(sp.openid).toUpperCase())) {
        return { text: '（主动发消息只有超管能下。）' };
      }

      // ── 目标：显式 target > 当前会话
      let tgt;
      if (args.target !== undefined && args.target !== '') {
        tgt = parseTarget(args.target);
        if (!tgt) return { text: `（target 格式不对，要 c2c:openid 或 group:openid，收到：${args.target}）` };
      } else {
        const sid = exec?.agent?.session?.id;
        tgt = defaultTargetFrom(readSpeakerTable(), sid);
        if (!tgt) return { text: '（认不出当前会话是谁，请显式给 target，例如 c2c:<openid>）' };
      }

      try {
        await send(tgt.scope, tgt.targetId, text);
        return { text: `已主动发送 → ${tgt.scope}:${tgt.targetId.slice(0, 8)}…` };
      } catch (err) {
        const detail = String(err?.message ?? err).slice(0, 240);
        const hint = tgt.scope === 'group' && detail.includes('40034105')
          ? ' —— 群主动消息平台不给权限，改成私聊发。'
          : '';
        return { text: `发送失败：${detail}${hint}` };
      }
    },
  });

  logger?.info?.('qqbot_say 工具已注册（主动发文字，仅超管）');
  return true;
}
