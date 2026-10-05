#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
imgtool.py —— 识图的「能算就别问模型」那一层

为什么需要它
    qqbot_describe_image 是"把整张图丢给模型问一句话"。本机那套识图体系实测出
    两条铁律，这个脚本负责其中一条：

       能算出来的，绝不问模型

    尺寸、主色、某块区域的实际颜色 —— 这些用算法几毫秒就能算准，而模型会看错
    （实测：两个模型异口同声说衬衫扣是金色，PIL 取色证明是深蓝近黑 #272948 占 62%）。

      另一条是"看细节必须裁出放大"—— 那个由 crop 子命令配合 describe 完成：
      先裁出目标区域，再把那一小块喂给 qqbot_describe_image。

用法
    python imgtool.py size  <图片>                      # 尺寸与宽高比
    python imgtool.py color <图片> [--top 8]            # 主色（含占比）
    python imgtool.py color <图片> --region x1,y1,x2,y2 # 指定区域的主色
    python imgtool.py crop  <图片> --region x1,y1,x2,y2 --out <输出> [--scale 3]
    python imgtool.py grid  <图片> [--cols 3 --rows 3]  # 按网格裁成若干块（用于逐块问）

设计原则
    * 只输出事实（数字、颜色、路径），不下结论、不做判断。
    * 输出是给**模型**看的，所以用简洁的键值对，不要长篇解释。
    * 任何一步失败都返回非零退出码 + 一行错误，别静默。
"""

import argparse
import io
import os
import sys

# Windows 控制台默认 GBK：中文会乱码，emoji 会直接抛 UnicodeEncodeError 打死进程。
# 这条教训来自本机 vision-tools，所有会打印中文的脚本都在入口统一一次编码。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

try:
    from PIL import Image
except ImportError:
    print("ERROR: 需要 Pillow（pip install Pillow）")
    sys.exit(2)


def parse_region(text):
    """把 'x1,y1,x2,y2' 解析成 4 个整数"""
    try:
        parts = [int(v.strip()) for v in str(text).split(",")]
    except Exception:
        raise SystemExit("ERROR: --region 需要 4 个整数，格式 x1,y1,x2,y2")
    if len(parts) != 4:
        raise SystemExit("ERROR: --region 需要 4 个整数，格式 x1,y1,x2,y2")
    return parts


def clamp_region(region, width, height):
    """把区域夹到图片范围内，并保证 x1<x2 / y1<y2"""
    x1, y1, x2, y2 = region
    x1 = max(0, min(x1, width - 1))
    y1 = max(0, min(y1, height - 1))
    x2 = max(x1 + 1, min(x2, width))
    y2 = max(y1 + 1, min(y2, height))
    return x1, y1, x2, y2


def cmd_size(args):
    with Image.open(args.image) as im:
        w, h = im.size
    print("width=%d" % w)
    print("height=%d" % h)
    print("megapixels=%.2f" % (w * h / 1_000_000))
    print("aspect=%.3f" % (w / h))
    # 给模型一个"该不该裁"的提示：小图直接问，大图必须裁
    if w * h > 2_000_000:
        print("advice=这张图比较大，直接整图问容易丢细节；先 crop 出目标区域再问")
    else:
        print("advice=尺寸不大，整图问通常够用")
    return 0


def cmd_color(args):
    with Image.open(args.image) as im:
        im = im.convert("RGB")
        w, h = im.size
        if args.region:
            x1, y1, x2, y2 = clamp_region(parse_region(args.region), w, h)
            im = im.crop((x1, y1, x2, y2))
            print("region=%d,%d,%d,%d" % (x1, y1, x2, y2))
        else:
            print("region=整图 %dx%d" % (w, h))

        # 量化到 32 级再统计，避免同一颜色的细微差别被拆成几十个桶
        small = im.resize((min(im.width, 400), min(im.height, 400)))
        q = small.quantize(colors=max(2, min(args.top, 16)), method=Image.Quantize.MEDIANCUT)
        palette = q.getpalette()
        counts = sorted(q.getcolors(), reverse=True)
        total = sum(c for c, _ in counts)

        print("colors=%d" % len(counts))
        for count, idx in counts[: args.top]:
            r, g, b = palette[idx * 3: idx * 3 + 3]
            print("  #%02X%02X%02X  %5.1f%%  rgb(%d,%d,%d)" % (r, g, b, count / total * 100, r, g, b))
    return 0


def cmd_crop(args):
    with Image.open(args.image) as im:
        im = im.convert("RGB")
        w, h = im.size
        x1, y1, x2, y2 = clamp_region(parse_region(args.region), w, h)
        piece = im.crop((x1, y1, x2, y2))

        # 放大：小目标在原始尺度下模型看不清，放大后才问得出来
        # （实测：52x88 的扣子特写放大 8 倍后，模型才数对"3 颗"）
        if args.scale and args.scale != 1:
            nw, nh = int(piece.width * args.scale), int(piece.height * args.scale)
            # 上限防止生成超大文件
            if nw * nh > 16_000_000:
                import math
                k = math.sqrt(16_000_000 / (piece.width * piece.height))
                nw, nh = int(piece.width * k), int(piece.height * k)
                print("note=放大倍数被上限压到 %.2fx" % k)
            piece = piece.resize((nw, nh), Image.LANCZOS)

        out = args.out or os.path.splitext(args.image)[0] + "_crop" + (".png" if args.png else ".jpg")
        # 像素上限：放大是为了看清细节，但产物太大反而拖慢上传、甚至被视觉 API 拒收。
        # 实测教训：3000×1688 的人物主体框裁出来放大 2 倍 = 3360×3136 =
        # 10.8 MB 的 **PNG** —— 超出视觉接口 10 MB 的上限。
        # 过预算就自动降倍数（降的是"输出尺寸"，裁剪范围一点没变，画面内容不变）。
        budget = args.max_pixels
        if piece.width * piece.height > budget:
            k = (budget / float(piece.width * piece.height)) ** 0.5
            nw, nh = max(1, int(piece.width * k)), max(1, int(piece.height * k))
            print("note=超出像素预算 %d，实际倍数从 %.2fx 降到 %.2fx（内容不变，只降尺寸）"
                  % (budget, args.scale, nw / max(1, x2 - x1)))
            piece = piece.resize((nw, nh), Image.LANCZOS)

        # 默认存 JPEG：视觉模型不需要无损，而 PNG 对复杂插画动不动就是几 MB。
        # 实测同一张裁块：PNG 9.9 MB → JPEG(q88) 约 1.5 MB，而模型看到的信息量几乎一样。
        if args.png:
            piece.save(out, "PNG")
        else:
            piece.convert("RGB").save(out, "JPEG", quality=args.quality, optimize=True)
        print("out=%s" % out)
        print("crop=%d,%d,%d,%d" % (x1, y1, x2, y2))
        print("size=%dx%d" % (piece.width, piece.height))
        print("scale=%.2f" % (piece.width / max(1, x2 - x1)))
        print("bytes=%d" % os.path.getsize(out))
        print("next=用 qqbot_describe_image 问这个文件；问法要具体，例如「这块区域里的X是什么颜色」「有几个」")
    return 0


def cmd_grid(args):
    """按网格切块：不知道目标在哪时，先切块逐块看"""
    with Image.open(args.image) as im:
        w, h = im.size
        base = os.path.splitext(args.image)[0]
        outdir = args.outdir or (base + "_grid")
        os.makedirs(outdir, exist_ok=True)
        n = 0
        for r in range(args.rows):
            for c in range(args.cols):
                x1 = int(w * c / args.cols)
                x2 = int(w * (c + 1) / args.cols)
                y1 = int(h * r / args.rows)
                y2 = int(h * (r + 1) / args.rows)
                piece = im.convert("RGB").crop((x1, y1, x2, y2))
                # 每块放大到长边 1200 左右，保证细节
                k = min(3.0, 1200 / max(piece.width, piece.height))
                if k > 1:
                    piece = piece.resize((int(piece.width * k), int(piece.height * k)), Image.LANCZOS)
                p = os.path.join(outdir, "r%dc%d.png" % (r + 1, c + 1))
                piece.save(p, "PNG")
                print("tile=%s  region=%d,%d,%d,%d  size=%dx%d" % (p, x1, y1, x2, y2, piece.width, piece.height))
                n += 1
        print("tiles=%d" % n)
        print("next=逐块用 qqbot_describe_image 问，最后自己合并；冲突的地方标存疑")
    return 0


def cmd_locate(args):
    """
    生成"带格子编号的向导图"，给视觉模型用来**定位主体**。

    为什么要这么做（两次实测换来的）
        纯算法找主体不可用：对一张夜景插画跑 grabCut，前景框占 63%，里面既有少女
        也有月亮、城市、樱花，而人物的发梢和裙摆反而被框边切掉 —— 「前景」不等于「主体」。

        于是改成让视觉模型定位。第一版是"画坐标网格 + 让模型照刻度读 x1,y1,x2,y2"，
        又踩两次：
          ① 5000×5000 的图网格太粗（600px 一格），模型把左上角的叶子报成主体；
          ② 另一张图上模型干脆**读不出坐标、没输出 BOX=**，定位直接失败，
             工具只好退回按构图切块（模型自己的反馈：「主体定位报错，自动框没生效」）。

        ⇒ 结论：**让模型读数字太脆**。改成**给它带编号的格子，只要它说「人在哪几格」** ——
          回答 A1/B2 这种离散标签，比读像素坐标稳得多。工具再把格子换算成像素框。
    """
    with Image.open(args.image) as im:
        im = im.convert("RGB")
        w, h = im.size

        # 缩到长边 900（向导图只用来选格子，不需要原尺寸）
        k = min(1.0, 900 / max(w, h))
        gw, gh = int(w * k), int(h * k)
        small = im.resize((gw, gh), Image.LANCZOS)

        from PIL import ImageDraw
        z = 2                                   # 放大画，字才看得清
        canvas = small.resize((gw * z, gh * z), Image.LANCZOS)
        d = ImageDraw.Draw(canvas)

        n = max(2, min(args.grid, 6))           # 格子数（默认 4x4）
        cols = rows = n
        cell_w = w / cols
        cell_h = h / rows

        for r in range(rows):
            for c in range(cols):
                x0 = int(c * cell_w * k * z)
                y0 = int(r * cell_h * k * z)
                x1 = int((c + 1) * cell_w * k * z)
                y1 = int((r + 1) * cell_h * k * z)
                d.rectangle([x0, y0, x1 - 1, y1 - 1], outline=(255, 60, 60), width=2)
                label = "%s%d" % (chr(ord("A") + r), c + 1)   # A1..D4
                # 标签加黑底，免得压在画面上看不清
                d.rectangle([x0 + 2, y0 + 2, x0 + 46, y0 + 26], fill=(0, 0, 0))
                d.text((x0 + 6, y0 + 6), label, fill=(255, 255, 0))

        out = args.out or (os.path.splitext(args.image)[0] + "_guide.jpg")
        # 存 JPEG 不存 PNG：向导图只是给模型看格子的，PNG 要 1.65 MB，JPEG(q85) 只要几百 KB
        # 扩展名跟着内容走：调用方习惯传 .png，但这里存的是 JPEG，
        # 名字对不上会让上层以为拿到了 PNG（实测文件名 *_guide.png 内容却是 JPEG）。
        if not out.lower().endswith((".jpg", ".jpeg")):
            out = os.path.splitext(out)[0] + ".jpg"
        canvas.convert("RGB").save(out, "JPEG", quality=85, optimize=True)
        print("out=%s" % out)
        print("orig=%dx%d" % (w, h))
        print("grid=%dx%d" % (cols, rows))
        print("cell_px=%.0fx%.0f" % (cell_w, cell_h))
        print("labels=%s" % " ".join(
            "%s%d" % (chr(ord("A") + r), c + 1) for r in range(rows) for c in range(cols)))
        print("next=问模型：人物主要落在哪几个格子里？只要回答格子编号（如 B2 C2 B3）")
    return 0



def cmd_refine(args):
    """
    用边缘密度在给定框附近**收紧/微调**，去掉大片空白背景。

    输入：一个粗略的框（通常来自视觉模型照格子选出的位置）。
    做法：在框内做边缘统计，裁掉四周「几乎没有边缘」的空白带。

    为什么值得做：模型选出的框往往偏大（把背景也框进来），而偏大的框意味着
    放大后主体占比更小 —— 那正是「看不清楚」的原因。
    注意： 它**只裁不补**：不改变任何画面内容，只是去掉空白边。
    """
    import numpy as np
    from PIL import ImageFilter

    with Image.open(args.image) as im:
        im = im.convert("RGB")
        w, h = im.size
        x1, y1, x2, y2 = clamp_region(parse_region(args.region), w, h)

        piece = im.crop((x1, y1, x2, y2))
        edges = np.asarray(piece.convert("L").filter(ImageFilter.FIND_EDGES), dtype="float32")
        density = (edges > args.edge_threshold).astype("uint8")

        col = density.sum(axis=0)
        row = density.sum(axis=1)
        ch, cw = density.shape
        thr_c = max(1, int(ch * args.min_ratio))
        thr_r = max(1, int(cw * args.min_ratio))

        nx1, nx2, ny1, ny2 = 0, cw - 1, 0, ch - 1
        while nx1 < nx2 and col[nx1] < thr_c:
            nx1 += 1
        while nx2 > nx1 and col[nx2] < thr_c:
            nx2 -= 1
        while ny1 < ny2 and row[ny1] < thr_r:
            ny1 += 1
        while ny2 > ny1 and row[ny2] < thr_r:
            ny2 -= 1

        fx1, fy1, fx2, fy2 = x1 + nx1, y1 + ny1, x1 + nx2 + 1, y1 + ny2 + 1
        print("in=%d,%d,%d,%d" % (x1, y1, x2, y2))
        print("out=%d,%d,%d,%d" % (fx1, fy1, fx2, fy2))
        print("size=%dx%d" % (fx2 - fx1, fy2 - fy1))
        shrink = 100 - 100.0 * (fx2 - fx1) * (fy2 - fy1) / max(1, (x2 - x1) * (y2 - y1))
        print("shrink=%.0f%%" % shrink)
        print("note=只裁不补：没有改变任何画面内容，只是去掉了空白边")
    return 0


def measure_sharpness(piece):
    """
    用拉普拉斯方差估清晰度（越小越糊）。

    为什么用这个指标：它是**算出来的**，不是模型目测的。分级增强的判据必须可复现，
    否则「这张够不够清楚」就成了感觉问题。裁块（放缩之后）的方差直接反映边缘锐度。
    """
    import numpy as np
    gray = np.asarray(piece.convert("L"), dtype="float32")
    h, w = gray.shape
    if h < 3 or w < 3:
        return 0.0
    # 手写 3x3 拉普拉斯卷积（避免依赖 cv2，本脚本原本只用 PIL）
    lap = (
        gray[0:h - 2, 1:w - 1] + gray[2:h, 1:w - 1]
        + gray[1:h - 1, 0:w - 2] + gray[1:h - 1, 2:w]
        - 4.0 * gray[1:h - 1, 1:w - 1]
    )
    return float(lap.var())


def cmd_enhance(args):
    """
    分级增强：按裁块的实际清晰度，决定"补多少锐度"。

    设计原则（来自实测教训）
        清晰度够的块 —— 信息已经足够，适当锐化让边缘更好读，**不会引入假信息**。
        低清的块 —— 只能轻微锐化，**绝不能「补内容」**：AI 超分会补出原图没有的细节，
        对「分辨真实细节」这个目的来说是毒药（前面抓到的「银色露脐装」就是模型在编）。

    注意： 三条铁律
        1. **绝不生成新内容** —— 只用插值 + 锐化，不上生成式超分。
        2. **颜色判断不看增强结果** —— 锐化会改变局部像素值，取色要在增强**之前**做。
        3. **档位与方差都打印出来** —— 让上层（和人）知道这次是怎么处理的。
    """
    from PIL import ImageFilter

    with Image.open(args.image) as im:
        im = im.convert("RGB")
        before = measure_sharpness(im)

        # 分级：判据是"当前裁块的拉普拉斯方差"
        if args.level == "auto":
            if before >= 300:
                level = "sharp"      # 本来就清楚
            elif before >= 80:
                level = "mid"
            else:
                level = "soft"       # 糊
        else:
            level = args.level

        if level == "none":
            result = im
            note = "不做任何处理"
        elif level == "sharp":
            result = im.filter(ImageFilter.UnsharpMask(radius=1.5, percent=60, threshold=3))
            note = "轻度 unsharp（radius 1.5 / 60%）—— 只让边缘更好读"
        elif level == "mid":
            result = im.filter(ImageFilter.UnsharpMask(radius=2.0, percent=90, threshold=3))
            note = "中度 unsharp（radius 2.0 / 90%）"
        else:  # soft
            # 糊的块只做很轻的锐化：宁可不够清楚，也不要让它"看起来有细节"
            result = im.filter(ImageFilter.UnsharpMask(radius=1.2, percent=45, threshold=4))
            note = "轻度锐化（radius 1.2 / 45%）—— 低清块刻意保守，不补内容"

        after = measure_sharpness(result)
        out = args.out or (os.path.splitext(args.image)[0] + "_enh.jpg")
        if out.lower().endswith(".png"):
            result.save(out, "PNG")
        else:
            result.convert("RGB").save(out, "JPEG", quality=args.quality, optimize=True)

        print("out=%s" % out)
        print("level=%s" % level)
        print("sharpness_before=%.1f" % before)
        print("sharpness_after=%.1f" % after)
        print("size=%dx%d" % (result.width, result.height))
        print("bytes=%d" % os.path.getsize(out))
        print("note=%s" % note)
        print("caution=颜色判断请在增强【之前】的图上取色；增强会改局部像素值")
    return 0


def cmd_localize(args):
    """
    判断"这一块里目标大概在哪"，用于**多级下钻**（哪里看不清就继续裁哪里）。

    做法：边缘密度分布 —— 内容密集处通常是主体，大片低密度区通常是背景/留白。
    输出建议的下一级裁剪框（可以反复调用，逐级收紧）。
    """
    import numpy as np
    from PIL import ImageFilter

    with Image.open(args.image) as im:
        im = im.convert("RGB")
        w, h = im.size
        edges = np.asarray(im.convert("L").filter(ImageFilter.FIND_EDGES), dtype="float32")
        dens = (edges > args.edge_threshold).astype("float32")

        # 切成 NxN 网格，找密度最高的连通区（简化：找最密集的 grid 及其邻域）
        n = args.grid
        gh, gw = h // n, w // n
        best = (-1, 0, 0)
        for gy in range(n):
            for gx in range(n):
                cell = dens[gy * gh:(gy + 1) * gh, gx * gw:(gx + 1) * gw]
                s = float(cell.mean())
                if s > best[0]:
                    best = (s, gx, gy)

        _, bx, by = best
        # 以最密的格子为中心，取 2x2 格（若在边上则贴边）
        x1 = max(0, (bx - 0) * gw)
        y1 = max(0, (by - 0) * gh)
        x2 = min(w, x1 + 2 * gw)
        y2 = min(h, y1 + 2 * gh)

        print("dense_cell=%d,%d (density=%.3f)" % (bx, by, best[0]))
        print("suggest=%d,%d,%d,%d" % (x1, y1, x2, y2))
        print("size=%dx%d" % (x2 - x1, y2 - y1))
        print("note=这是「内容最密」的 2x2 格，通常就是主体所在；可对结果继续 localize/crop 下钻")
    return 0

    """
    用边缘密度在给定框附近**收紧/微调**，去掉大片空白背景。

    输入：一个粗略的框（通常来自视觉模型照网格读出的坐标）。
    做法：在框内做 Canny 边缘统计，裁掉四周"几乎没有边缘"的空白带。

    为什么值得做：模型照网格读出的框往往偏大（把背景也框进来），
    而偏大的框意味着放大后主体占比更小 —— 那正是"看不清楚"的原因。
    """
    import numpy as np
    with Image.open(args.image) as im:
        im = im.convert("RGB")
        w, h = im.size
        x1, y1, x2, y2 = clamp_region(parse_region(args.region), w, h)

        crop = np.asarray(im.crop((x1, y1, x2, y2)))
        gray = (0.299 * crop[:, :, 0] + 0.587 * crop[:, :, 1] + 0.114 * crop[:, :, 2]).astype("uint8")

        # 用 PIL 自带的 FIND_EDGES，避免依赖 cv2
        from PIL import ImageFilter
        edges = np.asarray(im.crop((x1, y1, x2, y2)).convert("L").filter(ImageFilter.FIND_EDGES))
        density = (edges > args.edge_threshold).astype("uint8")

        # 逐边往里收：如果某条边附近的边缘密度极低，说明是空白背景
        col = density.sum(axis=0)          # 每列的边缘像素数
        row = density.sum(axis=1)          # 每行
        ch, cw = density.shape
        thr_c = max(1, int(ch * args.min_ratio))
        thr_r = max(1, int(cw * args.min_ratio))

        nx1, nx2, ny1, ny2 = 0, cw - 1, 0, ch - 1
        while nx1 < nx2 and col[nx1] < thr_c:
            nx1 += 1
        while nx2 > nx1 and col[nx2] < thr_c:
            nx2 -= 1
        while ny1 < ny2 and row[ny1] < thr_r:
            ny1 += 1
        while ny2 > ny1 and row[ny2] < thr_r:
            ny2 -= 1

        fx1, fy1, fx2, fy2 = x1 + nx1, y1 + ny1, x1 + nx2 + 1, y1 + ny2 + 1
        print("in=%d,%d,%d,%d" % (x1, y1, x2, y2))
        print("out=%d,%d,%d,%d" % (fx1, fy1, fx2, fy2))
        print("size=%dx%d" % (fx2 - fx1, fy2 - fy1))
        print("shrink=%.0f%%" % (100 - 100.0 * (fx2 - fx1) * (fy2 - fy1) / max(1, (x2 - x1) * (y2 - y1))))
        print("note=这仍是**只裁不补**：没有改变任何画面内容，只是去掉了空白边")
    return 0



def main():
    ap = argparse.ArgumentParser(description="识图的算法层：尺寸 / 主色 / 裁图放大")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("size", help="图片尺寸与建议")
    p.add_argument("image")
    p.set_defaults(func=cmd_size)

    p = sub.add_parser("color", help="主色（可指定区域）")
    p.add_argument("image")
    p.add_argument("--top", type=int, default=8)
    p.add_argument("--region", help="x1,y1,x2,y2；不给就是整图")
    p.set_defaults(func=cmd_color)

    p = sub.add_parser("crop", help="裁出区域并放大（看细节必备）")
    p.add_argument("image")
    p.add_argument("--region", required=True, help="x1,y1,x2,y2")
    p.add_argument("--out")
    p.add_argument("--scale", type=float, default=3.0, help="放大倍数，默认 3")
    p.add_argument("--max-pixels", type=int, default=9_000_000,
                   help="输出像素上限（默认 900 万）；超了自动降倍数")
    p.add_argument("--png", action="store_true",
                   help="存 PNG（无损，但复杂图会大到几 MB）；默认 JPEG q88")
    p.add_argument("--quality", type=int, default=88, help="JPEG 质量")
    p.set_defaults(func=cmd_crop)

    p = sub.add_parser("grid", help="按网格切块（不知道目标在哪时用）")
    p.add_argument("image")
    p.add_argument("--cols", type=int, default=3)
    p.add_argument("--rows", type=int, default=3)
    p.add_argument("--outdir")
    p.set_defaults(func=cmd_grid)

    p = sub.add_parser("locate", help="生成带格子编号的向导图（给视觉模型选格子定位主体）")
    p.add_argument("image")
    p.add_argument("--out")
    p.add_argument("--grid", type=int, default=4, help="格子数 NxN，默认 4")
    p.set_defaults(func=cmd_locate)

    p = sub.add_parser("refine", help="按边缘密度收紧一个粗略框（去掉大片空白）")
    p.add_argument("image")
    p.add_argument("--region", required=True, help="粗略框 x1,y1,x2,y2")
    p.add_argument("--edge-threshold", type=int, default=40)
    p.add_argument("--min-ratio", type=float, default=0.02, help="一行/一列至少要有的边缘像素占比")
    p.set_defaults(func=cmd_refine)

    p = sub.add_parser("enhance", help="分级增强（按清晰度决定锐化强度，绝不补内容）")
    p.add_argument("image")
    p.add_argument("--out")
    p.add_argument("--level", default="auto", choices=["auto", "none", "sharp", "mid", "soft"],
                   help="auto=按拉普拉斯方差自动定档")
    p.add_argument("--quality", type=int, default=88, help="JPEG 质量")
    p.set_defaults(func=cmd_enhance)

    p = sub.add_parser("localize", help="找出「内容最密」的一块（多级下钻用）")
    p.add_argument("image")
    p.add_argument("--grid", type=int, default=3, help="切成 NxN 评估密度")
    p.add_argument("--edge-threshold", type=int, default=40)
    p.set_defaults(func=cmd_localize)

    args = ap.parse_args()
    if not os.path.isfile(args.image):
        print("ERROR: 找不到图片 %s" % args.image)
        return 2
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
