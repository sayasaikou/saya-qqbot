/**
 * qqbot-memory —— QQ 机器人的跨会话记忆
 *
 * ════════════════════════════════════════════════════════════════════
 * 为什么需要这个插件（而不是靠提示词让模型自己记）
 * ════════════════════════════════════════════════════════════════════
 *
 * 第一版的做法是在 groupPrompt / directPrompt 里写一段话，让模型
 * "说话之前先读共享记忆、知道值得记的事就写进去"。
 *
 * **实测失败**。当时的对话是这样的：
 *
 *   用户：测试，另一个会话我让你发了几张表情包
 *   机器人：本鱼这边是真不记得。会话之间是隔离的——另一个会话的我发过什么，
 *          这边看不到。想让我跨会话记住，就说一声，本鱼写进共享记忆里。
 *
 * 它**知道**有共享记忆这回事（说明提示词注入生效了），但它把"写进共享记忆"
 * 当成了一个**可选的提议**（"就说一声"），而不是每次都该做的动作。
 * 结果：记忆文件从未被写过，读也没读。
 *
 * ⇒ 结论：**这类"每次都该发生"的机械动作，不能交给模型自觉**，
 *    必须由插件在事件层硬编码保证。这就是本插件存在的理由。
 *
 * ════════════════════════════════════════════════════════════════════
 * 它做什么（三件事）
 * ════════════════════════════════════════════════════════════════════
 *
 * 1. **记录**：监听 session/event，把每一轮的用户消息与助手回复
 *    按会话追加到 JSONL 文件（append-only，天然可 git 管理）。
 *    ⇒ 满足"保留完整的历史聊天记录"。
 *
 * 2. **共享**：把"别的会话"最近的对话摘要注入到当前会话的 system prompt，
 *    让同一个人在不同群里"被当成同一个人"。
 *    ⇒ 满足"不同时间和不同群聊的人被当作同一个人"。
 *
 * 3. **限流**：按用户维度累计 token 用量并持久化（插件自带的
 *    getTokenUsage 只读内存、重启清零，不能用于限流），
 *    超过每日额度就拒绝请求而不是继续烧钱。
 *
 * ════════════════════════════════════════════════════════════════════
 * 设计上的两条硬规矩
 * ════════════════════════════════════════════════════════════════════
 *
 * * **任何一步失败都不能影响对话本身**。记不上账、读不了记忆、限流统计
 *   出错 —— 一律记日志然后放行。聊天机器人因为记账失败而停止回话，
 *   比漏记几条记录糟糕得多。
 *
 * * **token 用量必须落盘**。限流的全部意义在于"跨重启仍然有效"；
 *   内存里的计数器在重启后清零，那就等于没有限流。
 */

import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Schema from '@deepseek-ai/schemastery';
import yaml from 'js-yaml';
import { registerLookTool } from './look-tool.js';

export const name = 'qqbot-memory';

// 刻意**不导出 inject**。
//
// 这里踩过一个坑，留档：最初写的是 `export const inject = []`（空数组），
// 本意是"不依赖任何服务"。结果插件**静默不挂载** —— 不报错、不留日志，
// 数据目录也没建。同一份配置下，一个什么都不做的最小探针（没有 inject 导出）
// 却能正常跑起来。
//
// ⇒ 结论：cordis 的 inject 空数组不等于"无依赖"。要么列出真正需要的服务名，
//    要么干脆不要这个导出。

/**
 * 配置 schema。
 *
 * ⚠️ 这个导出**不是可选的**：dsh 的 loader 按 cordis 插件的约定读 `Config`
 * 来规范化配置。第一版没写它，插件就没被挂载（连加载错误都不报 —— 因为
 * 配置解析阶段就把这一项跳过了）。对照 @tencent-connect/dsh-qqbot 的
 * config.js 才确认这一点。
 */
export const Config = Schema.object({
  dataDir: Schema.string()
    .default('${QQBOT_DATA}')
    .description('聊天记录、记忆与用量统计的存放根目录'),

  profileDir: Schema.string()
    .default('${DSH_PROFILE_DIR}')
    .description('profile 目录（用于只读地取 im-qqbot 的视觉配置，避免两处配置各说各话）'),

  recordHistory: Schema.boolean()
    .default(true)
    .description('是否把每轮对话按会话追加到 JSONL'),

  maxTextChars: Schema.number()
    .default(4000)
    .description('单条消息最多保留多少字符（防止超长消息撑爆记录）'),

  shareRecentSessions: Schema.number()
    .default(6)
    .description('注入共享记忆时最多带几个"别的会话"的片段'),

  shareRecentTurns: Schema.number()
    .default(4)
    .description('每个会话片段最多带几轮'),

  dailyTokenLimit: Schema.number()
    .default(300000)
    .description('每日 token 上限（输入+输出）。0 = 不限制'),

  overLimitAction: Schema.union(['block', 'warn'])
    .default('block')
    .description('超限动作：block 注入"今天聊够了"的指示；warn 只记日志放行'),
});

/** 默认配置。全部可以在 profile 的 cordis.patch.yml 里覆盖。 */
const DEFAULTS = {
  /** 聊天记录与记忆的存放根目录 */
  dataDir: '${QQBOT_DATA}',

  /** 是否记录聊天历史 */
  recordHistory: true,

  /** 单条消息最长保留多少字符（防止一条超长消息把文件撑爆） */
  maxTextChars: 4000,

  /** 注入共享记忆时，最多带多少个"别的会话"的片段 */
  shareRecentSessions: 6,

  /** 每个会话片段最多带多少轮 */
  shareRecentTurns: 4,

  /** 每日 token 上限（输入+输出），0 = 不限制 */
  dailyTokenLimit: 300000,

  /** 超限时的行为：'block' 直接拒绝 | 'warn' 只记日志放行 */
  overLimitAction: 'block',
};

// ──────────────────────────────────────────────────────────── 小工具

function stamp() {
  return new Date().toISOString();
}

/** 本地日期（用于按天分桶的限额统计）。用本地时区，因为"每日额度"是按人的一天算的。 */
function localDay() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 会话 id 里可能有不适合做文件名的字符，统一换掉 */
function safeName(id) {
  return String(id).replace(/[^0-9A-Za-z_\-]/g, '_').slice(0, 120);
}

function clip(text, max) {
  if (typeof text !== 'string') return '';
  return text.length <= max ? text : text.slice(0, max) + '…(截断)';
}

/**
 * 过滤掉"不是人说的话"的内容。
 *
 * 起因：实测记录里混进了一条 `<system-reminder> Updated instructions from:
 * $DSH_HOME/AGENTS.md ...` —— 那是 dsh 自己的机制（指令文件变更时注入的提醒），
 * 不是用户打的字。它会污染聊天记录，也会浪费共享记忆的 token 预算。
 *
 * 判据刻意保守：只认那些**确定不可能是人打的**形态（超长、或带系统标记）。
 * 宁可漏过一两条噪声，也不要误删用户真实说的话。
 */
function isNoise(text) {
  if (!text) return true;
  // 人不会打这么长的一段话（群聊里更不会）
  if (text.length > 800) return true;
  const markers = [
    '<system-reminder>',
    'Updated instructions from:',
    '[system]',
    'system-reminder',
  ];
  return markers.some((m) => text.includes(m));
}

/**
 * 从一条 session event 里抽出"谁说了什么"。
 *
 * ⚠️ 这个函数的第一版是**猜**的，猜错了，留档免得下次再猜：
 *    第一版写的是 `event.message` / `event.usage`（以为事件本身就是消息），
 *    结果是**一条记录都没写下来** —— 因为真实结构完全不同。
 *
 * 实测出来的真实结构（2026-10-05，靠临时转储拿到）：
 *
 *   session/event 的第二个参数 raw =
 *     { type, seq, time, data }          ← 消息内容在 data 里，不在顶层
 *
 *   raw.type === 'user/message' 时：
 *     raw.data = { content:[{type:'text',text:'...'}], source:{kind:'user'}, role:'user', id }
 *     其中 text 形如 "[SaYask (A6446BC4...)] 测试 (@you)"
 *
 *   raw.type === 'assistant/message' 时：
 *     raw.data = { turn, step, message:{role,content:[...]}, usage, stream }
 *     message.content 里混着多种块：reasoning（思考）、tool-call（工具调用）、
 *     text（真正说出口的话）—— **只取 text**，其余都不是"他说了什么"。
 *     usage 字段名：inputTokens / outputTokens / cacheReadTokens /
 *                  cacheWriteTokens / totalTokens
 *
 *   raw.type === 'agent/inbox/spliced' 时：
 *     是内部收件箱事件，用户消息也在里面出现过一份。**刻意忽略**它，
 *     否则同一条消息会被记两次。
 */
function extractMessage(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const type = raw.type;
  if (type !== 'user/message' && type !== 'assistant/message') return null;

  const data = raw.data;
  if (!data) return null;

  // 用户消息：content 直接在 data 上
  // 助手消息：content 在 data.message 里
  const content = type === 'assistant/message' ? data.message?.content : data.content;
  if (!content) return null;

  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      // 只收 text 块：reasoning 是思考过程、tool-call 是工具调用，都不是"说了什么"
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n');
  }
  if (!text.trim()) return null;
  // 过滤系统注入（详见 isNoise 的注释）
  if (isNoise(text.trim())) return null;

  // token 用量只在 assistant 事件上有
  let tokens = 0;
  if (type === 'assistant/message' && data.usage) {
    const u = data.usage;
    // 输入按未命中缓存的部分算更贴近实际花费，但这里保守用总量做额度闸门
    tokens = (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
  }

  return {
    role: type === 'user/message' ? 'user' : 'assistant',
    text: text.trim(),
    tokens,
    turn: data.turn ?? null,
  };
}

// ──────────────────────────────────────────────────────────── 主逻辑

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const log = (level, msg) => {
    const line = `[qqbot-memory] ${msg}`;
    if (level === 'error' && typeof ctx.logger?.error === 'function') ctx.logger.error(line);
    else if (typeof ctx.logger?.info === 'function') ctx.logger.info(line);
    else console.log(line);
  };

  const dirs = {
    history: () => join(cfg.dataDir, 'history'),
    usage: () => join(cfg.dataDir, 'usage'),
    files: () => cfg.dataDir,
  };

  async function ensureDir(dir) {
    try {
      await mkdir(dir, { recursive: true });
      return true;
    } catch (err) {
      log('error', `建目录失败 ${dir}: ${err?.message ?? err}`);
      return false;
    }
  }

  // ── 用量的读写（要跨重启有效，所以落盘）
  const usageCache = new Map();   // day -> { total, bySession: {} }

  async function loadUsage(day) {
    if (usageCache.has(day)) return usageCache.get(day);
    const file = join(dirs.usage(), `${day}.json`);
    let data = { day, total: 0, bySession: {} };
    try {
      if (existsSync(file)) {
        data = JSON.parse(await readFile(file, 'utf8'));
        if (typeof data.total !== 'number') data.total = 0;
        if (!data.bySession) data.bySession = {};
      }
    } catch (err) {
      // 读坏了就从零开始 —— 宁可少算，也不要因为统计文件损坏而拒绝服务
      log('error', `用量文件读失败（按 0 计）: ${err?.message ?? err}`);
    }
    usageCache.set(day, data);
    return data;
  }

  async function addUsage(sessionId, tokens) {
    if (!tokens || tokens <= 0) return;
    try {
      const day = localDay();
      const data = await loadUsage(day);
      data.total += tokens;
      data.bySession[sessionId] = (data.bySession[sessionId] ?? 0) + tokens;
      await ensureDir(dirs.usage());
      await writeFile(join(dirs.usage(), `${day}.json`), JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      log('error', `用量写入失败: ${err?.message ?? err}`);
    }
  }

  // ── 聊天记录（append-only JSONL）
  async function recordHistory(sessionId, entry) {
    if (!cfg.recordHistory) return;
    try {
      if (!(await ensureDir(dirs.history()))) return;
      const file = join(dirs.history(), `${safeName(sessionId)}.jsonl`);
      await appendFile(file, JSON.stringify(entry) + '\n', 'utf8');
    } catch (err) {
      log('error', `聊天记录写入失败: ${err?.message ?? err}`);
    }
  }

  // ── 读"别的会话"最近说了什么，用来拼共享记忆
  async function recentFromOtherSessions(currentId) {
    try {
      const dir = dirs.history();
      if (!existsSync(dir)) return [];
      const names = (await readdir(dir)).filter((n) => n.endsWith('.jsonl'));
      const withTime = [];
      for (const n of names) {
        if (safeName(currentId) === n.replace(/\.jsonl$/, '')) continue;   // 跳过自己
        try {
          const st = await stat(join(dir, n));
          withTime.push({ name: n, mtime: st.mtimeMs });
        } catch { /* 单个文件读不到就跳过 */ }
      }
      withTime.sort((a, b) => b.mtime - a.mtime);

      const out = [];
      for (const item of withTime.slice(0, cfg.shareRecentSessions)) {
        try {
          const raw = await readFile(join(dir, item.name), 'utf8');
          const lines = raw.split('\n').filter(Boolean).slice(-cfg.shareRecentTurns * 2);
          const turns = [];
          for (const line of lines) {
            try {
              const e = JSON.parse(line);
              if (e && e.text) turns.push(`${e.role === 'user' ? '对方' : '你'}：${clip(e.text, 300)}`);
            } catch { /* 跳过坏行 */ }
          }
          if (turns.length) out.push({ session: item.name.replace(/\.jsonl$/, ''), turns });
        } catch { /* 跳过读不到的文件 */ }
      }
      return out;
    } catch (err) {
      log('error', `读历史失败: ${err?.message ?? err}`);
      return [];
    }
  }

  // ══════════════════════════════════════════════════════════
  // 钩子一：记录 + 统计
  // ══════════════════════════════════════════════════════════
  ctx.on('session/event', async (session, raw) => {
    try {
      const sessionId = session?.header?.id ?? session?.id;
      if (!sessionId) return;

      const msg = extractMessage(raw);
      if (!msg) return;

      await recordHistory(sessionId, {
        ts: stamp(),
        role: msg.role,
        text: clip(msg.text, cfg.maxTextChars),
        ...(msg.turn !== null ? { turn: msg.turn } : {}),
        ...(msg.tokens ? { tokens: msg.tokens } : {}),
      });

      // token 用量（字段名实测为 inputTokens/outputTokens，不是 input/output —— 第一版就栽在这）
      if (msg.tokens > 0) await addUsage(sessionId, msg.tokens);
    } catch (err) {
      // 记账失败绝不能影响对话
      log('error', `session/event 处理失败: ${err?.message ?? err}`);
    }
  });

  // ══════════════════════════════════════════════════════════
  // 钩子二：超额拦截（在组装请求前判断）
  // ══════════════════════════════════════════════════════════
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next();
    try {
      if (!cfg.dailyTokenLimit || cfg.dailyTokenLimit <= 0) return assembled;

      const day = localDay();
      const data = await loadUsage(day);
      if (data.total < cfg.dailyTokenLimit) return assembled;

      log('error', `今日额度已用尽: ${data.total}/${cfg.dailyTokenLimit}（${day}）`);
      if (cfg.overLimitAction !== 'block') return assembled;

      return {
        ...assembled,
        sections: [
          ...(assembled.sections ?? []),
          {
            name: 'qqbot-memory:over-limit',
            order: 999,
            text:
              '【今天先到这儿】今天已经聊了很多，你有点累了，想歇会儿。'
              + '如果有人跟你说话，就用一句话礼貌地收尾（说明天再聊、或者让他回头再说），'
              + '**不要展开任何新话题、不要回答问题本身、不要调用任何工具**。'
              + '说得自然一点，像真累了那样，别解释原因。',
          },
        ],
      };
    } catch (err) {
      // 限额判断出错时**放行** —— 宁可多花点钱，也不要因为统计故障把正常用户挡在门外
      log('error', `额度检查失败（放行）: ${err?.message ?? err}`);
      return assembled;
    }
    // ⚠️ { global: true } **不是可选的**：system-prompt/assemble 是按作用域触发的
    // （源码里用 ctx.waterfall(scopeTarget(this, scope), 'system-prompt/assemble', ...)
    // 调用），不带这个选项就收不到事件 —— 表现是"插件加载了、监听也注册了，
    // 但注入永远不生效"，且不报任何错。对照 dsh-system-prompt/lib/invariant.js
    // 的注册方式才发现的。
  }, { global: true });

  // ══════════════════════════════════════════════════════════
  // 钩子三：共享记忆注入
  // ══════════════════════════════════════════════════════════
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next();
    try {
      const sessionId = context?.session?.header?.id ?? context?.session?.id;
      if (!sessionId) return assembled;

      const others = await recentFromOtherSessions(sessionId);
      if (!others.length) return assembled;

      const blocks = others.map((o) => {
        const head = `— 会话 ${o.session}（另一处场合）—`;
        return [head, ...o.turns.map((t) => '  ' + t)].join('\n');
      });

      const text = [
        '【其它场合的近期对话】',
        '以下内容来自**同一个人的其它会话**（另一个群或私聊）。',
        '你可以据此认为"记得"这些事，但要注意：',
        '1. **不要主动说破**你从别处看到 —— 自然地带进去就行，别说"我看了记录"。',
        '2. 如果对方明显不认识你提到的内容，就**别硬认**，当作没这回事。',
        '3. 这些只是片段，可能不全，**别当成完整事实**去纠正对方。',
        '',
        ...blocks,
      ].join('\n');

      return {
        ...assembled,
        sections: [
          ...(assembled.sections ?? []),
          { name: 'qqbot-memory:shared', order: 95, text },
        ],
      };
    } catch (err) {
      log('error', `共享记忆注入失败: ${err?.message ?? err}`);
      return assembled;
    }
  }, { global: true });

  // 启动自检：把关键配置打在日志里，方便排查"为什么没生效"
  (async () => {
    const ok = await ensureDir(cfg.dataDir);
    log('info', `已加载。dataDir=${cfg.dataDir} 可写=${ok} `
      + `记录历史=${cfg.recordHistory} 每日额度=${cfg.dailyTokenLimit || '不限'} `
      + `超额动作=${cfg.overLimitAction}`);

    // ── 注册"按工作流看图"的工具
    //
    // 视觉的 provider/model 不从本插件配置里重新填一遍，而是**读 profile 的
    // cordis.patch.yml 里 im-qqbot 那一份** —— 只留一个真相源，
    // 避免两处配置各说各话。
    try {
      const patchPath = join(cfg.profileDir, 'cordis.patch.yml');
      if (existsSync(patchPath)) {
        const entries = yaml.load(await readFile(patchPath, 'utf8'));
        if (Array.isArray(entries)) {
          for (const entry of entries) {
            if (entry?.id === 'im-qqbot' && entry.config?.vision?.enabled) {
              const visionCfg = {
                provider: entry.config.vision.provider,
                model: entry.config.vision.model,
                maxTokens: entry.config.vision.maxTokens,
              };
              const registered = registerLookTool(ctx, cfg, {
                info: (m) => log('info', m),
                warn: (m) => log('error', m),
              }, visionCfg);
              log('info', registered ? 'qqbot_look 注册成功' : 'qqbot_look 未注册（见上面的原因）');
              break;
            }
          }
        }
      } else {
        log('error', `读不到 ${patchPath}，qqbot_look 未注册`);
      }
    } catch (err) {
      log('error', `注册 qqbot_look 失败: ${err?.message ?? err}`);
    }
  })();
}
