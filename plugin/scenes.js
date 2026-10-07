/**
 * scenes.js —— 场合命名：给「群 / 私聊」起个人认得出来的名字。
 *
 * ════════════════════════════════════════════════════════════════
 * 为什么需要它（2026-10-06 · 写完 qqbot_where 之后发现自己写错了）
 * ════════════════════════════════════════════════════════════════
 *
 * QQ **不把群名给机器人**（平台侧就没这个字段），所以任何"我都在哪些群"的回答
 * 只能显示 openid 前 8 位 —— 读起来是一串十六进制。
 *
 * 我一开始在工具输出里写"让超管用 qqbot_admin 的别名机制给群绑一个" ——
 * **那是错的**：别名机制（relations.js 的 set_alias）认的是**人**（openid → 名字），
 * 作用在关系表上，群 openid 根本不在那张表里。
 *
 * 所以这里补一个**独立**的场合命名表：`data/scenes.json`
 *   { "group:<群openid>": "机器人战队群", "c2c:<openid>": "超管私聊" }
 *
 * ⚠️ 纪律：
 *   ① **只是显示层的名字** —— 不参与权限、不参与限额、不参与关系分（免得"改个名"变成提权）；
 *   ② 只有超管能命名（跟别的管理动作一致）；
 *   ③ 名字**不唯一**也不影响任何逻辑（重复就重复，只是显示）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SCENE_TOOL_NAME = 'qqbot_scene';

const DESC =
  'Name a scene so it is readable later (QQ does not give us group names — without this you only ever see '
  + 'an openid prefix). Actions: "set" (name the CURRENT scene, or a given scene), "list", "remove". '
  + 'Admin only. Purely a display label: it never affects permissions, scores or limits.';

export function scenesPath(cfg) {
  return join(cfg.dataDir, 'scenes.json');
}

export function loadScenes(cfg) {
  try {
    const f = scenesPath(cfg);
    if (!existsSync(f)) return {};
    const o = JSON.parse(readFileSync(f, 'utf8'));
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

export function saveScenes(cfg, data, logger) {
  try {
    if (!existsSync(cfg.dataDir)) mkdirSync(cfg.dataDir, { recursive: true });
    writeFileSync(scenesPath(cfg), JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    logger?.warn?.(`场合命名落盘失败: ${err?.message ?? err}`);
    return false;
  }
}

export function sceneKey(scope, peerId) {
  return `${scope ?? '?'}:${String(peerId ?? '').toUpperCase()}`;
}

/** 给显示层用：拿不到名字就回退到 id 前 8 位（绝不编一个） */
export function sceneLabel(scenes, scope, peerId) {
  const k = sceneKey(scope, peerId);
  const named = scenes?.[k];
  if (named) return `${named}（${String(peerId ?? '').slice(0, 8)}…）`;
  if (scope === 'c2c') return `私聊 ${String(peerId ?? '').slice(0, 8)}…`;
  if (scope === 'group') return `群 ${String(peerId ?? '').slice(0, 8)}…`;
  return `未知场合 ${String(peerId ?? '').slice(0, 8)}…`;
}

export function registerSceneTool(ctx, cfg, logger, deps = {}) {
  const tools = (() => { try { return ctx.get('tools'); } catch { return undefined; } })();
  if (!tools?.register) {
    logger?.warn?.('拿不到 tools 服务，qqbot_scene 未注册');
    return false;
  }
  const resolveSpeaker = deps.resolveSpeaker;
  const resolveScene = deps.resolveScene;   // () => { scope, peerId } | null

  tools.register({
    name: SCENE_TOOL_NAME,
    description: DESC,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['set', 'list', 'remove'], description: 'What to do.' },
        name: { type: 'string', description: 'For set: the human-readable name, e.g. "机器人战队群".' },
        scene: { type: 'string', description: 'Optional "group:<openid>" or "c2c:<openid>". Defaults to the CURRENT scene.' },
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
      const sp = (() => {
        try { return resolveSpeaker?.(exec) ?? null; } catch { return null; }
      })();
      const admins = new Set((cfg.adminOpenIds ?? []).map((s) => String(s).toUpperCase()));
      if (!sp?.openid || !admins.has(String(sp.openid).toUpperCase())) {
        return { text: '（场合命名只有超管能做。）' };
      }

      const scenes = loadScenes(cfg);
      const action = String(args.action ?? '').trim();

      if (action === 'list') {
        const rows = Object.entries(scenes);
        if (!rows.length) return { text: '（还没有命名过任何场合）' };
        return { text: '已命名的场合：\n' + rows.map(([k, v]) => `· ${k} → ${v}`).join('\n') };
      }

      // 目标场合：显式给的 > 当前这条消息所在的
      let key = String(args.scene ?? '').trim().toUpperCase();
      if (key && !key.includes(':')) key = `GROUP:${key}`;
      if (!key) {
        const cur = (() => {
          try { return resolveScene?.(exec) ?? null; } catch { return null; }
        })();
        if (!cur?.peerId) return { text: '（认不出当前是哪个场合；可以显式给 scene="group:<openid>"。）' };
        key = sceneKey(cur.scope, cur.peerId);
      }

      if (action === 'remove') {
        if (!scenes[key]) return { text: `（${key} 本来就没命名过）` };
        delete scenes[key];
        saveScenes(cfg, scenes, logger);
        return { text: `已删掉 ${key} 的名字。` };
      }

      if (action === 'set') {
        const name = String(args.name ?? '').trim();
        if (!name) return { text: '（没给名字）' };
        if (name.length > 40) return { text: '（名字太长了，40 字以内）' };
        scenes[key] = name;
        const ok = saveScenes(cfg, scenes, logger);
        if (!ok) return { text: '（写不进去，看日志）' };
        return { text: `记下了：${key} → **${name}**。以后问"我在哪些场合"就会用这个名字。\n`
          + '（提醒一句：这只是显示用的名字，不影响权限、好感度或额度。）' };
      }

      return { text: `（不认识的 action：${action}）` };
    },
  });

  logger?.info?.('qqbot_scene 工具已注册（场合命名 · 仅超管 · 纯显示层）');
  return true;
}
