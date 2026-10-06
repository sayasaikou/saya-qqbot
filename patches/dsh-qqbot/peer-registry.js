/**
 * peer-registry —— 把「这条消息是谁发的 / 在哪个群」在**入站那一刻**写到盘上。
 *
 * ════════════════════════════════════════════════════════════════
 * 为什么必须由适配器做（2026-10-06 · T-005 定案）
 * ════════════════════════════════════════════════════════════════
 *
 * dsh 的一个 turn 里的真实顺序是（源码：dsh-agent-loop/lib/index.js）：
 *
 *   turn()      943:  append("turn/start")
 *               954:  preStep(...)                  ← 组装 system prompt 在这一行里面
 *   preStep()   906:    inbox.claim(...)           ← 先把消息从收件箱取走
 *               907:    systemPrompt.assemble(...)  ← 插件的注入钩子在这里触发
 *   step()     1046:  append("user/message")       ← 用户消息**到这里才进 session**
 *
 * ⇒ 插件挂在 `system-prompt/assemble` 上的钩子，**永远读不到本轮说话人**：
 *   它靠 `session/event` 记的说话人必然是**上一轮**的。
 *   实测症状就是「关系卡稳定慢一轮」——会把 A 的身份和好感度用在 B 头上。
 *
 * 适配器在 `handleInbound` 里**本来就知道** `msg.senderId` / `msg.senderName` /
 * `msg.groupOpenid` / `sessionId`，而且这个时机**严格早于 turn**。
 * 所以由它落一份盘，插件在 assemble 时同步读 —— 顺序问题从根上消失。
 *
 * ════════════════════════════════════════════════════════════════
 * 落两个文件（都在 `<config.cwd>/data/` 下，与 qqbot-memory 的 dataDir 同处）
 * ════════════════════════════════════════════════════════════════
 *
 *   current-speaker.json  { [sessionId]: { openid, name, scope, at } }
 *        → 给 qqbot-memory 的关系卡用（T-005）
 *   groups.json           { [groupOpenid]: { firstSeen, lastSeen, msgs } }
 *        → 给升级播报用（"发到它所在的每个群"）。
 *          群清单没有别的来源：适配器的历史缓冲是**纯内存**的（MemoryHistoryStore），
 *          而 sessionId = sha256("qqbot:appId:group:<groupOpenid>") 是**单向哈希**，推不回来。
 *
 * ════════════════════════════════════════════════════════════════
 * ⚠️ 这是本项目的**第二个第三方包补丁**
 * ════════════════════════════════════════════════════════════════
 * 第一个：私聊也要带 senderTag（`transport/inbound.js` 的 buildUserMessage 分支，
 *         2026-10-05，因为私聊里超管判定整个失效）。
 * **装/升级 `@tencent-connect/dsh-qqbot` 会冲掉这两个补丁** ⇒
 * 升级后必须重跑重打流程（`dist/` 是编译产物，改的是编译产物，不是 TS 源码）。
 * 判据（回读才算证据）：
 *   grep -c "rememberPeer" <profile>/node_modules/@tencent-connect/dsh-qqbot/dist/transport/inbound.js
 * 应 ≥ 2（import + 调用）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 超过这个岁数的说话人记录直接剪掉（留着没用，还会让文件一直长） */
const SPEAKER_TTL_MS = 60 * 60 * 1000;
/** 群清单上限（正常人不可能进这么多群；纯粹防文件无限增长） */
const MAX_GROUPS = 500;

function dataDir(cwd) {
  return join(cwd && cwd.length > 0 ? cwd : '.', 'data');
}

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    const obj = JSON.parse(readFileSync(file, 'utf8'));
    return obj && typeof obj === 'object' ? obj : fallback;
  } catch {
    // 读坏了就当没有 —— 这里绝不能抛，否则会打断入站流程
    return fallback;
  }
}

function writeJson(file, obj) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    // 先写临时文件再改名：插件那边是并发同步读的，直接覆盖可能读到半截 JSON
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    renameSync(tmp, file);
  } catch {
    // 写不进去也绝不能影响对话 —— 这里刻意静默
  }
}

/**
 * 记下"当前这条消息是谁发的、在哪个群"。**必须在 agent.followup 之前调用。**
 *
 * @param {object} info
 * @param {string} info.cwd        适配器配置里的 agent 工作目录（数据文件落它下面的 data/）
 * @param {string} info.sessionId  本次消息对应的 dsh 会话 id
 * @param {'group'|'c2c'} info.scope
 * @param {string} info.peerId     群 openid（群聊）或用户 openid（私聊）
 * @param {string} info.senderId   发送者 openid
 * @param {string} [info.senderName]
 * @param {number} [info.now]      当前时间戳（测试用，缺省 Date.now()）
 */
export function rememberPeer(info) {
  const now = typeof info.now === 'number' ? info.now : Date.now();
  const dir = dataDir(info.cwd);

  // ── ① 当前说话人（给关系卡用）
  if (info.sessionId) {
    const file = join(dir, 'current-speaker.json');
    const all = readJson(file, {});
    // 顺手剪掉过期的，免得文件只涨不缩
    for (const [sid, rec] of Object.entries(all)) {
      if (!rec || typeof rec.at !== 'number' || now - rec.at > SPEAKER_TTL_MS) delete all[sid];
    }
    all[info.sessionId] = {
      openid: String(info.senderId ?? '').toUpperCase(),
      name: info.senderName ?? '',
      scope: info.scope ?? 'c2c',
      peerId: info.peerId ?? '',
      at: now,
    };
    writeJson(file, all);
  }

  // ── ② 群登记表（给升级播报用；私聊不记）
  if (info.scope === 'group' && info.peerId) {
    const file = join(dir, 'groups.json');
    const all = readJson(file, {});
    const key = String(info.peerId);
    const prev = all[key];
    all[key] = {
      openid: key,
      firstSeen: prev?.firstSeen ?? new Date(now).toISOString(),
      lastSeen: new Date(now).toISOString(),
      msgs: (prev?.msgs ?? 0) + 1,
    };
    // 超上限就按 lastSeen 砍最旧的
    const keys = Object.keys(all);
    if (keys.length > MAX_GROUPS) {
      keys
        .sort((a, b) => String(all[a].lastSeen).localeCompare(String(all[b].lastSeen)))
        .slice(0, keys.length - MAX_GROUPS)
        .forEach((k) => delete all[k]);
    }
    writeJson(file, all);
  }
}
