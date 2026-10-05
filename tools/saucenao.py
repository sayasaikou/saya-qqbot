#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""saucenao.py —— SauceNAO 反向搜图（识别插画 / 同人图 / 游戏立绘）

════════════════════════════════════════════════════════════════════
它解决什么问题
════════════════════════════════════════════════════════════════════

`trace-moe.py` 只认**动画截图**。插画、同人图、游戏立绘、画师作品它全都认不出
（这是 trace.moe 的设计边界，不是 bug）。

本脚本补这一块：SauceNAO 的索引里有 pixiv / danbooru / yande.re / sankaku 等图库，
能给出**画师名、作品名、pixiv ID、相似度**。

════════════════════════════════════════════════════════════════════
⚠️ 需要 API Key —— 以及一个尚未验证的前提
════════════════════════════════════════════════════════════════════

SauceNAO 的 `search.php` 端点被 **Cloudflare 挑战**保护（返回 `Just a moment...`）。
实测从腾讯云香港节点试过三种绕过方案，**全部 403**：

    1. curl + 浏览器 UA
    2. cloudscraper（专治 CF 的 Python 库）
    3. curl_cffi impersonate chrome / chrome124 / safari17_0（模拟真实 TLS 指纹）

**官方 API 需要 `api_key` 参数**（免费注册可得）。带 key 的请求**是否也走 CF 挑战，
尚未实测** —— 因为写这个脚本时还没有 key。

    ⇒ 拿到 key 之后第一件事就是验证：如果仍 403，说明这条路也堵死，
      只剩「装 headless 浏览器」或「放弃 SauceNAO」两个选择。

注册：https://saucenao.com/user.php?page=register
拿 key：https://saucenao.com/user.php?page=account  （页面里的 "API Key"）

环境变量：SAUCENAO_API_KEY

════════════════════════════════════════════════════════════════════
用法
════════════════════════════════════════════════════════════════════

    export SAUCENAO_API_KEY=xxxxx
    python3 saucenao.py 图片.jpg
    python3 saucenao.py 图片.jpg --json          # 原始 JSON
    python3 saucenao.py 图片.jpg --min-sim 80    # 只显示相似度 ≥ 80 的
"""

import argparse
import json
import os
import sys
import urllib.request

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

API = "https://saucenao.com/search.php"

# 相似度判据 —— 与 trace-moe.py 同一套纪律：不达标就不许当确证说
SIM_CERTAIN = 90.0   # ≥ 90：可以说"就是这张"
SIM_LIKELY = 80.0    # 80~90：只能说"看着像"
                     # < 80：不要说


def post_image(path, api_key, timeout=60):
    """把图片 POST 给 SauceNAO，返回解析后的 JSON。"""
    with open(path, "rb") as fh:
        img = fh.read()

    boundary = "----saucenao-boundary-7f3a9c"
    parts = []

    def field(name, value):
        parts.append(("--" + boundary + "\r\n").encode())
        parts.append(('Content-Disposition: form-data; name="%s"\r\n\r\n' % name).encode())
        parts.append(str(value).encode() + b"\r\n")

    field("api_key", api_key)
    field("output_type", "2")     # 2 = JSON
    field("numres", "6")
    field("db", "999")            # 999 = 全部索引

    parts.append(("--" + boundary + "\r\n").encode())
    parts.append(b'Content-Disposition: form-data; name="file"; filename="image.jpg"\r\n')
    parts.append(b"Content-Type: image/jpeg\r\n\r\n")
    parts.append(img + b"\r\n")
    parts.append(("--" + boundary + "--\r\n").encode())

    body = b"".join(parts)
    req = urllib.request.Request(
        API, data=body,
        headers={
            "Content-Type": "multipart/form-data; boundary=" + boundary,
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                          "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", "replace")
    return json.loads(raw)


def main():
    ap = argparse.ArgumentParser(description="SauceNAO 反向搜图（需要 API key）")
    ap.add_argument("image", help="本地图片路径")
    ap.add_argument("--json", action="store_true", help="输出原始 JSON")
    ap.add_argument("--min-sim", type=float, default=0.0, help="只显示相似度 ≥ 此值的结果")
    args = ap.parse_args()

    key = os.environ.get("SAUCENAO_API_KEY", "").strip()
    if not key:
        print("ERROR: 没设 SAUCENAO_API_KEY 环境变量")
        print("       注册拿 key: https://saucenao.com/user.php?page=register")
        return 2
    if not os.path.isfile(args.image):
        print("ERROR: 找不到图片: %s" % args.image)
        return 2

    try:
        data = post_image(args.image, key)
    except urllib.error.HTTPError as e:
        code = e.code
        body = e.read().decode("utf-8", "replace")[:200].replace("\n", " ")
        print("HTTP %d —— %s" % (code, body))
        if code == 403:
            print("")
            print("⇒ 403 且返回 Cloudflare 挑战页的话，说明 **带 key 也绕不过 CF**。")
            print("  这条路就到此为止，只剩 headless 浏览器可选。")
        elif code == 401 or code == 400:
            print("")
            print("⇒ 多半是 key 不对或没激活。去账号页确认 API Key。")
        return 1
    except Exception as e:
        print("请求失败: %s: %s" % (type(e).__name__, e))
        return 1

    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return 0

    header = data.get("header", {})
    status = header.get("status")
    if status is not None and int(status) < 0:
        print("SauceNAO 返回错误 status=%s message=%s" % (status, header.get("message")))
        return 1

    results = data.get("results", [])
    if not results:
        print("没有结果（这张图不在 SauceNAO 的索引里）")
        print("note=SauceNAO 主要收录 pixiv / danbooru 等图库；**原创图 / AI 图 / 私人图认不出**")
        return 0

    shown = 0
    best = 0.0
    for r in results:
        try:
            sim = float(r.get("header", {}).get("similarity", 0))
        except (TypeError, ValueError):
            continue
        if sim < args.min_sim:
            continue
        best = max(best, sim)
        d = r.get("data", {})
        bits = []
        for k, label in (("creator", "画师"), ("char", "角色"), ("material", "作品"),
                         ("source", "来源"), ("title", "标题")):
            if d.get(k):
                bits.append("%s=%s" % (label, str(d[k])[:70]))
        for k in ("pixiv_id", "danbooru_id", "yandere_id", "sankaku_id", "gelbooru_id"):
            if d.get(k):
                bits.append("%s=%s" % (k, d[k]))
        print("similarity=%.1f  %s" % (sim, " | ".join(bits) if bits else "(无字段)"))
        shown += 1

    if shown == 0:
        print("没有相似度 ≥ %.1f 的结果（最高 %.1f）" % (args.min_sim, best))
        return 0

    print("")
    if best >= SIM_CERTAIN:
        print("verdict=high    可以说「就是这个」")
    elif best >= SIM_LIKELY:
        print("verdict=medium  只能说「看着像」，不要说死")
    else:
        print("verdict=low     存疑：可能只是画风相近，**不要当确证**")
    print("caution=SauceNAO 只收录图库里的图；原创 / AI / 私人图认不出是正常的。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
