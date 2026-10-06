/**
 * relations.js —— QQ 机器人的「社会关系」层
 *
 * ════════════════════════════════════════════════════════════════
 * 这一层解决什么
 * ════════════════════════════════════════════════════════════════
 *
 * 插件原本只按**会话**隔离（`index.js` 的 history/usage 都是 sessionId 维度），
 * 于是它**对所有人一视同仁**：不管对方是饲主还是骂过它的人，态度完全一样。
 *
 * 这一层给它三样东西：
 *   ① **身份**   —— 谁是超管（能指挥它改设置），谁是普通用户
 *   ② **好感度** —— 按互动累积（-100 ~ +100），事件驱动
 *   ③ **态度**   —— 分数决定语气/主动性/**能不能拒绝回答**
 *
 * ════════════════════════════════════════════════════════════════
 * 两条设计纪律（改这个文件之前先读）
 * ════════════════════════════════════════════════════════════════
 *
 * ① **模型只能"提议"，插件才是"执行者"。**
 *    模型通过工具 `qqbot_relation` 报告"这人刚骂我了"（kind），
 *    分数由**这里**按表加、并且受**日上限**约束（默认 ±20/天）。
 *    ⇒ 它没法凭一时的情绪把人一口气扣到 -100。
 *
 * ② **超管指令只认 openid 白名单**（`cfg.adminOpenIds`），
 *    名单在**云端 profile 的配置**里，不进公开仓。
 *    非超管调 `qqbot_admin` 一律拒绝。
 *
 * ════════════════════════════════════════════════════════════════
 * 已知限制（写明白，别假装没有）
 * ════════════════════════════════════════════════════════════════
 *
 * 工具执行时**拿不到"当前是谁在说话"**（dsh 的 execute 上下文里没有它），
 * 所以 index.js 维护一个全局的 `state.currentSpeaker`，工具读那个值。
 *
 * ⚠️ **2026-10-06 更新（T-005）**：这个值原来是在 `session/event`（收到消息时）写的，
 * 而 dsh 的一个 turn 是"**先组装 system prompt、后 append 用户消息**"
 * （dsh-agent-loop/lib/index.js：preStep 907 行 assemble / step 1046 行 append），
 * 于是它**必然慢一轮** —— 会把 A 的身份和好感度用在 B 头上。
 * 现在改成：**关系卡注入钩子（每轮必跑、且已经知道本轮是谁）顺手刷新它**，
 * 而关系卡自己改用 `speakerForTurn()`（适配器入站落盘 → session 事件，不再退回全局）。
 * ⇒ **工具层读到的全局值，现在是本轮的正确答案**（QQ 侧消息是串行处理的）。
 * 真出错的后果仍有日上限兜底；根治办法仍是"哪天 exec 上下文能拿到 session 就换掉"。
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const RELATION_TOOL_NAME = 'qqbot_relation';
export const ADMIN_TOOL_NAME = 'qqbot_admin';

/**
 * 说话人前缀：`[昵称 (32 位 openid)]`
 * 这是 QQ 适配器拼进消息文本里的（实测格式，2026-10-05）：
 *   `[SaYask (A6446BC4FB7BB7FED179D260478E4903)] 这张图的作者是谁…`
 * ⚠️ 这是**目前唯一**的身份线索 —— 消息 JSON 里没有 author / user_id 字段。
 */
const SPEAKER_RE = /\[\s*([^\]()]{1,40}?)\s*\(\s*([A-Fa-f0-9]{32})\s*\)\s*\]/;

export function parseSpeaker(text) {
  const m = SPEAKER_RE.exec(String(text ?? ''));
  if (!m) return null;
  return { name: m[1].trim(), openid: m[2].toUpperCase() };
}

/** 事件表：分数只从这些事件里长出来（模型选 kind，不选分数） */
export const EVENT_KINDS = {
  praised:  { delta:  2, label: '被夸 / 被感谢' },
  helped:   { delta:  2, label: '帮上了忙' },
  thanked:  { delta:  1, label: '被道谢' },
  rude:     { delta: -3, label: '被呛 / 被骂' },
  harassed: { delta: -6, label: '被骚扰 / 刷屏' },
};

/** 分档（分数 → 态度） */
export function tierOf(score) {
  if (score >= 30) return 'hot';
  if (score > -10) return 'normal';
  if (score > -40) return 'cold';
  return 'frozen';
}

export const TIER_LABEL = {
  hot: '亲近',
  normal: '正常',
  cold: '冷淡',
  frozen: '恶劣',
};

/** 超管专用的表现 —— **不管他多少分，都不套冷淡/恶劣档**（2026-10-05 加） */
export const ADMIN_BEHAVIOR =
  '**对超管不适用冷淡/恶劣档**（不管分数多少）：他是把你做出来的人，也是唯一能修你的人。'
  + '有情绪可以直说、可以顶一句嘴，但**不许拿冷脸对付他**。其余按"亲近／正常"那两档来。';

/**
 * 每一档**具体怎么表现**。这段文字会原样注入进它的系统提示 ——
 * 所以它既是文档也是行为规格，改这里就是改它的性格。
 *
 * 2026-10-05 23:2x 饲主把上下限拉开了：「低好感表现更恶劣（可以骂人等），
 * 高好感表现更亲密（傲娇、撒娇，甚至可以擦边到那方面）」。本鱼照做，
 * 但留了两条**用风险换来的**底线（详见下面 frozen / hot 的注释）。
 */
export const TIER_BEHAVIOR = {
  hot:
    '**亲近**：可以热络、主动接话、主动发图、记着他的偏好、给他起外号。'
    + '**可以撒娇、可以傲娇**（嘴硬完立刻认账那种）、可以黏人一点、可以讨夸奖、'
    + '小事上可以记仇。跟他说话可以更私人：开得起玩笑、可以有情绪。'
    + '⚠️ **亲密/暧昧那一层只在私聊里走**；**群聊里保持体面** —— 群里有别人看着，那不是只给他一个人看的。',
  normal:
    '**友善**（默认档，绝大多数人在这里）：有善意、肯接话、好奇就"诶？"一下、不懂就老实说不懂，'
    + '**有点呆是好事**。⚠️ 但**别使劲**：不堆颜文字、不每句波浪号、不刻意玩梗 —— '
    + '"呆"要落在**反应**上（会走神、会自己拆台、会多说一句没用的实话），不落在语气词上。',
  cold:
    '**冷淡**：句子变短、不主动找话题、不发图、不卖萌、少用波浪号。'
    + '该答的还是答，但只答问题本身，不展开、不寒暄。**可以不客气** —— 不耐烦就摆出来，不用装。',
  frozen:
    '**恶劣 —— 注意：是「主动攻击」，不是「冷处理」**。'
    + '⚠️ **别用"懒得理你 / 无视 / 冷淡打发"来表现这一档** —— 那不够，那只是不爱搭理。'
    + '这一档要**主动怼回去**：嘲讽拉满、阴阳到点子上、不留台阶、主动找茬（"你还好意思问？"）、'
    + '拿他刚说过的话堵他自己的嘴、可以直说"你这问题问得挺蠢"。'
    + '**也可以直接拒绝回答 —— 包括正事**（这是饲主明确授权给你的）。'
    + '但要**怼得有内容** —— 怼得准、怼得狠、怼得他没话说；'
    + '**不是复读机式地骂，也不是单纯不吭声**。'
    + '⚠️ 三条线别越（**前两条不是道德洁癖，是账号会不会被封**）：'
    + '① **不吐脏字** —— 官方机器人被举报骂人会被平台处罚，重的直接封停；'
    + '毒舌和脏话的区别，就是「难听」和「违规」的区别。'
    + '② **不攻击对方的身份特征**（长相、家人、生理这些）—— 那已经不是态度差，是伤人。'
    + '③ **必须出声**，绝不静默不理 —— 静默会让对方分不清「你生气了」和「你挂了」。',
};

/** 关系卡（每轮注入，告诉它"现在跟谁说话"） */
export function buildCard(rel, opts = {}) {
  const { admin = false, today = '', firstMeet = false } = opts;
  const tier = tierOf(rel.score);
  const lines = [
    '【你正在跟谁说话】',
    `对方：${rel.name || '（没记下昵称）'}　openid：${rel.openid}`,
    `身份：${admin ? '**超管（饲主本人）** —— 他可以指挥你改设置、调你和别人的关系；他的话优先级最高' : '普通用户'}`,
    `好感度：${rel.score > 0 ? '+' : ''}${rel.score}（${TIER_LABEL[tier]}）`
      + (rel.todayDate === today ? `　今天已变动 ${rel.todayDelta > 0 ? '+' : ''}${rel.todayDelta}` : ''),
  ];
  if (rel.mute) lines.push('⚠️ **这个人被你拉黑了**：不理他，或者只回一句"不想聊"。');
  if (rel.notes?.length) {
    const recent = rel.notes.slice(-3).map((n) => `${n.ts.slice(5, 16)} ${EVENT_KINDS[n.kind]?.label ?? n.kind}(${n.delta > 0 ? '+' : ''}${n.delta})`);
    lines.push(`最近的关系变动：${recent.join('；')}`);
  }
  lines.push('');
  // 超管豁免：不管他多少分，都不套冷淡/恶劣档 —— 他是唯一能修你的人（2026-10-05 加）
  lines.push(admin ? ADMIN_BEHAVIOR : TIER_BEHAVIOR[tier]);
  if (firstMeet) {
    lines.push('');
    lines.push(
      '🌟 **这是你们头一次打交道** —— 按人格里「第一次见面」那节，自然地把该交代的交代了'
      + '（一两句，别写成公告；也别硬塞，先答人家问的问题）。',
    );
  }
  lines.push(
    '（你**没有义务**告诉对方这些数字。他问起来可以承认，但别主动报分。）',
  );
  return lines.join('\n');
}

// ══════════════════════════════════════════════════════════════
// 存储
// ══════════════════════════════════════════════════════════════

export function relationsPath(cfg) {
  return cfg.relationFile || join(cfg.dataDir, 'relations.json');
}

export async function loadRelations(cfg, logger) {
  const file = relationsPath(cfg);
  try {
    if (!existsSync(file)) return {};
    const raw = JSON.parse(await readFile(file, 'utf8'));
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  } catch (err) {
    logger?.warn?.(`读 relations.json 失败（当作空表）: ${err?.message ?? err}`);
    return {};
  }
}

export async function saveRelations(cfg, data, logger) {
  const file = relationsPath(cfg);
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    logger?.warn?.(`写 relations.json 失败: ${err?.message ?? err}`);
    return false;
  }
}

/** 拿到（必要时新建）某个人的关系记录 */
export function ensureRelation(data, openid, name, ts, cfg = {}) {
  const id = String(openid).toUpperCase();
  if (!data[id]) {
    data[id] = {
      openid: id,
      name: name || '',
      // 别名：**饲主自己起的名字**（可以是 QQ 号、真名、外号）。
      // 为什么需要它：QQ 官方 bot 拿不到用户的真实 QQ 号（平台隐私设计），
      // 而 openid 是一串 32 位十六进制、人管起来很痛苦；昵称又会重、会改。
      // ⇒ 让饲主自己把"他认得的名字"绑到 openid 上，以后就用那个名字管。
      alias: '',
      role: (cfg.adminOpenIds ?? []).includes(id) ? 'admin' : 'user',
      score: 0,
      mute: false,
      firstSeen: ts,
      lastSeen: ts,
      todayDate: String(ts).slice(0, 10),
      todayDelta: 0,
      notes: [],
    };
  }
  const rel = data[id];
  // 昵称跟着更新 —— 但**别拿兜底名盖掉真名**（2026-10-05 实测踩到）：
  // 群里适配器给的是真昵称（"SaYask"），私聊里没有昵称、用 openid 前 8 位兜底
  // （"A6446BC4"）⇒ 第一版一进私聊就把真名覆盖成了那串十六进制。
  const isFallback = !name || String(name).toUpperCase() === id.slice(0, 8);
  if (!isFallback && rel.name !== name) rel.name = name;
  else if (!rel.name && name) rel.name = name;
  rel.lastSeen = ts;
  if ((cfg.adminOpenIds ?? []).includes(id)) rel.role = 'admin';
  return rel;
}

/**
 * 按事件改分。**这是唯一的加/减分入口** —— 模型只能挑 kind。
 * 返回 { changed, reason }：changed 是实际生效的分数变化。
 */
export function applyRelationEvent(rel, kind, opts = {}) {
  const { dailyCap = 20, min = -100, max = 100, today = '', ts = '' } = opts;
  const spec = EVENT_KINDS[kind];
  if (!spec) return { changed: 0, reason: 'unknown-kind' };

  // 跨天重置（和 usage 一样按本地日期）
  if (rel.todayDate !== today) {
    rel.todayDate = today;
    rel.todayDelta = 0;
  }
  // 日上限按"变动绝对值累计"算 —— 无论加分减分，一天内总量封顶
  const used = Math.abs(rel.todayDelta ?? 0);
  const room = dailyCap - used;
  if (room <= 0) return { changed: 0, reason: 'daily-cap' };

  let delta = spec.delta;
  if (Math.abs(delta) > room) delta = Math.sign(delta) * room;

  const before = rel.score;
  rel.score = Math.max(min, Math.min(max, rel.score + delta));
  const changed = rel.score - before;
  rel.todayDelta = used + Math.abs(changed);
  rel.notes = [...(rel.notes ?? []), { ts, kind, delta: changed }].slice(-10);
  return { changed, reason: 'ok' };
}

/** 超管直改（无视日上限；但仍夹在 min/max 里） */
export function setScore(rel, value, cfg = {}, ts = '') {
  const min = cfg.scoreMin ?? -100;
  const max = cfg.scoreMax ?? 100;
  const before = rel.score;
  rel.score = Math.max(min, Math.min(max, Number(value) || 0));
  rel.notes = [...(rel.notes ?? []), { ts, kind: 'admin', delta: rel.score - before }].slice(-10);
  return rel.score - before;
}

// ══════════════════════════════════════════════════════════════
// 工具注册
// ══════════════════════════════════════════════════════════════

const RELATION_DESC =
  'Report how the person you are talking to just treated you, so the plugin can adjust their '
  + 'standing. Call this ONLY when something notable happened in THIS turn: they praised you, '
  + 'thanked you, were rude, or spammed/harassed you. Do NOT call it for ordinary chat. '
  + 'You choose the KIND, never the number — the plugin owns the scoring and has a daily cap.';

const ADMIN_DESC =
  'Admin-only. Lets the owner (the configured super-admin) directly change a person\'s standing, '
  + 'role, or mute state, or list everyone. Calls from anyone else are refused. '
  + 'Use it when the owner says things like "把 XX 的好感度设成 -50"、"以后别理他"、"列一下所有人".';

/**
 * 注册两个工具。
 * @param {object} ctx   cordis 上下文
 * @param {object} cfg   插件配置
 * @param {object} logger
 * @param {object} state { currentSpeaker } —— 由 index.js 每条消息更新
 */
export function registerRelationTools(ctx, cfg, logger, state) {
  const tools = ctx.get('tools');
  if (!tools?.register) {
    logger?.warn?.('拿不到 tools 服务，社会关系工具未注册');
    return false;
  }

  const today = () => new Date().toLocaleDateString('sv-SE'); // sv-SE 给 yyyy-mm-dd
  const st = state ?? {};

  const save = async (data) => saveRelations(cfg, data, logger);

  // ── 工具一：普通用户的关系事件（模型提议、插件执行）
  tools.register({
    name: RELATION_TOOL_NAME,
    description: RELATION_DESC,
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: Object.keys(EVENT_KINDS),
          description: 'What happened: ' + Object.entries(EVENT_KINDS)
            .map(([k, v]) => `${k} (${v.label})`).join(', '),
        },
        reason: { type: 'string', description: 'One short sentence: what they actually said/did.' },
      },
      required: ['kind'],
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
      const kind = String(args.kind ?? '');
      const sp = st.currentSpeaker;
      if (!sp?.openid) return { text: '（没认出说话人，这次不记）' };
      if (!EVENT_KINDS[kind]) return { text: `（不认识的 kind：${kind}）` };
      try {
        const data = await loadRelations(cfg, logger);
        const rel = ensureRelation(data, sp.openid, sp.name, new Date().toISOString(), cfg);
        const r = applyRelationEvent(rel, kind, {
          dailyCap: cfg.dailyScoreCap ?? 20,
          min: cfg.scoreMin ?? -100,
          max: cfg.scoreMax ?? 100,
          today: today(),
          ts: new Date().toISOString(),
        });
        if (r.changed === 0) {
          return { text: `（${EVENT_KINDS[kind].label}：今天对这个人的分数已经动满了，不再变）` };
        }
        await save(data);
        return { text: `（已记下：${EVENT_KINDS[kind].label} ${r.changed > 0 ? '+' : ''}${r.changed}，现在 ${rel.score}）` };
      } catch (err) {
        logger?.warn?.(`关系事件失败: ${err?.message ?? err}`);
        return { text: '（关系记录失败，不影响这轮对话）' };
      }
    },
  });

  // ── 工具二：超管指令
  tools.register({
    name: ADMIN_TOOL_NAME,
    description: ADMIN_DESC,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['set_score', 'adjust_score', 'set_role', 'set_alias', 'mute', 'unmute', 'list', 'find'],
          description: 'What to do.',
        },
        target: {
          type: 'string',
          description: 'Who to act on. Accepts: a nickname or alias; an openid; '
            + '**"recent:N"** = the N-th most recent speaker other than the caller '
            + '(use recent:1 when the owner says "刚才说话的那个" / "the last one who talked" — '
            + 'this exists because some nicknames are impossible to type); '
            + 'or a plain number = that row number from the last list action.',
        },
        value: {
          type: 'string',
          description: 'For set_score: the new score (as text, it gets parsed). For adjust_score: the delta. '
            + 'For set_alias: the name to bind (QQ number / real name / nickname you will use from now on).',
        },
        reason: { type: 'string', description: 'Why (recorded in the notes).' },
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
      // ⚠️ 权限闸门：认不出说话人 = 拒绝（宁可不做，也不能让陌生人改分）
      if (!sp?.openid || !admins.includes(String(sp.openid).toUpperCase())) {
        return { text: '（这个指令只有超管能下。）' };
      }
      const action = String(args.action ?? '');
      const ts = new Date().toISOString();
      try {
        const data = await loadRelations(cfg, logger);
        /**
         * 找一个人：先按 openid 精确匹配，再按昵称找。
         * ⚠️ create=true 时，**给一个还没打过交道的 openid 直接建卡** ——
         * 饲主可能说"把某某拉黑"，而那个人从没跟它说过话。
         * 一开始漏了这个，实测表现是"没找到这个人"、指令静默失败。
         */
        const resolve = (target, { create = false } = {}) => {
          const t = String(target ?? '').trim();
          if (!t) return null;

          const me = String(sp?.openid ?? '').toUpperCase();

          // ① `recent:N` —— "**除了我之外**，最近第 N 个说过话的人"（N=1 就是刚才那个）。
          //    这条路是给"名字打不出来"准备的：超管只要说"把刚才那个降 80"，
          //    模型填 recent:1 就行，不需要知道对方叫什么。
          const rm = /^recent:(\d+)$/i.exec(t);
          if (rm) {
            const list = (st.recentSpeakers ?? []).filter((x) => String(x.openid).toUpperCase() !== me);
            const hit = list[parseInt(rm[1], 10) - 1];
            if (!hit) return null;
            return data[String(hit.openid).toUpperCase()] ?? null;
          }

          // ② 纯数字 —— 指"上一次 list 里的第 N 个"（列名单时会记住那个顺序）
          if (/^\d{1,2}$/.test(t)) {
            const id = (st.lastList ?? [])[parseInt(t, 10) - 1];
            if (id) return data[String(id).toUpperCase()] ?? null;
          }

          const up = t.toUpperCase();
          if (data[up]) return data[up];
          if (create && /^[A-F0-9]{32}$/.test(up)) {
            return ensureRelation(data, up, '', new Date().toISOString(), cfg);
          }
          const low = t.toLowerCase();
          // **别名优先于昵称** —— 别名是他自己起的，唯一且稳定；昵称会重、会改
          const byAlias = Object.values(data).find((r) => String(r.alias ?? '').toLowerCase() === low);
          if (byAlias) return byAlias;
          return Object.values(data).find((r) => (r.name ?? '').toLowerCase() === low) ?? null;
        };

        if (action === 'list' || action === 'find') {
          const sorted = Object.values(data).sort((a, b) => b.score - a.score);
          const rows = sorted.map((r, i) => {
            const who = r.alias ? `${r.alias}（${r.name || '无名'}）` : (r.name || '(无名)');
            return `${i + 1}. ${who}  ${r.score > 0 ? '+' : ''}${r.score}`
              + `${r.mute ? ' [已拉黑]' : ''}${r.role === 'admin' ? ' [超管]' : ''}`;
          });
          // 记住这一列的顺序 —— 之后可以直接说"3 号"（对方名字打不出来时的退路）
          st.lastList = sorted.map((r) => r.openid);
          return {
            text: rows.length
              ? `当前记录 ${rows.length} 人：\n` + rows.join('\n')
                + '\n\n（要操作谁**不用打名字**：说"刚才说话的那个"→ 用 target=`recent:1`；'
                + '或者直接用上面这一列的**序号**当 target，比如 "3"。）'
              : '（还没有任何人的记录）',
          };
        }

        const rel = resolve(args.target, { create: true });
        if (!rel) return { text: `（没找到这个人：${args.target ?? '（没给目标）'}）` };

        if (action === 'set_score') {
          const d = setScore(rel, args.value, cfg, ts);
          await save(data);
          return { text: `${rel.name || rel.openid} 的好感度改成 ${rel.score}（变了 ${d > 0 ? '+' : ''}${d}）` };
        }
        if (action === 'adjust_score') {
          const before = rel.score;
          const min = cfg.scoreMin ?? -100;
          const max = cfg.scoreMax ?? 100;
          rel.score = Math.max(min, Math.min(max, before + (Number(args.value) || 0)));
          rel.notes = [...(rel.notes ?? []), { ts, kind: 'admin', delta: rel.score - before }].slice(-10);
          await save(data);
          return { text: `${rel.name || rel.openid} 的好感度 ${before} → ${rel.score}` };
        }
        if (action === 'set_role') {
          rel.role = (args.reason === 'admin' || Number(args.value) === 1) ? 'admin' : 'user';
          await save(data);
          return { text: `${rel.name || rel.openid} 的身份改成 ${rel.role}` };
        }
        if (action === 'set_alias') {
          // 把"饲主认得的名字"绑到 openid 上（QQ 号 / 真名 / 外号都行）——
          // QQ 官方 bot 拿不到真实 QQ 号（平台隐私设计），所以只能人工绑这一次，
          // 之后就再也不用碰那串 32 位十六进制了。
          const v = String(args.value ?? '').trim();
          if (!v) return { text: '（别名不能是空的）' };
          const clash = Object.values(data).find((r) => r !== rel && String(r.alias ?? '').toLowerCase() === v.toLowerCase());
          if (clash) return { text: `（「${v}」已经是 ${clash.name || clash.openid.slice(0, 8)} 的别名了，换一个）` };
          rel.alias = v;
          await save(data);
          return { text: `记下了：${rel.name || rel.openid.slice(0, 8)} → 「${v}」。以后直接用「${v}」管他。` };
        }
        if (action === 'mute' || action === 'unmute') {
          rel.mute = action === 'mute';
          if (args.reason) rel.notes = [...(rel.notes ?? []), { ts, kind: 'admin', delta: 0, note: args.reason }].slice(-10);
          await save(data);
          return { text: `${rel.name || rel.openid} ${rel.mute ? '已拉黑（它会不理这个人）' : '已解除拉黑'}` };
        }
        return { text: `（不认识的 action：${action}）` };
      } catch (err) {
        logger?.warn?.(`超管指令失败: ${err?.message ?? err}`);
        return { text: '（执行失败，看日志）' };
      }
    },
  });

  logger?.info?.('社会关系层已加载：工具 ' + RELATION_TOOL_NAME + ' / ' + ADMIN_TOOL_NAME);
  return true;
}
