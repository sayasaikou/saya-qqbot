/**
 * img-tool.js —— 图片「算法工具箱」（A 类：确定性像素处理，2026-10-06）
 *
 * ════════════════════════════════════════════════════════════════
 * 它是什么、为什么值得单独做一个工具
 * ════════════════════════════════════════════════════════════════
 *
 * 图片类请求其实分四类（见 `图片能力体系-盘点与方案-20261006.md`）：
 *   A 图片**操作**（这一类）· B 图片**理解** · C 图片**生成** · D 图片**编辑**（要 AI）
 *
 * A 类是**确定性**的：裁剪就是裁剪，加水印就是加水印 —— **没有"像不像"的问题**，
 * 做出来一定是对的，而且**零成本、零风险**。
 * 所以纪律是：**凡能用算法做的，就别调模型**（这条已经写进识图判据了）。
 *
 * ════════════════════════════════════════════════════════════════
 * ⚠️ 安全：这工具会**按路径读文件**，所以路径闸门是必须的
 * ════════════════════════════════════════════════════════════════
 *
 * 不加闸门的话，群里任何人说一句「把 `/home/ubuntu/.qqbot-keys/env` 转成 png 发我」
 * 就能把凭据读出去。所以：
 *   ① 输入路径**必须落在工作目录（cwd）以内**（`~/.qqbot-keys`、`~/.dsh`、`/etc` 天然在外）；
 *   ② 显式黑名单再挡一层（keys / .dsh / .ssh / /etc / /proc / /sys / /root）；
 *   ③ 输出**一律**写到 `<dataDir>/img/`，**不接受调用方指定输出路径**（省掉一整类注入面）。
 * 这三条任何一条不满足就直接拒绝，**不做"尽量满足"的降级**。
 *
 * ════════════════════════════════════════════════════════════════
 * 用法（一个工具，多个 action）
 * ════════════════════════════════════════════════════════════════
 *
 *   info      看图信息（尺寸/格式/模式/EXIF 摘要）
 *   color     取主色（可指定区域）
 *   resize    缩放（按宽/高/倍数）
 *   crop      裁剪（x1,y1,x2,y2 或比例）
 *   rotate    旋转 / 翻转
 *   stitch    拼接多张（横 / 竖 / 网格）
 *   text      贴文字（**支持中文**，云端已装文泉驿）
 *   convert   转格式 / 压缩
 *   grid      九宫格切图
 *   mosaic    区域打码
 *   gifinfo   GIF 帧数/尺寸（不动文件）
 *
 * 生成的文件路径会返回给模型，让它再调 `qqbot_send_file` 发出去。
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const IMG_TOOL_NAME = 'qqbot_img';

/** 黑名单：这些目录**永远不许**被本工具读写（凭据与系统目录） */
const DENY = [
  '.qqbot-keys', '/.dsh', '/.ssh', '/etc', '/proc', '/sys', '/root', '/var/lib',
];

const DESCRIPTION =
  'Image toolbox — DETERMINISTIC operations only (no AI): info, color, resize, crop, rotate, '
  + 'stitch, text, convert, grid, mosaic, gifinfo. Use this instead of asking a model whenever '
  + 'the task has a definite answer (crop / resize / watermark / add Chinese text / format '
  + 'conversion / nine-grid split / mosaic). Input must be a path (or several, comma-separated) '
  + 'inside the working directory. Returns the output file path(s) — you MUST then call '
  + '`qqbot_send_file` with that path to actually show it.';

/**
 * 找 Python 解释器。
 * ⚠️ **不能直接写 `python3`** —— 本机 PATH 里的 python 是 WindowsApps 的 0 字节存根，
 * 调它会失败（档案里早写过这条坑，`look-tool.js` 也是这么处理的）。
 * 云端反过来：Windows 路径不存在 ⇒ 落到 `python3`（/usr/bin/python3）。
 */
function py() {
  if (process.env.QQBOT_PYTHON) return process.env.QQBOT_PYTHON;
  const win = 'C:\\Users\\xia54\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';
  try { if (existsSync(win)) return win; } catch { /* ignore */ }
  return 'python3';
}

/** 路径闸门：必须在 cwd 内，且不在黑名单里 */
export function guardPath(p, cwd) {
  const abs = resolve(String(p ?? ''));
  const root = resolve(cwd || '.');
  if (!abs.startsWith(root + sep) && abs !== root) {
    return { ok: false, why: `不在工作目录内（只允许 ${root} 以内的文件）` };
  }
  for (const d of DENY) {
    if (abs.includes(d)) return { ok: false, why: `这个路径被禁止访问（命中「${d}」）` };
  }
  if (!existsSync(abs)) return { ok: false, why: '文件不存在' };
  return { ok: true, abs };
}

/** 统一的 python 尾巴：读 action 参数（JSON 走 stdin），输出 JSON 结果 */
function buildScript() {
  return String.raw`
import json, os, sys, glob
from PIL import Image, ImageDraw, ImageFont, ImageOps, ImageFilter

# ⚠️ Windows 下 Python 的 stdout 默认按 GBK 编码 ⇒ 返回的中文会变成问号
#    （2026-10-06 自测实测：图其实画对了，是**回读**乱码，害得断言看起来像功能坏了）。
#    云端是 UTF-8 locale 不受影响，但两边都统一成 UTF-8 最省心。
#    ⚠️ 写这段时别用反引号 —— 整个脚本是 JS 模板字符串的内容，反引号会提前闭合字符串。
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ARGS = json.load(open(sys.argv[1], encoding="utf-8"))   # ⚠️ 参数走**文件**，不走 stdin —— 见下面注释
OUT = ARGS["outdir"]
os.makedirs(OUT, exist_ok=True)
seq = ARGS.get("seq", 0)

def outp(name):
    return os.path.join(OUT, name)

def load(p):
    im = Image.open(p)
    if im.mode not in ("RGB", "RGBA"):
        im = im.convert("RGB")
    return im

def save(im, tag, fmt=None, quality=92):
    ext = (fmt or "jpg").lower()
    name = "img-%s.%s" % (tag, "png" if ext == "png" else ("webp" if ext == "webp" else "jpg"))
    path = outp(name)
    if ext == "png":
        im.save(path, "PNG", optimize=True)
    elif ext == "webp":
        im.save(path, "WEBP", quality=quality)
    else:
        im.convert("RGB").save(path, "JPEG", quality=quality, optimize=True)
    return {"path": path, "bytes": os.path.getsize(path), "size": list(im.size)}

def font(size):
    # 云端已装文泉驿（apt fonts-wqy-zenhei）；本机用系统自带的雅黑/黑体。
    # 两边路径都列上 —— 找不到就**如实报错**，别画出一堆方框冒充成功。
    for p in ("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
              "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
              "C:/Windows/Fonts/msyh.ttc",
              "C:/Windows/Fonts/simhei.ttf",
              "C:/Windows/Fonts/simsun.ttc",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    raise RuntimeError("找不到可用字体（中文会画不出来）")

A = ARGS["action"]
P = ARGS.get("paths") or []
r = {}

if A == "info":
    p = P[0]
    im = Image.open(p)
    r = {"format": im.format, "mode": im.mode, "size": list(im.size),
         "megapixels": round(im.size[0]*im.size[1]/1e6, 2)}
    try:
        ex = im.getexif()
        r["exif"] = {str(k): str(v)[:60] for k, v in list(ex.items())[:8]} if ex else {}
    except Exception:
        r["exif"] = {}
    r["bytes"] = os.path.getsize(p)
    if (im.format or "").upper() == "GIF":
        try:
            r["frames"] = getattr(im, "n_frames", 1)
        except Exception:
            r["frames"] = 1

elif A == "color":
    im = load(P[0])
    reg = ARGS.get("region")
    if reg:
        x1, y1, x2, y2 = [int(float(v)) for v in reg.split(",")]
        im = im.crop((x1, y1, x2, y2))
    small = im.resize((120, 120))
    q = small.quantize(colors=6, method=Image.MEDIANCUT).convert("RGB")
    counts = {}
    for px in q.getdata():
        counts[px] = counts.get(px, 0) + 1
    total = sum(counts.values())
    top = sorted(counts.items(), key=lambda kv: -kv[1])[:5]
    r = {"colors": [{"hex": "#%02X%02X%02X" % c, "pct": round(n*100.0/total, 1)} for c, n in top]}

elif A == "resize":
    im = load(P[0])
    w, h = im.size
    if ARGS.get("scale"):
        s = float(ARGS["scale"]); nw, nh = max(1, int(w*s)), max(1, int(h*s))
    elif ARGS.get("width"):
        nw = int(ARGS["width"]); nh = max(1, int(h * nw / w))
    elif ARGS.get("height"):
        nh = int(ARGS["height"]); nw = max(1, int(w * nh / h))
    else:
        raise RuntimeError("resize 需要 width / height / scale 之一")
    r = save(im.resize((nw, nh), Image.LANCZOS), "rz%s" % seq, ARGS.get("format"), int(ARGS.get("quality") or 92))
    r["from"] = [w, h]

elif A == "crop":
    im = load(P[0]); w, h = im.size
    box = ARGS.get("box")
    if box:
        x1, y1, x2, y2 = [int(float(v)) for v in box.split(",")]
    elif ARGS.get("rel"):
        a, b, c, d = [float(v) for v in ARGS["rel"].split(",")]
        x1, y1, x2, y2 = int(w*a), int(h*b), int(w*c), int(h*d)
    else:
        raise RuntimeError("crop 需要 box=x1,y1,x2,y2 或 rel=0,0,0.5,0.5")
    x1, y1 = max(0, x1), max(0, y1); x2, y2 = min(w, x2), min(h, y2)
    if x2 <= x1 or y2 <= y1:
        raise RuntimeError("裁剪框是空的")
    r = save(im.crop((x1, y1, x2, y2)), "cr%s" % seq, ARGS.get("format"), int(ARGS.get("quality") or 92))
    r["box"] = [x1, y1, x2, y2]

elif A == "rotate":
    im = load(P[0])
    deg = float(ARGS.get("degrees") or 90)
    flip = (ARGS.get("flip") or "").lower()
    if flip == "h":
        im = ImageOps.mirror(im)
    elif flip == "v":
        im = ImageOps.flip(im)
    else:
        im = im.rotate(-deg, expand=True)   # 正数=顺时针，跟人直觉一致
    r = save(im, "rot%s" % seq, ARGS.get("format"), int(ARGS.get("quality") or 92))

elif A == "stitch":
    ims = [load(p) for p in P]
    if len(ims) < 2:
        raise RuntimeError("stitch 至少要两张")
    mode = (ARGS.get("mode") or "h").lower()
    gap = int(ARGS.get("gap") or 8)
    if mode == "h":
        H = max(i.size[1] for i in ims)
        ims = [i.resize((int(i.size[0]*H/i.size[1]), H), Image.LANCZOS) for i in ims]
        W = sum(i.size[0] for i in ims) + gap*(len(ims)-1)
        canvas = Image.new("RGB", (W, H), (255, 255, 255)); x = 0
        for i in ims:
            canvas.paste(i, (x, 0)); x += i.size[0] + gap
    elif mode == "v":
        W = max(i.size[0] for i in ims)
        ims = [i.resize((W, int(i.size[1]*W/i.size[0])), Image.LANCZOS) for i in ims]
        H = sum(i.size[1] for i in ims) + gap*(len(ims)-1)
        canvas = Image.new("RGB", (W, H), (255, 255, 255)); y = 0
        for i in ims:
            canvas.paste(i, (0, y)); y += i.size[1] + gap
    else:  # grid
        cols = int(ARGS.get("cols") or 2)
        rows = (len(ims) + cols - 1)//cols
        cw = max(i.size[0] for i in ims); ch = max(i.size[1] for i in ims)
        canvas = Image.new("RGB", (cols*cw + gap*(cols-1), rows*ch + gap*(rows-1)), (255, 255, 255))
        for k, i in enumerate(ims):
            canvas.paste(i, ((k % cols)*(cw+gap), (k//cols)*(ch+gap)))
    r = save(canvas, "st%s" % seq, ARGS.get("format"), int(ARGS.get("quality") or 92))

elif A == "text":
    im = load(P[0]).convert("RGB")
    txt = ARGS.get("text") or ""
    if not txt:
        raise RuntimeError("text 需要 text 参数")
    size = int(ARGS.get("font_size") or max(18, im.size[1]//14))
    f = font(size)
    d = ImageDraw.Draw(im)
    pos = (ARGS.get("position") or "bottom").lower()
    bb = d.textbbox((0, 0), txt, font=f)
    tw, th = bb[2]-bb[0], bb[3]-bb[1]
    pad = max(6, size//3)
    if pos == "bottom":
        xy = ((im.size[0]-tw)//2, im.size[1]-th-pad*2)
    elif pos == "top":
        xy = ((im.size[0]-tw)//2, pad)
    elif pos == "center":
        xy = ((im.size[0]-tw)//2, (im.size[1]-th)//2)
    else:
        xy = (pad, im.size[1]-th-pad*2)
    if ARGS.get("stroke", True):
        d.text((xy[0]+max(1,size//20), xy[1]+max(1,size//20)), txt, font=f, fill=(0, 0, 0))
    d.text(xy, txt, font=f, fill=ARGS.get("color") or (255, 255, 255))
    r = save(im, "tx%s" % seq, ARGS.get("format"), int(ARGS.get("quality") or 92))
    r["text"] = txt

elif A == "convert":
    im = load(P[0])
    r = save(im, "cv%s" % seq, ARGS.get("format") or "png", int(ARGS.get("quality") or 92))

elif A == "grid":
    im = load(P[0]); n = int(ARGS.get("n") or 3)
    w, h = im.size
    paths = []
    for i in range(n):
        for j in range(n):
            box = (int(w*j/n), int(h*i/n), int(w*(j+1)/n), int(h*(i+1)/n))
            p = outp("img-g%s-%d%d.%s" % (seq, i+1, j+1, "png" if (ARGS.get("format") or "").lower() == "png" else "jpg"))
            im.crop(box).save(p, quality=92)
            paths.append(p)
    r = {"paths": paths, "n": n}

elif A == "mosaic":
    im = load(P[0])
    box = ARGS.get("box")
    if not box:
        raise RuntimeError("mosaic 需要 box=x1,y1,x2,y2")
    x1, y1, x2, y2 = [int(float(v)) for v in box.split(",")]
    blk = int(ARGS.get("block") or 12)
    reg = im.crop((x1, y1, x2, y2))
    small = reg.resize((max(1, reg.size[0]//blk), max(1, reg.size[1]//blk)), Image.BILINEAR)
    im.paste(small.resize(reg.size, Image.NEAREST), (x1, y1))
    r = save(im, "ms%s" % seq, ARGS.get("format"), int(ARGS.get("quality") or 92))
    r["box"] = [x1, y1, x2, y2]

elif A == "gifinfo":
    im = Image.open(P[0])
    r = {"format": im.format, "size": list(im.size), "frames": getattr(im, "n_frames", 1),
         "animated": bool(getattr(im, "is_animated", False))}

else:
    raise RuntimeError("不认识的 action: %s" % A)

print(json.dumps(r, ensure_ascii=False))
`;
}

/**
 * 注册工具。
 * @param {object} ctx
 * @param {object} cfg 插件配置（dataDir / cwd）
 * @param {object} logger
 */
export function registerImgTool(ctx, cfg, logger) {
  const tools = (() => { try { return ctx.get('tools'); } catch { return undefined; } })();
  if (!tools?.register) {
    logger?.warn?.('拿不到 tools 服务，qqbot_img 未注册');
    return false;
  }

  // 路径闸门的根 = agent 的工作目录。
  // 它没有单独的配置项也没关系：**dataDir 的父目录就是工作目录**
  // （本机 `E:\dsh-qqbot\data` → `E:\dsh-qqbot`；云端 `/home/ubuntu/qqbot/data` → `/home/ubuntu/qqbot`）。
  // 需要时可以用 cfg.cwd 显式覆盖（本地/云端不用改配置就能对）。
  const cwd = cfg.cwd || dirname(cfg.dataDir || '.');
  const outDir = join(cfg.dataDir, 'img');
  let seq = 0;

  tools.register({
    name: IMG_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['info', 'color', 'resize', 'crop', 'rotate', 'stitch', 'text', 'convert', 'grid', 'mosaic', 'gifinfo'],
          description: 'Which operation.',
        },
        paths: {
          type: 'string',
          description: 'Input file path(s). Several paths separated by commas (for stitch). '
            + 'Must be inside the working directory.',
        },
        text: { type: 'string', description: 'For action=text: the text to draw (Chinese is supported).' },
        box: { type: 'string', description: 'For crop/mosaic: "x1,y1,x2,y2" in pixels.' },
        rel: { type: 'string', description: 'For crop: relative box "0,0,0.5,0.5" (fractions of width/height).' },
        width: { type: 'number', description: 'For resize: target width in px.' },
        height: { type: 'number', description: 'For resize: target height in px.' },
        scale: { type: 'number', description: 'For resize: scale factor, e.g. 0.5.' },
        degrees: { type: 'number', description: 'For rotate: degrees clockwise (default 90).' },
        flip: { type: 'string', enum: ['h', 'v'], description: 'For rotate: mirror horizontally / vertically instead.' },
        mode: { type: 'string', enum: ['h', 'v', 'grid'], description: 'For stitch: layout.' },
        cols: { type: 'number', description: 'For stitch mode=grid: columns.' },
        gap: { type: 'number', description: 'For stitch: gap in px (default 8).' },
        position: { type: 'string', enum: ['top', 'bottom', 'center', 'left'], description: 'For text: placement.' },
        font_size: { type: 'number', description: 'For text: font size in px.' },
        format: { type: 'string', enum: ['jpg', 'png', 'webp'], description: 'Output format (default jpg).' },
        quality: { type: 'number', description: 'JPEG/WebP quality 1-100 (default 92).' },
        region: { type: 'string', description: 'For color: "x1,y1,x2,y2" to sample a region.' },
        n: { type: 'number', description: 'For grid: split into n x n (default 3).' },
        block: { type: 'number', description: 'For mosaic: block size (default 12).' },
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
      const action = String(args.action ?? '');
      const raw = String(args.paths ?? '').trim();
      if (!raw && action !== 'info') return { text: '（没给图片路径。）' };
      if (!raw && action === 'info') return { text: '（没给图片路径。）' };

      // ── 路径闸门（逐条查，任何一条不过就整单拒绝）
      const paths = raw.split(',').map((s) => s.trim()).filter(Boolean);
      const abs = [];
      for (const p of paths) {
        const g = guardPath(p, cwd);
        if (!g.ok) return { text: `（不给做：${p} —— ${g.why}。）` };
        abs.push(g.abs);
      }
      if (action === 'stitch' && abs.length < 2) return { text: '（拼接至少要两张图。）' };

      try { if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true }); } catch { /* 建不了会在下面报 */ }
      seq += 1;

      const payload = {
        action,
        paths: abs,
        outdir: outDir,
        seq,
        box: args.box, rel: args.rel, width: args.width, height: args.height, scale: args.scale,
        degrees: args.degrees, flip: args.flip, mode: args.mode, cols: args.cols, gap: args.gap,
        text: args.text, position: args.position, font_size: args.font_size,
        format: args.format, quality: args.quality, region: args.region, n: args.n, block: args.block,
      };

      // ⚠️ 参数**通过临时文件**传，不要走 stdin：
      //    Node 的 `child_process.execFile` **没有 `input` 选项**（那是 execFileSync / spawn 的），
      //    传了会被静默忽略 ⇒ 子进程 `json.load(sys.stdin)` **永远等下去**，工具直接卡死。
      //    （2026-10-06 自测时实测踩到，卡了 5 分钟没返回。）
      const argFile = join(outDir, `.args-${process.pid}-${seq}.json`);
      writeFileSync(argFile, JSON.stringify(payload), 'utf8');
      try {
        const { stdout } = await execFileAsync(py(), ['-c', buildScript(), argFile], {
          timeout: 120000,
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
        });
        const r = JSON.parse(String(stdout).trim().split('\n').pop());
        logger?.info?.(`qqbot_img: ${action} → ${JSON.stringify(r).slice(0, 200)}`);

        if (r.paths) {
          return { text: `切好了 ${r.paths.length} 张：\n${r.paths.map((p) => '- ' + p).join('\n')}\n`
            + '**必须再调 `qqbot_send_file`** 把它们发出去（一次一张）。' };
        }
        const head = `路径：${r.path}\n（${r.bytes ? Math.round(r.bytes / 1024) + ' KB' : ''}`
          + `${r.size ? '，' + r.size.join('×') : ''}）`;
        let extra = '';
        if (r.from) extra = `\n原图 ${r.from.join('×')} → 新图 ${r.size.join('×')}`;
        if (r.box) extra += `\n裁剪框 ${r.box.join(',')}`;
        if (r.colors) extra = '\n主色：' + r.colors.map((c) => `${c.hex}（${c.pct}%）`).join('，');
        if (r.text) extra += `\n文字：${r.text}`;
        if (r.format) extra += `\n格式 ${r.format} ${r.mode ?? ''} ${(r.size ?? []).join('×')} ${r.megapixels ? r.megapixels + 'MP' : ''}`;
        if (r.frames) extra += `\n帧数 ${r.frames}${r.animated ? '（动图）' : ''}`;
        if (r.exif && Object.keys(r.exif).length) extra += `\nEXIF：${JSON.stringify(r.exif).slice(0, 200)}`;
        const needSend = action !== 'info' && action !== 'color' && action !== 'gifinfo';
        return {
          text: head + extra + (needSend
            ? '\n**要发出去就再调一次 `qqbot_send_file`**（file_path 填上面那个路径）。'
            : ''),
        };
      } catch (err) {
        const stderr = String(err?.stderr ?? '').trim();
        const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
        // ⚠️ 没有 stderr 时**不要**退回整条 message —— execFile 的 message 里带着**整段脚本**，
        //    贴给模型既没用又吵。只取第一行（"Command failed: ..."），再截断。
        const firstLine = String(err?.message ?? err).split('\n')[0];
        const detail = (lines[lines.length - 1] || firstLine).slice(0, 240);
        return { text: `（${action} 没做成：${detail}）` };
      } finally {
        // 临时参数文件用完就删（`finally` 保证 try/catch 两条路都会走到）
        try { unlinkSync(argFile); } catch { /* 删不掉不影响结果 */ }
      }
    },
  });

  logger?.info?.(`qqbot_img 工具已注册（算法工具箱：info/color/resize/crop/rotate/stitch/text/convert/grid/mosaic/gifinfo）`);
  return true;
}

/** 供自测使用的内部函数导出 */
export const __internals = { buildScript, DENY };
