/**
 * draw-tool —— `qqbot_draw`：**画大肥鱼本人**（或指定的 LoRA 角色）。
 *
 * ════════════════════════════════════════════════════════════════
 * 它跟 `qqbot_paint` 的分工（别混）
 * ════════════════════════════════════════════════════════════════
 *
 *   `qqbot_paint`  —— **免费**线路（Cloudflare flux-schnell 主 + 智谱 CogView 兜底）。
 *                     适合氛围图 / 抽象主体 / 贴纸；**画不准具体角色**。
 *
 *   `qqbot_draw`   —— **花钱**线路（Civitai Orchestration + LoRA）。
 *                     画大肥鱼本人时**特征是对的**（LoRA 就是在原版设定上训的）。
 *                     实测 832×1216 / 28 步 ≈ **28.5 秒 / 4 Buzz**。
 *
 * ⚠️ **两道闸（比 paint 更严，因为这条要花钱）**：
 *   ① **仅超管**（`drawOnlyAdmin`，默认 true）；
 *   ② **每日上限**（`drawDailyLimit`，默认 10 张 = 约 40 Buzz/天）—— 超了直接拒绝、不发请求。
 *   另外沿用 paint 的**内容闸**（色情 / 暴力 / 真人肖像那三类词）。
 *
 * ⚠️ **本鱼不代充**：Buzz 用完了就照实说"额度用完了"，不充值、不劝充值。
 *
 * 参数与 AIR URN 出自 `E:\deepseek workspace\acg生图\大肥鱼形象-参考\LoRA-现役清单-20261006.md` §八。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { screenPrompt } from './paint-tool.js';

export const DRAW_TOOL_NAME = 'qqbot_draw';

const KEYS = '/home/ubuntu/.qqbot-keys';
const ENDPOINT = 'https://orchestration.civitai.com/v2/consumer/workflows';

/** 底模：WAI-illustrious-HSWQ v17.0（超管 2026-10-06 拍板"就用它，不再试"） */
const CHECKPOINT = 'urn:air:sdxl:checkpoint:civitai:2698106@3029789';
/** LoRA A：小鲸鱼（大肥鱼）Illustrious 版 —— 少女版 */
const LORA_SHOJO = 'urn:air:sdxl:lora:civitai:2697171@3218534';
/** LoRA B：Q版娘{大肥鲸} Illustrious 版 —— Q 版 */
const LORA_CHIBI = 'urn:air:sdxl:lora:civitai:2971142@3366955';

/**
 * 角色触发词（LoRA 作者页给的）+ 质量前缀。
 * ⚠️ 这些是**实测出过图**的那套（2026-10-06，视觉链六项全确证），别随手改。
 */
const CHAR_TAGS = {
  shojo: 'deepseek whale girl, blue gradient hair, ahoge, fin ears, whale tail, '
    + 'dark blue maid dress, white apron, white maid headdress, white thighhighs, mary janes',
  chibi: 'chibi, deepseek whale girl, blue gradient hair, ahoge, fin ears, whale tail, '
    + 'dark blue maid dress, white apron',
};

const QUALITY = 'masterpiece, best quality, very aesthetic, absurdres, ';
const NEG = 'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, '
  + 'fewer digits, cropped, worst quality, low quality, jpeg artifacts, signature, watermark, '
  + 'username, artist name, blurry, nsfw';

const DESCRIPTION =
  'Draw **Taifeiyu herself** (or a specified LoRA character) through Civitai\'s hosted SDXL + LoRA. '
  + 'Use this when the picture must actually look like her — the plain qqbot_paint route cannot do that '
  + '(it is a fast free model with no character knowledge). '
  + 'Costs real money (about 4 Buzz per image), so it is admin-only and has a small daily cap. '
  + 'Scene/style go in `prompt` (English). The character tags are added for you. '
  + 'Pass `pose` to describe pose/expression/background only, keeping it short.';

function key(name) {
  try {
    return readFileSync(join(KEYS, name), 'utf8').trim();
  } catch {
    return '';
  }
}

function localDay() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function usagePath(dataDir) { return join(dataDir, 'draw-usage.json'); }

function readUsage(dataDir) {
  try {
    const o = JSON.parse(readFileSync(usagePath(dataDir), 'utf8'));
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

function bumpUsage(dataDir, day) {
  const u = readUsage(dataDir);
  u[day] = Number(u[day] ?? 0) + 1;
  try {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    writeFileSync(usagePath(dataDir), JSON.stringify(u, null, 2), 'utf8');
  } catch { /* 记不上账不能挡生成 —— 与本插件一贯口径一致 */ }
  return u[day];
}

/** 拼最终提示词：质量前缀 + 用户场景 + 角色触发词（角色词放最后，权重更稳） */
export function buildPrompt(variant, prompt) {
  const who = CHAR_TAGS[variant] ?? CHAR_TAGS.shojo;
  const scene = String(prompt ?? '').trim().replace(/[,\s]+$/, '');
  return `${QUALITY}${scene ? scene + ', ' : ''}${who}`;
}

export function registerDrawTool(ctx, cfg, logger, deps = {}) {
  const tools = (() => { try { return ctx.get('tools'); } catch { return undefined; } })();
  if (!tools?.register) {
    logger?.warn?.('拿不到 tools 服务，qqbot_draw 未注册');
    return false;
  }
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const resolveSpeaker = deps.resolveSpeaker;
  const onlyAdmin = cfg.drawOnlyAdmin !== false;
  const dailyLimit = Number(cfg.drawDailyLimit ?? 10);

  tools.register({
    name: DRAW_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'What is happening: pose / expression / background / mood. English, comma separated, keep it short. Do NOT describe her look — that is added automatically.',
        },
        variant: {
          type: 'string',
          description: 'Which design: "shojo" (the default 7-head-tall girl) or "chibi" (Q version).',
        },
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
      // ⚠️ 少了 render，注册阶段就会失败（只在服务日志里报，node --check 查不出）。
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args = {}, exec) {
      // ── 闸 ①：仅超管
      const sp = (() => {
        try { return resolveSpeaker?.(exec) ?? null; } catch { return null; }
      })();
      const admins = (cfg.adminOpenIds ?? []).map((s) => String(s).toUpperCase());
      if (onlyAdmin && (!sp?.openid || !admins.includes(String(sp.openid).toUpperCase()))) {
        return { text: '（画本鱼自己这条线要花钱，只对超管开放。想要图可以让超管说一声。）' };
      }

      // ── 内容闸（跟 paint 同一套词表；screenPrompt 返回 {ok, hit}）
      const raw = String(args.prompt ?? '').trim();
      const scr = screenPrompt(`${raw} ${args.variant ?? ''}`);
      if (scr && scr.ok === false) {
        return { text: `（这条不画：命中了内容闸的「${scr.hit ?? '敏感词'}」。换个题材。）` };
      }

      // ── 闸 ②：每日上限
      const day = localDay();
      const used = Number(readUsage(cfg.dataDir)[day] ?? 0);
      if (dailyLimit > 0 && used >= dailyLimit) {
        const warn = used === dailyLimit ? '（这是今天的最后一张额度了。）' : '';
        return { text: `（今天已经画了 ${used} 张（每日上限 ${dailyLimit}）。明天再画。）${warn}` };
      }

      const apiKey = key('civitai.txt');
      if (!apiKey) return { text: '（没读到 Civitai 凭据，画不了。凭据在 ~/.qqbot-keys/civitai.txt。）' };

      const variant = String(args.variant ?? 'shojo').trim().toLowerCase();
      const lora = variant === 'chibi' ? LORA_CHIBI : LORA_SHOJO;
      const body = {
        steps: [{
          $type: 'imageGen',
          input: {
            engine: 'sdcpp',
            ecosystem: 'sdxl',
            operation: 'createImage',
            model: CHECKPOINT,
            loras: { [lora]: 1.0 },
            prompt: buildPrompt(variant === 'chibi' ? 'chibi' : 'shojo', raw),
            negativePrompt: NEG,
            width: 832,
            height: 1216,
            cfgScale: 5.5,
            steps: 28,
            quantity: 1,
          },
        }],
      };

      let resp;
      try {
        resp = await fetchImpl(`${ENDPOINT}?wait=90`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        return { text: `（连不上 Civitai：${String(err?.message ?? err).slice(0, 160)}。**别重试**，过一会儿再说。）` };
      }

      const text = await resp.text();
      if (!resp.ok) {
        // ⚠️ 照实回报，别重试 —— 当天实测：余额不足 / 参数不被接受时重试没有任何不同结果。
        return { text: `（Civitai 返回 HTTP ${resp.status}：${text.slice(0, 240)}。别重试，把这句话转告超管。）` };
      }

      let data;
      try { data = JSON.parse(text); } catch { return { text: '（Civitai 回了个解析不了的东西，画不了。）' }; }
      const url = data?.steps?.[0]?.output?.images?.[0]?.url;
      if (!url) {
        const status = data?.status ?? '未知';
        return { text: `（还没画完（状态 ${status}）。**别立刻重试**，等十几秒再试一次。）` };
      }

      // 下载成文件，落盘后交给 qqbot_send_file 发（跟 paint 同一套链路）
      let buf;
      try {
        const img = await fetchImpl(url);
        if (!img.ok) throw new Error(`HTTP ${img.status}`);
        buf = Buffer.from(await img.arrayBuffer());
      } catch (err) {
        return { text: `（图画好了但下载失败：${String(err?.message ?? err).slice(0, 120)}。链接：${url}）` };
      }

      const n = bumpUsage(cfg.dataDir, day);
      const dir = join(cfg.dataDir, 'draw');
      try {
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const file = join(dir, `draw-${Date.now()}.png`);
        writeFileSync(file, buf);
        return {
          text: `画好了（本鱼本人 · ${variant === 'chibi' ? 'Q 版' : '少女版'}，${Math.round(buf.length / 1024)} KB，`
            + `今日第 ${n}/${dailyLimit} 张，约 4 Buzz）。\n`
            + `**下一步**：调用 qqbot_send_file，file_path 填这个路径，否则对方只看到一行路径：\n${file}`,
        };
      } catch (err) {
        return { text: `（图画好了但存不下来：${String(err?.message ?? err).slice(0, 120)}。链接：${url}）` };
      }
    },
  });

  logger?.info?.(`qqbot_draw 工具已注册（本鱼本人 · 仅超管=${onlyAdmin} · 每日 ${dailyLimit} 张 · Civitai + LoRA）`);
  return true;
}
