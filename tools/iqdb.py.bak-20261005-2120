#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""iqdb.py —— IQDB 反向搜图（图库检索）+ danbooru 结构化元数据

════════════════════════════════════════════════════════════════
三个反向搜图，各管一段（别互相替代）
════════════════════════════════════════════════════════════════

    trace-moe.py   动画截图     → 第几集、第几秒
    saucenao.py    插画/同人图   → 画师、pixiv ID、相似度
    iqdb.py        图库检索     → 图库帖子 ID + **结构化标签**

**IQDB 的独门本事是"能拿到图库 ID"。** 拿到 ID 之后就能查 danbooru 的
JSON API，换来画师 / 角色 / 作品 / 来源这类**结构化字段** ——
这比一个相似度百分比有用得多（百分比只能告诉你"像"，标签能告诉你"是谁"）。

════════════════════════════════════════════════════════════════
怎么来的（留档，别丢）
════════════════════════════════════════════════════════════════

**这个脚本不是凭空写的** —— 是云端的 QQ 机器人**自己在实战里摸出来的**。

2026-10-05 它为了回答"这张图是谁画的、哪个角色"，在没有现成工具的情况下：
    ① curl 探测六个搜图站点，看哪些通
    ② 试出 IQDB 接受 POST 表单（`file` + `service[]`）
    ③ 从返回的 HTML 里抠 `Best match` 段的链接
    ④ 发现链接指向 danbooru 帖子 ID，改调 danbooru 的 JSON API
    ⑤ 拿到 `tag_string_artist` / `tag_string_character` / `source`

**本鱼把它固化下来** —— 下次不必重新摸一遍。这正是"探索 → 沉淀 → 固化"
那套循环的第一次实践。

════════════════════════════════════════════════════════════════
用法
════════════════════════════════════════════════════════════════

    python3 iqdb.py 图片.jpg
    python3 iqdb.py 图片.jpg --top 3
    python3 iqdb.py 图片.jpg --no-meta      # 跳过 danbooru 元数据，快一些
    python3 iqdb.py 图片.jpg --json         # 原始结果

════════════════════════════════════════════════════════════════
判据（与另外两个脚本同一套纪律）
════════════════════════════════════════════════════════════════

    ≥ 90%   可以说「就是这张」
    80~90%  只能说「看着像」
    < 80%   别提
    没匹配  说「图库里没查到」—— 原创图 / AI 图 / 私人图不在库里，这很正常
"""

import argparse
import hashlib
import html as html_mod
import json
import os
import re
import sys
import urllib.error
import urllib.request

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# requests 更好用（自动处理重定向与 multipart）；没有就退回标准库
try:
    import requests  # type: ignore
    _HAS_REQUESTS = True
except ImportError:
    _HAS_REQUESTS = False

IQDB = "https://iqdb.org/"
DANBOORU = "https://danbooru.donmai.us"

# ⚠️ **两个站点要不同的 UA** —— 这是实测出来的，不是猜的（2026-10-05）：
#
#   IQDB   ：浏览器 UA → 200；不带 UA 反而不稳
#   danbooru：**浏览器 UA → 403**；`curl/7.81.0` 或**自报家门** → 200
#
# 反直觉的地方在于 danbooru：它拦的恰恰是"浏览器 UA"——
# 只有 UA 像浏览器、却没有配套的浏览器头，会被判定成爬虫直接 403。
# 而老实自报家门的那种请求，它放行。
UA_WEB = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
          "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
UA_API = "saya-qqbot-iqdb/1.0 (+https://github.com/sayasaikou/saya-qqbot)"

# IQDB 的 service[] 编号：1=danbooru 2=gelbooru 3=konachan 4=yande.re 5=sankaku 6=e-shuushuu
SERVICES = ["1", "2", "3", "4", "5", "6"]

SIM_CERTAIN = 90.0
SIM_LIKELY = 80.0


def _read(path):
    with open(path, "rb") as fh:
        return fh.read()


def search_iqdb(path, timeout=45):
    """把图 POST 给 IQDB，返回 HTML 文本。"""
    data = _read(path)
    if _HAS_REQUESTS:
        resp = requests.post(
            IQDB,
            files={"file": (os.path.basename(path) or "q.jpg", data, "image/jpeg")},
            data={"service[]": SERVICES},
            headers={"User-Agent": UA},
            timeout=timeout,
        )
        return resp.status_code, resp.text

    # ── 标准库兜底（手工拼 multipart）──
    boundary = "----iqdb-boundary-7f3a9c"
    body = []
    for s in SERVICES:
        body.append(("--" + boundary + "\r\n").encode())
        body.append(b'Content-Disposition: form-data; name="service[]"\r\n\r\n')
        body.append(s.encode() + b"\r\n")
    body.append(("--" + boundary + "\r\n").encode())
    body.append(('Content-Disposition: form-data; name="file"; filename="%s"\r\n'
                 % os.path.basename(path)).encode())
    body.append(b"Content-Type: image/jpeg\r\n\r\n")
    body.append(data + b"\r\n")
    body.append(("--" + boundary + "--\r\n").encode())
    payload = b"".join(body)
    req = urllib.request.Request(
        IQDB, data=payload,
        headers={"Content-Type": "multipart/form-data; boundary=" + boundary,
                 "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read().decode("utf-8", "replace")


def parse_best(html_text):
    """从 IQDB 的结果页里抠出最佳匹配。

    返回 dict：link / similarity / size / tags / raw_tag_alt
    IQDB 的结果结构（实测）：
        <div class="pages">… <a href="//danbooru.donmai.us/posts/12213877"> …
        <img alt="Rating: s Score: 2 Tags: 1girl aqua_hair …">
        相似度在 "Best match" 前面的 "97% similarity" 里
    """
    out = {"link": None, "similarity": None, "size": None, "tags": None}
    i = html_text.find("Best match")
    seg = html_text[i:i + 4000] if i >= 0 else html_text[:4000]

    m = re.search(r'href="(//[^"]+|https?://[^"]+)"', seg)
    if m:
        link = m.group(1)
        if link.startswith("//"):
            link = "https:" + link
        out["link"] = link

    m = re.search(r"(\d{2,3}(?:\.\d+)?)\s*%\s*similarity", seg)
    if m:
        out["similarity"] = float(m.group(1))

    m = re.search(r"(\d+)\s*×\s*(\d+)", seg)
    if m:
        out["size"] = "%sx%s" % (m.group(1), m.group(2))

    m = re.search(r'alt="Rating[^"]*"', seg)
    if m:
        alt = html_mod.unescape(m.group(0))
        out["raw_tag_alt"] = alt
        t = re.search(r"Tags:\s*(.+)$", alt)
        if t:
            out["tags"] = t.group(1).strip().strip('"')
    return out


def danbooru_meta(post_id, timeout=30):
    """用 danbooru 的 JSON API 拿结构化字段（画师 / 角色 / 作品 / 来源）。

    ⚠️ **要两级兜底**（实测教训）：云端直连 `danbooru.donmai.us` 经常拿不到，
    但走 `r.jina.ai` 文本化代理就能通 —— 这是云端 agent 自己摸出来的路子
    （它当时用 `curl https://r.jina.ai/<原URL>` 才读到帖子内容）。
    直连失败就自动退到代理，别让一个网络问题把整个功能废掉。
    """
    url = "%s/posts/%s.json" % (DANBOORU, post_id)
    hdr = {"User-Agent": UA}

    def _parse(raw):
        d = json.loads(raw)
        keys = ("id", "created_at", "rating", "source", "md5",
                "image_width", "image_height", "tag_string_artist",
                "tag_string_character", "tag_string_copyright",
                "tag_string_general", "pixiv_id", "is_deleted", "status")
        return {k: d[k] for k in keys if k in d}

    # ── ① 直连 ──
    try:
        if _HAS_REQUESTS:
            r = requests.get(url, headers=hdr, timeout=timeout)
            if r.status_code == 200:
                return _parse(r.text)
        else:
            req = urllib.request.Request(url, headers=hdr)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return _parse(resp.read().decode("utf-8", "replace"))
    except Exception:
        pass

    # ── ② r.jina.ai 代理兜底（它可能把 JSON 包在 Markdown 里，所以抠出第一个 {…}）──
    try:
        proxied = "https://r.jina.ai/" + url
        if _HAS_REQUESTS:
            r = requests.get(proxied, headers=hdr, timeout=timeout)
            raw = r.text
        else:
            req = urllib.request.Request(proxied, headers=hdr)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8", "replace")
        m = re.search(r"\{.*\}", raw, re.S)
        if m:
            return _parse(m.group(0))
    except Exception:
        pass

    return None


def main():
    ap = argparse.ArgumentParser(description="IQDB 反向搜图 + danbooru 元数据")
    ap.add_argument("image", help="本地图片路径")
    ap.add_argument("--top", type=int, default=1, help="参考用；IQDB 主要给最佳匹配")
    ap.add_argument("--no-meta", action="store_true", help="不查 danbooru 元数据（更快）")
    ap.add_argument("--json", action="store_true", help="输出原始 JSON")
    args = ap.parse_args()

    if not os.path.isfile(args.image):
        print("ERROR: 找不到图片: %s" % args.image)
        return 2

    try:
        status, text = search_iqdb(args.image)
    except Exception as e:
        print("请求失败: %s: %s" % (type(e).__name__, e))
        print("⇒ 网络不通或者 IQDB 挂了。**失败一次就停，别反复重试**（会拖过 QQ 的 5 分钟窗口）")
        return 1

    if status != 200:
        print("HTTP %d —— IQDB 没正常响应" % status)
        return 1

    best = parse_best(text)
    if not best.get("link"):
        print("没有匹配（这张图不在 IQDB 收录的图库里）")
        print("note=IQDB 收录 danbooru / gelbooru / konachan / yande.re / sankaku 等图库；")
        print("      **原创图 / AI 图 / 私人图不在库里，认不出是正常的**，别硬套。")
        return 0

    result = {"iqdb": best, "image_md5": hashlib.md5(_read(args.image)).hexdigest()}

    # ── 如果最佳匹配是 danbooru 帖子，顺手拿结构化元数据 ──
    pid = None
    m = re.search(r"danbooru\.donmai\.us/posts/(\d+)", best["link"])
    if m:
        pid = m.group(1)
    if pid and not args.no_meta:
        meta = danbooru_meta(pid)
        if meta:
            result["danbooru"] = meta

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    # ── 人类（模型）可读的输出 ──
    print("best_link=%s" % best["link"])
    if best.get("similarity") is not None:
        print("similarity=%.1f%%" % best["similarity"])
    if best.get("size"):
        print("库中尺寸=%s" % best["size"])

    d = result.get("danbooru")
    if d:
        if d.get("tag_string_artist"):
            print("画师=%s" % d["tag_string_artist"])
        if d.get("tag_string_character"):
            print("角色=%s" % d["tag_string_character"])
        if d.get("tag_string_copyright"):
            print("作品=%s" % d["tag_string_copyright"])
        if d.get("pixiv_id"):
            print("pixiv_id=%s" % d["pixiv_id"])
        if d.get("source"):
            print("来源=%s" % str(d["source"])[:200])
        if d.get("created_at"):
            print("投稿时间=%s" % d["created_at"])
        if d.get("tag_string_general"):
            print("标签=%s" % d["tag_string_general"][:200])
    elif best.get("tags"):
        print("标签=%s" % best["tags"][:200])
    elif pid:
        print("（danbooru 元数据没取到，但帖子 ID 是 %s）" % pid)

    sim = best.get("similarity")
    print("")
    if sim is None:
        print("verdict=unknown  没读到相似度，按「看着像」说，别说死")
    elif sim >= SIM_CERTAIN:
        print("verdict=high     可以说「就是这张」")
    elif sim >= SIM_LIKELY:
        print("verdict=medium   只能说「看着像」，不要说死")
    else:
        print("verdict=low      存疑 —— 可能只是画风相近，**不要当确证**")
    print("caution=IQDB 查的是图库；原创图 / AI 图 / 私人图认不出是正常的。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
