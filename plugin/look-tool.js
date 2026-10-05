/**
 * 给 qqbot-memory 插件加一个「按工作流看图」的工具。
 *
 * ════════════════════════════════════════════════════════════════════
 * 为什么需要它（一段绕了三轮的弯路，值得写下来）
 * ════════════════════════════════════════════════════════════════════
 *
 * 本机那套识图体系有两条铁律，其中一条是「看细节必须裁图放大」。为了把这套
 * 工作流搬给 QQ bot，最初的做法是：写个 imgtool.py 放在 tools 目录，再在人格里
 * 要求模型「看图前先跑脚本裁图」。
 *
 * **实测不成立**。模型一直报「命令被沙箱拦着，裁图放大做不了」，于是退回整图问
 * ——而整图问的后果是实测过的：会把两层衣服合并成一件、还编出不存在的细节。
 *
 * 拦的原因：dsh 的 sandbox workspace 根 = **启动进程的 cwd**，而机器人的 cwd 是
 * E:\dsh-qqbot\work，脚本却在 E:\dsh-qqbot\tools ⇒ 在根之外 ⇒ 写入被拒。
 * 试过三种配置修法（sandbox-policy.mode / permission.defaultPreset / 把 cwd 提到
 * 上一级），都没能让它稳定地跑起来。
 *
 * ⇒ 结论：**别再指望模型在受限环境里自己完成"跑脚本 + 裁图 + 追问"这套多步操作。**
 *    把这件事收进插件：插件跑在主进程，没有沙箱限制，能自由读写文件、能起
 *    子进程；对模型来说它只是一个普通工具调用。
 *
 *    这也是本项目第二次得出同一个教训：
 *      跨会话记忆 → 靠提示词让模型自觉读文件 = 失败；改成事件钩子硬编码 = 成功
 *      看图工作流 → 靠提示词让模型自觉跑脚本 = 失败；改成插件内实现 = 本文件
 * ════════════════════════════════════════════════════════════════════
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const LOOK_TOOL_NAME = 'qqbot_look';

const PYTHON = 'C:\\Users\\xia54\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';
const IMGTOOL = 'E:\\dsh-qqbot\\tools\\imgtool.py';
/** Real-ESRGAN 超分脚本（走 ComfyUI 的 API；本机 ComfyUI 在 E:\dsh-ai） */
const UPSCALE_PY = 'C:\\Users\\xia54\\.dsh\\comfy-tools\\upscale.py';
/** trace.moe 反向搜图脚本（识别动画截图；本机唯一可达的反向搜图服务） */
const TRACEMOE_PY = 'E:\\dsh-qqbot\\tools\\trace-moe.py';
/** 定位主体时把图切成 GRID×GRID 个带编号的格子（让模型选格子，而不是读坐标） */
const GRID = 4;

const DESCRIPTION =
  'Look at an image properly, following this project\'s verified workflow. '
  + 'Unlike qqbot_describe_image (which asks the vision model about the WHOLE image and '
  + 'measurably gets fine details wrong), this tool first measures the image, crops and '
  + 'enlarges the relevant regions, samples real pixel colors with an algorithm, and only '
  + 'then asks the model about those enlarged regions. '
  + 'Pass a precise `question`. Use this for ANY question about an image the user sent: '
  + 'describing it, reading text, identifying clothing/colors/counts, comparing regions. '
  + 'Set `regions` only when you already know which boxes matter; otherwise omit it and '
  + 'the tool decides.';

/** 跑 imgtool 子命令，返回解析成对象的键值对 */
async function runImgtool(sub, args) {
  const { stdout } = await execFileAsync(PYTHON, [IMGTOOL, sub, ...args], {
    timeout: 60000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  const out = {};
  const list = [];
  for (const raw of String(stdout).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;             // 颜色行
    if (line.startsWith('-') || line.startsWith('tile=')) { list.push(line); continue; }
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  out._lines = list;
  return out;
}

/** 给一个 Promise 套超时。超时抛错，由调用方降级处理。 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${Math.round(ms / 1000)}s）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** 调视觉模型（与 dsh-qqbot 内部同样的服务） */
async function askVision(llm, attachments, provider, model, maxTokens, imagePath, prompt, signal) {
  const { BlockAssembler, createUserMessage } = await import('@deepseek-ai/dsh-llm');
  const bytes = await readFile(imagePath);
  if (bytes.length === 0) throw new Error('empty image');

  const ref = await attachments.saveImage({
    data: new Uint8Array(bytes),
    mediaType: imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg',
    name: basename(imagePath),
  });

  const message = createUserMessage({
    content: [
      { type: 'image', attachment: ref },
      { type: 'text', text: prompt },
    ],
    source: { kind: 'plugin', plugin: 'qqbot-memory' },
  });

  const assembler = new BlockAssembler();
  // 注意： 必须自己设超时。第一版没设，实测后果是：视觉 API 一慢（或某张裁块有问题）
  // 这里就无限期干等 —— 表现是「一轮对话 5 分钟没结果，全是报错」。
  // 90 秒足够一次正常的看图；超时就抛错，由上层降级成"这一块没看成"，
  // 至少把其它块的结果交出去，而不是整轮卡死。
  await withTimeout(
    (async () => {
      for await (const chunk of llm.stream({
        provider, model, messages: [message], maxTokens, signal,
      })) {
        assembler.push(chunk);
      }
    })(),
    90_000,
    '看图',
  );
  const blocks = assembler.blocks().filter((b) => b.type === 'text').map((b) => b.text);
  return blocks.join(' ').trim();
}

/**
 * 注册工具。所有失败都降级成"带说明的文本结果"，不抛给模型 ——
 * 工具报错会让整轮对话失败，而"这次没看清"是可接受的降级。
 */
export function registerLookTool(ctx, cfg, logger, visionCfg) {
  const tools = (() => { try { return ctx.get('tools'); } catch { return undefined; } })();
  const llm = (() => { try { return ctx.get('llm'); } catch { return undefined; } })();
  const attachments = (() => { try { return ctx.get('attachments'); } catch { return undefined; } })();

  if (!tools?.register) {
    logger.warn('qqbot-memory: tools 服务不可用，qqbot_look 未注册');
    return false;
  }
  if (!llm?.stream || !attachments?.saveImage) {
    logger.warn('qqbot-memory: llm/attachments 服务不可用，qqbot_look 未注册');
    return false;
  }
  if (!visionCfg?.provider || !visionCfg?.model) {
    logger.warn('qqbot-memory: 没拿到视觉 provider/model，qqbot_look 未注册');
    return false;
  }
  if (!existsSync(IMGTOOL)) {
    logger.warn('qqbot-memory: 找不到 imgtool.py（' + IMGTOOL + '），qqbot_look 未注册');
    return false;
  }

  const definition = {
    name: LOOK_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        image: {
          type: 'string',
          description: 'Absolute path of the local image file (the QQ bot saves received images to disk and gives you the path).',
        },
        question: {
          type: 'string',
          description: 'What you need to know about the image. Be specific: "describe the clothing layer by layer", "transcribe all text", "what color is the cape".',
        },
        regions: {
          type: 'array',
          description: 'Optional. Boxes to inspect, each "x1,y1,x2,y2" in ORIGINAL pixels. Omit and the tool picks regions itself.',
          items: { type: 'string' },
        },
      },
      required: ['image', 'question'],
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
      const image = String(args.image ?? '');
      const question = String(args.question ?? '描述这张图');
      if (!image || !existsSync(image)) {
        return { text: '（看图失败：找不到图片文件 ' + image + '）' };
      }

      // 注意： 必须先把输出目录建出来。
      // 第一版漏了这一步，实测的失败现象是：工具"跑挂了"，因为裁块要写到
      // <dataDir>\look\ 而那个目录不存在（imgtool 的 crop 不建父目录）。
      // 模型当时的报告很准："它建不了自己的输出目录，脚本写不进去"。
      const lookDir = join(cfg.dataDir, 'look');
      try {
        await mkdir(lookDir, { recursive: true });
      } catch (err) {
        return { text: '（看图失败：建不了输出目录 ' + lookDir + ' —— ' + String(err?.message ?? err) + '）' };
      }

      const notes = [];
      let size;
      try {
        size = await runImgtool('size', [image]);
        notes.push(`原图 ${size.width}×${size.height}（${size.megapixels} MP）`);
      } catch (err) {
        // 连尺寸都量不出来 —— 退回整图问，但明确标注
        const t = await askVision(llm, attachments, visionCfg.provider, visionCfg.model,
          visionCfg.maxTokens ?? 2048, image, question, exec.signal);
        return { text: `（无法调用算法层，以下为整图直接问的结果，细节可能不准）\n\n${t}` };
      }

      // ══════════════════════════════════════════════════════════
      // 第 1 步：定位主体（不是按固定比例切！）
      //
      // 注意： 这里换过一次做法，理由是实测：
      //   旧做法按构图固定切块（横图左右切、竖图上中下切）。问题是**切哪由比例决定，
      //   而不是由"人物在哪"决定** —— 结果把站在画面中间的人物正好切在接缝上，
      //   每块只看到半个人，模型就对残缺信息脑补，两块给出互相打架的说法
      //   （实测："一块说银白心形胸甲，另一块说白缎短上衣配红飘带"）。
      //   那不是多模型分歧，是切法制造出来的假冲突。
      //   也试过纯算法找主体（grabCut）：对夜景插画它给出占 63% 的框，里面既有少女
      //   也有月亮、城市、樱花，而人物发梢反而被切掉 —— "前景"不等于"主体"。
      //
      //   正解：**让视觉模型照坐标网格报出主体的像素框**，再按那个框裁。
      // ══════════════════════════════════════════════════════════
      const w = Number(size.width), h = Number(size.height);
      const big = Number(size.megapixels) > 2;
      let subjectRegion = null;

      if (big) {
        try {
          const guide = join(lookDir, `${basename(image).replace(/\.[^.]+$/, () => '')}_guide.jpg`);
          await runImgtool('locate', [image, '--out', guide]);

          const boxPrompt =
            `这是一张被切成 ${GRID}x${GRID} 格子的图，每格左上角有黑底黄字的**格子编号**`
            + `（A1、A2 … 到 ${String.fromCharCode(64 + GRID)}${GRID}）。\n`
            + '请找出图中**最主要的人物或角色**（画面里最大、最完整的那个），'
            + '回答**他/她主要落在哪几个格子里**。\n'
            + '规则：\n'
            + '· 人物身体大部分在某格里，就算那一格；只蹭到一点边的不算。\n'
            + '· 从头顶到脚（或被画幅截断的位置）都要覆盖到。\n'
            + '· **不要**把大片背景（天空、树、地面、远处的建筑）算进去。\n'
            + '· 只要格子编号，用空格分开。例如：B2 B3 C2 C3\n'
            + '严格按这个格式回答，不要解释：CELLS=B2 B3 C2 C3';

          const raw = await askVision(llm, attachments, visionCfg.provider, visionCfg.model,
            300, guide, boxPrompt, exec.signal);

          // ── 把格子编号换算成像素框
          //
          // 注意： 这里从"让模型读坐标"改成了"让模型选格子"，改过两次：
          //   ① 最早让它照网格读 x1,y1,x2,y2 —— 对 5000×5000 的图它把左上角的叶子
          //      报成了主体（网格太粗，读数误差几百像素）；
          //   ② 加密网格之后，它在另一张图上干脆**没输出 BOX=**，定位直接失败，
          //      只好退回按构图切块（它当时的反馈："主体定位报错，自动框没生效"）。
          //   ⇒ **读数字太脆，选离散标签稳得多**。
          const labelRe = new RegExp(`\\b([A-${String.fromCharCode(64 + GRID)}])([1-${GRID}])\\b`, 'g');
          const cells = new Set();
          for (const mm of raw.matchAll(labelRe)) {
            cells.add(mm[1].toUpperCase() + mm[2]);
          }

          if (cells.size > 0) {
            const cw = w / GRID;
            const chh = h / GRID;
            let minC = GRID - 1, maxC = 0, minR = GRID - 1, maxR = 0;
            for (const cell of cells) {
              const r = cell.charCodeAt(0) - 65;
              const c = parseInt(cell.slice(1), 10) - 1;
              if (r < 0 || r >= GRID || c < 0 || c >= GRID) continue;
              minC = Math.min(minC, c); maxC = Math.max(maxC, c);
              minR = Math.min(minR, r); maxR = Math.max(maxR, r);
            }
            let x1 = Math.floor(minC * cw);
            let y1 = Math.floor(minR * chh);
            let x2 = Math.ceil((maxC + 1) * cw);
            let y2 = Math.ceil((maxR + 1) * chh);
            // 留 3% 余量，避免正好切在发梢/飘带上
            const mx = Math.round((x2 - x1) * 0.03);
            const my = Math.round((y2 - y1) * 0.03);
            x1 = Math.max(0, x1 - mx); y1 = Math.max(0, y1 - my);
            x2 = Math.min(w, x2 + mx); y2 = Math.min(h, y2 + my);
            subjectRegion = `${x1},${y1},${x2},${y2}`;
            notes.push(`主体框 ${subjectRegion}（模型选的格子：${[...cells].join(' ')}，共 ${cells.size} 格）`);
          } else {
            notes.push(`主体定位没选出格子（模型原话：${String(raw).slice(0, 60)}），退回按构图切块`);
          }
        } catch (err) {
          notes.push(`主体定位失败（${String(err?.message ?? err).slice(0, 300)}），退回按构图切块`);
        }
      }

      // ══════════════════════════════════════════════════════════
      // 第 2 步：决定要看哪几块 —— 定位成功就裁主体，否则退回构图切块
      // ══════════════════════════════════════════════════════════
      // 注意： 模型自己指定的区域**必须优先**，但**必须校验**。
      //
      // 踩过的坑（两个，都是实测暴露的）：
      //   ① 重构时把 args.regions 的处理删了 → 模型传了也没用。它的反馈很准：
      //      「调用方自己指定的区域它也没采纳」。工具忽略调用方明确给的东西，
      //      比多花一点钱严重得多 —— 模型以为在下钻，实际看的还是自动挑的那块。
      //   ② 加回来时忘了夹到图内 → 模型给了 2200,1350,3000,1600（图只有 1920×1080），
      //      裁出**空块**（0.00 MB），接着喂给视觉模型就全崩，一轮 5 分钟全是报错。
      //      ⇒ **坐标一律先夹进画幅，面积太小就退回自动定位。**
      const callerRegions = (Array.isArray(args.regions) ? args.regions : [])
        .map(String)
        .filter((s) => /^\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+\s*$/.test(s))
        .map((s) => {
          let [a, b, c, e] = s.split(',').map((v) => parseInt(v, 10));
          a = Math.max(0, Math.min(a, w - 1));
          b = Math.max(0, Math.min(b, h - 1));
          c = Math.max(a + 1, Math.min(c, w));
          e = Math.max(b + 1, Math.min(e, h));
          return { box: `${a},${b},${c},${e}`, area: (c - a) * (e - b), clamped: `${a},${b},${c},${e}` !== s.trim() };
        })
        // 面积太小的块没意义（多半是坐标写错），丢掉
        .filter((r) => r.area >= 400)
        .map((r) => r.box);

      let regions;
      if (callerRegions.length) {
        regions = callerRegions;
        notes.push(`按调用方指定区域看：${callerRegions.join(' / ')}`);
      } else if (subjectRegion) {
        regions = [subjectRegion];
      } else if (!big) {
        regions = [null];                    // 小图：整图问一次就够
      } else if (w >= h) {
        // 横图：中间主块 + 两侧边缘（不再对半切，理由见上）
        const cw = Math.round(w * 0.62);
        const x0 = Math.round((w - cw) / 2);
        regions = [
          `${x0},0,${x0 + cw},${h}`,
          `0,0,${Math.round(w * 0.28)},${h}`,
          `${w - Math.round(w * 0.28)},0,${w},${h}`,
        ];
        notes.push('横图：中间主块 + 左右边缘各一块（避免把人物从中间切开）');
      } else {
        // 竖图：上/中/下三段
        regions = [
          `0,0,${w},${Math.round(h / 3)}`,
          `0,${Math.round(h / 3)},${w},${Math.round((h * 2) / 3)}`,
          `0,${Math.round((h * 2) / 3)},${w},${h}`,
        ];
        notes.push('竖图：上/中/下三段');
      }

      const parts = [];
      for (const region of regions) {
        try {
          let target = image;
          let label = '整图';
          // 这两个都要在块**外**声明：块里的赋值要活到后面去用
          // （踩过 `r is not defined` 的坑，见下方注释）
          let colorSource = image;
          let actualScale = 1;
          if (region) {
            const [rx1, ry1, rx2, ry2] = region.split(',').map(Number);
            const bw = Math.max(1, rx2 - rx1);
            const bh = Math.max(1, ry2 - ry1);
            const longSide = Math.max(bw, bh);
            // 放大倍数：**放大是目的，尺寸只是约束**。
            //
            // 注意： 这里改过两次，两次都是实测逼出来的：
            //   ① 固定 3 倍 —— 1920×1080 切三段后单张变 5760×1080（6.9 MB），太臃肿。
            //   ② 改成"目标长边 1600" —— 1500 宽的裁块算出 0.95 倍、取整成 1.0×，
            //      **等于没放大**。模型直接反馈"它这次裁块是 1.00× 没放大，细节照样
            //      得保守说"。放大一废，整个工作流就只剩"切块"。
            //   正解：先保放大（目标长边 3200），倍数夹在 1~2.5 之间；
            //        真正的体积上限交给 imgtool 的 --max-pixels（900 万像素）去兜。
            const scale = Math.max(1, Math.min(2.5, 3200 / longSide));

            // 输出用 JPEG 不用 PNG：实测同一张裁块 PNG 要 10.8 MB，JPEG(q88) 只要
            // 1.3 MB —— 而视觉模型看到的信息量几乎一样。PNG 的无损对识图毫无价值。
            const cropOut = join(lookDir,
              `${basename(image).replace(/\.[^.]+$/, () => '')}_${region.replace(/[^0-9]/g, '_')}.jpg`);
            const r = await runImgtool('crop',
              [image, '--region', region, '--out', cropOut, '--scale', String(scale)]);
            target = r.out ?? cropOut;
            actualScale = Number(r.scale ?? scale) || 1;
            label = `裁块 ${region}（放大 ${actualScale}×，${r.size ?? '?'}）`;
            notes.push(label);
          }
          // 取色要在增强**之前**做 —— 增强会改局部像素值，等于污染证据。
          // 所以在进入增强之前先把"干净的那份"记下来。
          //
          // 注意： 这里踩过一次作用域坑，写下来免得再犯：
          //   上一版写了 `const cropScale = Number(r?.scale ?? scale)`，而 `r` 是
          //   **在 if (region) 块里声明的**，块外根本不可见；region 为 null（小图整图看）
          //   时更是不存在。结果每次裁块都抛 `r is not defined`，
          //   整条看图链路直接挂掉（模型的反馈："三段裁块都报 r is not defined"）。
          //   ⇒ 让块内把值**存到一个块外声明的变量**里，别跨作用域引用块内 const。
          colorSource = target;

          // ── 分级增强。三层，从安全到冒险：
          //   ① 裁图放大（LANCZOS）—— 不改变内容
          //   ② 感知式锐化（unsharp）—— 让已有边缘更好读，不新增内容
          //   ③ AI 超分（Real-ESRGAN）—— **会补出原图没有的细节**，只在块很小时用
          //
          // 实测依据（2026-10-05）：
          //   · 拉普拉斯方差：原图+Lanczos 14.8 → Real-ESRGAN 504.3（提升 34 倍）
          //   · 速度：300~700px 的块都是 ~1.7 秒，很轻
          //   · 注意： 但视觉模型对比后明确指出：超分"补"出了原图没有的**描边和褶皱线**，
          //     "很可能是 AI 按动漫风格补出来的，不能直接当作原图真实细节"
          //   ⇒ 所以：**只在裁块长边 < 700 时自动超分**（那种情况信息本来就少，
          //     收益最大），而且**必须把"这段基于超分图"标出来**，让模型知道
          //     哪些结论要打折。
          //
          // 两条纪律（别改）：
          //   ① 颜色判断一律在增强**之前**取色（下面 colorSource 就是为此保留的）
          //   ② 超分结果必须标注，不能当原始证据用
          let sharpNote = '';
          if (region) {
            try {
              // 要不要超分，看的是**裁块本身长边有多大**（不是"放大倍数"）。
              //
              // 判据改过两次，两次都是实测逼出来的：
              //   ① 最早写"块长边 < 700" —— 模型对 1920×1080 的图下钻出的块长边都是 1080，
              //      一个都没触发；可那些块里人物只占一小条。
              //   ② 改成"放大倍数 < 1.5" —— 又发现逻辑反了：放大倍数接近 1 意味着
              //      **原图细节本来就够**，超分只会让它变成 10180×5720（38.8 MB）的巨图，
              //      视觉模型根本吃不下。
              //   ⇒ 正解：**超分的主场是"小块"**（信息少、模型补细节收益最大）。
              //      实测小块 280×200：Lanczos 到 1596 方差 93.5，
              //      而 Real-ESRGAN 到 1120 就有 1735.3（18.6 倍）。
              //
              // 三档：
              //   > 1600     → 不超分（它本来就清楚，超分反而变糊或巨无霸）
              //   600~1600   → 超分到 1600
              //   < 600      → 超分到 2000（收益最大的一档）
              const rp = region.split(',').map(Number);
              const blockLong = Math.max(rp[2] - rp[0], rp[3] - rp[1]);
              let srTarget = 0;
              if (blockLong < 600) srTarget = 2000;
              else if (blockLong < 1600) srTarget = 1600;

              if (srTarget > 0) {
                const srOut = target.replace(/\.[^.]+$/, () => '') + '_sr.png';
                const t0 = Date.now();
                await execFileAsync(PYTHON,
                  [UPSCALE_PY, target, '--model', 'anime', '--out', srOut,
                    '--out-long-side', String(srTarget)],
                  { timeout: 240000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
                if (existsSync(srOut)) {
                  target = srOut;
                  const secs = ((Date.now() - t0) / 1000).toFixed(1);
                  sharpNote = `（AI 超分 → 长边 ${srTarget}，${secs}s）\n`
                    + '  注意： 这一段基于**超分图**：结构和位置可信，但**补出来的描边/褶皱线不算事实**，'
                    + '不要拿它当细节依据。颜色请看下面的算法取色。';
                }
              }

              // 超分之后（或块本来就大时）再补一层分级锐化，让边缘更好读
              const enhancedOut = target.replace(/\.[^.]+$/, () => '') + '_enh.jpg';
              const e = await runImgtool('enhance',
                [target, '--out', enhancedOut, '--level', 'auto']);
              if (existsSync(enhancedOut)) {
                target = enhancedOut;
                if (!sharpNote) {
                  sharpNote = `（锐化 清晰度 ${e.sharpness_before ?? '?'}→${e.sharpness_after ?? '?'}，档位 ${e.level ?? '?'}）`;
                }
              }
            } catch (err) {
              // 增强/超分失败就用原裁块 —— 不阻断，但要说明
              sharpNote = `（增强失败，用未处理裁块：${String(err?.message ?? err).slice(0, 60)}）`;
            }
          }

          // 取色：用**增强前**的裁块，保证证据干净
          let colorNote = '';
          try {
            const detail = String(await execFileAsync(PYTHON, [IMGTOOL, 'color', colorSource, '--top', '5'])
              .then((x) => x.stdout).catch(() => ''));
            const colors = detail.split('\n').filter((l) => l.trim().startsWith('#')).slice(0, 4)
              .map((l) => l.trim()).join('，');
            if (colors) colorNote = `\n  （这一块的真实主色，算法取样：${colors}）`;
          } catch { /* 取色失败不影响 */ }

          const prompt = region
            ? `${question}\n\n注意：这是原图的一个局部（${label}），已放大。只描述这一块里看得见的东西；看不清的明说看不清，不要猜。`
            : question;

          const t = await askVision(llm, attachments, visionCfg.provider, visionCfg.model,
            visionCfg.maxTokens ?? 3072, target, prompt, exec.signal);
          parts.push(`【${label}】${sharpNote}${colorNote}\n${t}`);
        } catch (err) {
          parts.push(`【${region ?? '整图'}】这一块看失败：${String(err?.message ?? err)}`);
        }
      }

      // ── 反向搜图（trace.moe）：识别角色时最有价值的一步
      //
      // 为什么放在这里而不是让模型自己调：模型不知道有这个工具，也不知道它
      // 只在"认人"时有用。而这一步的成本很低（1~3 秒、免费），做了几乎只有好处。
      //
      // 注意： 边界（必须如实转达给模型，别让它拿低相似度当确证）：
      //   · trace.moe **只认动画截图**。插画 / 同人图 / 游戏立绘 / AI 原创图
      //     它认不出 —— 那些情况它会给一个 0.6~0.8 的"画风相近"结果，
      //     必须标成存疑，不能当答案。
      //   · 相似度 < 0.85 的结果不要当确证。
      let reverseNote = '';
      try {
        const tm = await execFileAsync(PYTHON, [TRACEMOE_PY, image, '--top', '3'],
          { timeout: 90000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
        const lines = String(tm.stdout).split('\n').map((l) => l.trim()).filter(Boolean);
        const matches = lines.filter((l) => l.startsWith('match='));
        const verdictLine = lines.find((l) => l.startsWith('verdict=')) ?? '';
        const noteLine = lines.find((l) => l.startsWith('note=')) ?? '';
        const verdict = verdictLine.replace('verdict=', '').trim();

        if (matches.length > 0 && verdict !== 'none') {
          reverseNote = '\n【反向搜图（trace.moe，识别动画截图）】\n'
            + matches.map((m) => '  ' + m).join('\n') + '\n'
            + `  判定：${verdict} —— ${noteLine.replace('note=', '')}\n`
            + '  注意： 只有 verdict=high（相似度 ≥0.90）才能当成"就是这部"；'
            + 'medium/low 都要说成"看着像/存疑"。这是**动画截图**专用的库，'
            + '插画和原创图它认不出，给的低分结果不要采信。';
        } else {
          reverseNote = '\n【反向搜图（trace.moe）】没匹配上 —— '
            + '说明这张大概率不是动画截图（插画/同人图/游戏立绘/AI 原创图它都认不出）。\n'
            + '  这不等于"查不到角色"，只等于"这个工具帮不上"：'
            + '插画类需要 SauceNAO（本机网络不通，等云端部署）。';
        }
      } catch (err) {
        reverseNote = `\n【反向搜图（trace.moe）】调用失败：${String(err?.message ?? err).slice(0, 100)}`;
      }

      const body = [
        `${notes[0]}。${notes.slice(1).join('；')}`,
        '',
        ...parts,
        reverseNote,
        '',
        '（以上来自"先量尺寸 → 裁块放大 → 逐块提问 → 算法取色"的流程；'
        + '凡模型没把握的地方，上面会标出来。）',
      ].join('\n');

      return { text: body };
    },
  };

  tools.register(definition);
  logger.info(`qqbot-memory: ${LOOK_TOOL_NAME} 已注册 (provider=${visionCfg.provider} model=${visionCfg.model})`);
  return true;
}
