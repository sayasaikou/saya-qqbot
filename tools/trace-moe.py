#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
trace-moe.py —— 用 trace.moe 反向搜图识别**动画截图**

════════════════════════════════════════════════════════════════════
它解决什么问题
════════════════════════════════════════════════════════════════════

这条识图线一直有个硬伤：**"这是哪个角色"查不出来**。原因是三重的：

  1. 反向搜图（以图搜图）基本全堵 —— 本机实测 sauceNao / ascii2d / Google
     全是 SSL 阻断或超时，而**它们才是识别插画最有效的工具**；
  2. 抓网页正文也基本必挂（DNS 解析不通 + 跨域重定向被硬拦）；
  3. 剩下的文字搜索**对"识别角色"几乎无效** —— 实测拿图上的水印原字去搜，
     返回的是同名的音乐人和 1990 年代游戏 PDF。

**trace.moe 是唯一还通的反向搜图服务**（本机实测：HTTP OK，返回 10 条结果）。
它专门识别**动画截图**，直接给出**作品名 + 集数 + 时间点** —— 这是文字搜索
永远做不到的事。

⚠️ 能力边界（别对它期待过高）
  · **只认动画截图**（TV/剧场版的帧）。插画、同人图、游戏立绘、AI 原创图
    它都认不出来 —— 那些要靠 SauceNAO / ascii2d（等云端部署后再接）。
  · 相似度低于 ~0.85 的结果基本是"画风相近的另一部动画"，**不要当确证用**。

════════════════════════════════════════════════════════════════════
用法
════════════════════════════════════════════════════════════════════

    python trace-moe.py <图片路径> [--cut-borders] [--json] [--min-sim 0.85]

输出（默认给人/模型看的简洁格式）：
    match=作品名 | episode=集数 | at=出现时间 | similarity=0.93
    ...
    verdict=high|medium|low|none

踩过的坑
    第一次调这个 API 返回 **403 Forbidden**，本鱼据此得出"服务不可用"的结论 ——
    **错了**。真正的原因是请求头没写全，补上 `User-Agent` 和 `Accept` 就通了。
    ⇒ 教训：**第三方 API 报 4xx 时先怀疑自己的请求格式，别急着判服务死刑。**
"""

import argparse
import io
import json
import os
import sys
import urllib.error
import urllib.request
import uuid

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

API = "https://api.trace.moe/search"


def post_image(path, cut_borders=False, timeout=90):
    """把本地图片 POST 给 trace.moe（不用公网 URL，也就省了图床）。"""
    boundary = uuid.uuid4().hex
    with open(path, "rb") as fh:
        data = fh.read()

    parts = []
    parts.append(("--" + boundary + "\r\n").encode())
    parts.append((
        'Content-Disposition: form-data; name="file"; filename="%s"\r\n'
        % os.path.basename(path)).encode())
    # ⚠️ 这个 Content-Type 要跟文件真实类型对上，否则服务端可能拒绝
    ext = os.path.splitext(path)[1].lower()
    ctype = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
             ".webp": "image/webp", ".gif": "image/gif"}.get(ext, "application/octet-stream")
    parts.append(("Content-Type: %s\r\n\r\n" % ctype).encode())
    parts.append(data)
    parts.append(("\r\n--" + boundary + "--\r\n").encode())
    body = b"".join(parts)

    url = API + "?anilistInfo=0" + ("&cutBorders=1" if cut_borders else "")
    req = urllib.request.Request(url, data=body, headers={
        "Content-Type": "multipart/form-data; boundary=" + boundary,
        # ⚠️ 这两个头是通了的关键。缺了 UA 会被判 403（本鱼就是这么误判过一次）。
        "User-Agent": "Mozilla/5.0 (compatible; saya-vision/1.0)",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def verdict_of(top_sim):
    if top_sim >= 0.90:
        return "high", "很可信：基本就是这部"
    if top_sim >= 0.85:
        return "medium", "较可信：大概率是这部，但建议再核一眼"
    if top_sim >= 0.70:
        return "low", "存疑：可能只是画风相近的另一部动画，**不要当确证**"
    return "none", "没匹配上：可能不是动画截图（插画/游戏立绘/AI 图它认不出）"


def main():
    ap = argparse.ArgumentParser(description="trace.moe 反向搜图（识别动画截图）")
    ap.add_argument("image")
    ap.add_argument("--cut-borders", action="store_true", help="先裁掉黑边再搜（截图带黑边时有用）")
    ap.add_argument("--json", action="store_true", help="输出原始 JSON")
    ap.add_argument("--min-sim", type=float, default=0.0, help="只显示相似度不低于此值的结果")
    ap.add_argument("--top", type=int, default=5)
    args = ap.parse_args()

    if not os.path.isfile(args.image):
        print("ERROR: 找不到图片 %s" % args.image)
        return 2

    try:
        j = post_image(args.image, args.cut_borders)
    except urllib.error.HTTPError as e:
        print("ERROR: HTTP %s" % e.code)
        try:
            print("  body: %s" % e.read().decode("utf-8", "replace")[:300])
        except Exception:
            pass
        print("  hint: 4xx 先怀疑请求格式（UA / Content-Type / 字段名），别急着判服务不可用")
        return 3
    except Exception as e:
        print("ERROR: %s" % str(e)[:200])
        return 4

    if args.json:
        print(json.dumps(j, ensure_ascii=False, indent=2)[:6000])
        return 0

    results = [r for r in (j.get("result") or []) if r.get("similarity", 0) >= args.min_sim]
    if not results:
        print("results=0")
        print("verdict=none")
        print("note=没有匹配。这张可能不是动画截图（插画 / 游戏立绘 / AI 原创图，"
              "trace.moe 都认不出）；也可能画面太糊或主体太小。")
        return 0

    top = results[0]
    for r in results[: args.top]:
        anilist = r.get("anilist") or {}
        title = anilist.get("title") or {}
        name = title.get("native") or title.get("romaji") or title.get("english") or r.get("filename", "")
        ep = r.get("episode")
        # 把"出现在第几秒"换算成 mm:ss，方便定位
        at = r.get("from")
        at_s = ""
        if isinstance(at, (int, float)):
            at_s = "%d:%02d" % (int(at // 60), int(at % 60))
        print("match=%s | episode=%s | at=%s | similarity=%.3f"
              % (name, ep if ep is not None else "?", at_s or "?", r.get("similarity", 0)))

    v, why = verdict_of(top.get("similarity", 0))
    print("verdict=%s" % v)
    print("note=%s" % why)
    print("caution=trace.moe 只认**动画截图**；插画/同人图/游戏立绘/AI 原创图它认不出。"
          "相似度低于 0.85 的结果不要当确证。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
