/**
 * paint-tool.js —— 云端生图（T-003，2026-10-06）
 *
 * ════════════════════════════════════════════════════════════════
 * 两条线路，按饲主拍板的顺序
 * ════════════════════════════════════════════════════════════════
 *
 *   ① **主：Cloudflare Workers AI `flux-1-schnell`** —— 免费额度 **10,000 neurons/天**
 *      （官方价表：4.80 neurons/512² tile ＋ 9.60 neurons/step ⇒ 512² 约 230 张/天、
 *      1024² 约 170 张/天）。凭据：`~/.qqbot-keys/cf-account-id.txt` + `cf-api-token.txt`。
 *      返回 JSON：`{"result":{"image":"<base64 JPEG>"}}`（**实测**，不是猜的）。
 *   ② **兜底：智谱 `CogView-3-Flash`** —— 官方文档原话「是智谱推出的免费图像生成模型」。
 *      凭据：`~/.qqbot-keys/zai-api-key.txt`。返回 `{"data":[{"url":"..."}]}`（**实测**）。
 *   **① 任何非 200 / 缺凭据 / 额度用尽 ⇒ 自动转 ②**，两条都挂才报错。
 *
 * ════════════════════════════════════════════════════════════════
 * 四道闸（饲主 2026-10-06 确认的方案，一条都不省）
 * ════════════════════════════════════════════════════════════════
 *
 *   ① **凭据只从钥匙目录读**，不进日志、不进返回值、不进仓库。
 *   ② **每日硬上限**（默认 10 张，`paintDailyLimit`）—— 超了**直接拒绝**，不发请求。
 *      计数落 `<dataDir>/paint-usage.json`（按本地日期分桶，跨重启有效）。
 *   ③ **仅超管**（`paintOnlyAdmin` 默认 true）—— 与 `qqbot_alarm` / `qqbot_say` 同一道闸。
 *   ④ **内容闸**：先过一层关键词黑名单（色情/暴力/真人肖像），再过一家云自己的内容安全。
 *      ⚠️ **没有这道闸就等于给全群开了一台违规生成器，被举报是封号/封群级别。**
 *      这层闸只能挡"明显"的，**挡不住绕着说的** —— 所以还有第④条的下半句：
 *      **只对超管开放**，群友想要的图由超管转述。
 *
 * ════════════════════════════════════════════════════════════════
 * 它**只负责生成**，不负责发
 * ════════════════════════════════════════════════════════════════
 *
 * 生成后把**绝对路径**返回给模型，由它再调 `qqbot_send_file` 发出去
 * （那条链路本来就通，而且带路径白名单校验）。工具描述里写明了这一步，别漏。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PAINT_TOOL_NAME = 'qqbot_paint';

const KEYS = '/home/ubuntu/.qqbot-keys';
const CF_MODEL = '@cf/black-forest-labs/flux-1-schnell';
const ZHIPU_URL = 'https://open.bigmodel.cn/api/paas/v4/images/generations';

/**
 * 内容闸 —— 关键词黑名单。
 * ⚠️ 这是**粗筛**，不是万能的：它挡"明说的"，挡不住绕着说的。
 * 真正的第二层是云厂商自己的内容安全，第三层是"只对超管开放"。
 * 别把这张表当成安全保证，它的作用是**让明显的请求连请求都不发**。
 */
const BLOCKED = [
  // 色情 / 裸露
  'nsfw', 'r18', 'r-18', 'porn', 'nude', 'naked', 'hentai', 'ero', '色情', '裸', '全裸', '露点',
  '做爱', '性爱', '涩图', '色图', '黄图', '未成年', '萝莉控', '幼女',
  // 暴力 / 血腥
  'gore', '血腥', '断肢', '肢解', '虐杀', '自杀', '尸体', '爆头',
  // 真人肖像（现实人物）
  '真人照片', '明星', '演员', '网红', '政要', '习近平', '普京', '特朗普', '马斯克',
];

const DESCRIPTION =
  'Generate an image from a text prompt (cloud API: Cloudflare FLUX first, Zhipu CogView as fallback). '
  + '**Admin only.** The result is a file path — you MUST then call `qqbot_send_file` with that path '
  + 'to actually show it in the chat. Keep the prompt in English when possible, descriptive, and safe: '
  + 'no sexual content, no gore, no real people. Do NOT retry on failure; tell the owner what failed.';

function key(name) {
  try {
    return readFileSync(join(KEYS, name), 'utf8').trim();
  } catch {
    return '';
  }
}

/** 过一遍内容闸；返回 null 表示放行，否则返回拒绝原因 */
export function screenPrompt(prompt) {
  const p = String(prompt ?? '').toLowerCase();
  if (p.trim().length < 2) return '提示词太短';
  if (p.length > 800) return '提示词太长（800 字以内）';
  for (const w of BLOCKED) {
    if (p.includes(w.toLowerCase())) return `提示词里有不允许的内容（命中「${w}」）`;
  }
  return null;
}

/** 每日计数（按本地日期分桶，跨重启有效） */
function usagePath(dataDir) { return join(dataDir, 'paint-usage.json'); }
export function readUsage(dataDir) {
  try {
    const f = usagePath(dataDir);
    if (!existsSync(f)) return {};
    const o = JSON.parse(readFileSync(f, 'utf8'));
    return o && typeof o === 'object' ? o : {};
  } catch { return {}; }
}
function bumpUsage(dataDir, day) {
  const u = readUsage(dataDir);
  u[day] = (u[day] ?? 0) + 1;
  try { writeFileSync(usagePath(dataDir), JSON.stringify(u, null, 2), 'utf8'); } catch { /* 记不上账不能挡生成 */ }
  return u[day];
}
function localDay() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 主线路：Cloudflare Workers AI */
async function paintCloudflare(prompt) {
  const acct = key('cf-account-id.txt');
  const token = key('cf-api-token.txt');
  if (!acct || !token) throw new Error('CF 凭据不在（cf-account-id.txt / cf-api-token.txt）');
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/${CF_MODEL}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, steps: 4 }),
      signal: AbortSignal.timeout(90000),
    },
  );
  const text = await r.text();
  if (!r.ok) throw new Error(`CF HTTP ${r.status} ${text.slice(0, 160)}`);
  let b64;
  try { b64 = JSON.parse(text)?.result?.image; } catch { throw new Error(`CF 返回不是 JSON：${text.slice(0, 120)}`); }
  if (!b64) throw new Error(`CF 返回里没有 result.image：${text.slice(0, 120)}`);
  return Buffer.from(b64, 'base64');
}

/** 兜底线路：智谱 CogView-3-Flash（免费模型） */
async function paintZhipu(prompt) {
  const k = key('zai-api-key.txt');
  if (!k) throw new Error('智谱凭据不在（zai-api-key.txt）');
  const r = await fetch(ZHIPU_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'cogview-3-flash', prompt, size: '1024x1024' }),
    signal: AbortSignal.timeout(90000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`智谱 HTTP ${r.status} ${text.slice(0, 160)}`);
  let url;
  try { url = JSON.parse(text)?.data?.[0]?.url; } catch { throw new Error(`智谱返回不是 JSON：${text.slice(0, 120)}`); }
  if (!url) throw new Error(`智谱返回里没有 data[0].url：${text.slice(0, 120)}`);
  const img = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!img.ok) throw new Error(`下图失败 HTTP ${img.status}`);
  return Buffer.from(await img.arrayBuffer());
}

/**
 * 注册工具。
 *
 * @param {object} ctx
 * @param {object} cfg  插件配置（paintDailyLimit / paintOnlyAdmin / paintEnabled / dataDir）
 * @param {object} logger
 * @param {object} deps
 * @param {(exec:object)=>object|null} deps.resolveSpeaker  判定超管
 * @param {(prompt:string)=>{buf:Buffer,provider:string}} [deps.providers] 注入假出图（自测用）
 */
export function registerPaintTool(ctx, cfg, logger, deps = {}) {
  const tools = (() => { try { return ctx.get('tools'); } catch { return undefined; } })();
  if (!tools?.register) {
    logger?.warn?.('拿不到 tools 服务，qqbot_paint 未注册');
    return false;
  }

  const dailyLimit = Number(cfg.paintDailyLimit ?? 10);
  const onlyAdmin = cfg.paintOnlyAdmin !== false;
  const resolveSpeaker = deps.resolveSpeaker;

  const outDir = join(cfg.dataDir, 'paint');

  tools.register({
    name: PAINT_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to draw. English works best. Describe subject + style + background.' },
        reason: { type: 'string', description: 'Optional: why (for the log).' },
      },
      required: ['prompt'],
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
      if (cfg.paintEnabled === false) return { text: '（生图功能当前是关着的。）' };

      // ── 闸门③：仅超管
      if (onlyAdmin) {
        let sp = null;
        try { sp = resolveSpeaker?.(exec) ?? null; } catch { /* 认不出=拒绝 */ }
        const admins = (cfg.adminOpenIds ?? []).map((s) => String(s).toUpperCase());
        if (!sp?.openid || !admins.includes(String(sp.openid).toUpperCase())) {
          return { text: '（生图只有超管能用。想要图的话跟超管说一声。）' };
        }
      }

      // ── 闸门④：内容
      const prompt = String(args.prompt ?? '').trim();
      const bad = screenPrompt(prompt);
      if (bad) return { text: `（这张本鱼不画：${bad}。）` };

      // ── 闸门②：每日硬上限（超了**连请求都不发**）
      const day = localDay();
      const used = readUsage(cfg.dataDir)[day] ?? 0;
      if (dailyLimit > 0 && used >= dailyLimit) {
        return { text: `（今天已经画了 ${used} 张，到上限了（每日 ${dailyLimit} 张）。明天再画。）` };
      }

      // ── 出图：主 → 兜底（两个 provider 都可注入，方便自测兜底链）
      let buf = null;
      let provider = '';
      const errors = [];
      const useCf = deps.cf ?? paintCloudflare;
      const useZhipu = deps.zhipu ?? paintZhipu;
      try {
        buf = await useCf(prompt);
        provider = 'cloudflare/flux-1-schnell';
      } catch (e1) {
        errors.push(String(e1?.message ?? e1).slice(0, 200));
        try {
          buf = await useZhipu(prompt);
          provider = 'zhipu/cogview-3-flash';
        } catch (e2) {
          errors.push(String(e2?.message ?? e2).slice(0, 200));
        }
      }
      if (!buf || buf.length === 0) {
        return { text: `画不出来。两条线路都失败了：${errors.join(' ｜ ')}` };
      }

      // ── 落盘
      try {
        if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
        const file = join(outDir, `paint-${ts}-${Math.random().toString(36).slice(2, 6)}.jpg`);
        writeFileSync(file, buf);
        const n = bumpUsage(cfg.dataDir, day);
        logger?.info?.(`qqbot_paint: ${provider} 出图 ${buf.length} B → ${file}（今日第 ${n} 张）`);
        return {
          text: `画好了（${provider}，${Math.round(buf.length / 1024)} KB，今日第 ${n}/${dailyLimit} 张）。\n`
            + `图片路径：${file}\n`
            + '**现在必须再调一次 `qqbot_send_file`**（`file_path` 填上面这个路径）把它发出去 —— '
            + '只返回路径对方是看不到图的。',
        };
      } catch (err) {
        return { text: `画出来了但存盘失败：${String(err?.message ?? err).slice(0, 160)}` };
      }
    },
  });

  logger?.info?.(`qqbot_paint 工具已注册（仅超管=${onlyAdmin} 每日上限=${dailyLimit} 张；CF 主 + 智谱兜底）`);
  return true;
}
