#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
qqbot-status.py —— 早上的「机器状态」私聊（T-023，2026-10-06）。

架构（先讲清，不然会误以为云端能看他的机器）：
    QQ bot 跑在**云服务器**上 —— 它**摸不到他笔记本的 GPU**。
    所以：本机 `collect-status.ps1` 每天采一次 → 落到 `机器状态\\公开\\机器状态.md`
    → 本机同步器推到云端 `~/notes/机器状态/机器状态.md` → **这个脚本读那份** → 私聊他。

⚠️ 两条纪律：
    ① **陈旧就不报**：文件里的采集时间超过 `MAX_AGE_HOURS` 就当"机器没开机"，**一个字都不发**
       （宁可不说，也别拿昨天的数当今天的报）。
    ② **念一行，别念整篇**：只取「## 今天（一行）」那行；他要细节会自己问。
"""
import datetime
import json
import os
import re
import sys
import urllib.request

HOME = os.path.expanduser('~')
QQBOT = os.path.join(HOME, 'qqbot')
DATA = os.path.join(QQBOT, 'data')
KEYS = os.path.join(HOME, '.qqbot-keys')
OWNER_FILE = os.path.join(DATA, 'owner-openid.txt')
STATUS_FILE = os.path.join(HOME, 'notes', '机器状态', '机器状态.md')
STATE = os.path.join(DATA, 'status-report-state.json')
LOG = os.path.join(HOME, 'qqbot-status.log')

# ⚠️ 说清时间关系（2026-10-06 本鱼自己踩的坑）：
#   本机 12:34 采集 → 12:35 同步上云 → 云端「次日」08:30 念。
#   所以正常情况数据就是「昨天中午」的 ⇒ 约 20 小时旧。
#   原来写 8 小时 ⇒ 几乎永远判「太旧」、永远不发（等于功能白做）。
#   26 小时 = 允许「昨天中午那份」；机器连着两天没开才判过期。
MAX_AGE_HOURS = 26         # 超过这么久 ⇒ 当他机器一直没开，不发
TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
API_BASE = 'https://api.sgroup.qq.com'


def log(msg):
    line = '%s  %s' % (datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'), msg)
    print(line)
    try:
        with open(LOG, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except Exception:
        pass


def key(name):
    with open(os.path.join(KEYS, name), encoding='utf-8') as f:
        return f.read().strip()


def owner_openid():
    if os.path.exists(OWNER_FILE):
        v = open(OWNER_FILE, encoding='utf-8').read().strip()
        if v:
            return v
    # 兜底：从关系/发言记录里找管理员（与 health-check 同一套）
    try:
        cfg = os.path.join(HOME, '.dsh', 'profiles', 'qqbot', 'cordis.patch.yml')
        m = re.search(r'adminOpenIds:\s*\n\s*-\s*([0-9A-Fa-f]{32})', open(cfg, encoding='utf-8').read())
        if m:
            return m.group(1).upper()
    except Exception:
        pass
    return None


def send_private(openid, text):
    body = json.dumps({'appId': key('qqbot-appid.txt'), 'clientSecret': key('qqbot-secret.txt')}).encode()
    req = urllib.request.Request(TOKEN_URL, data=body, headers={'Content-Type': 'application/json'})
    token = json.load(urllib.request.urlopen(req, timeout=30))['access_token']
    payload = json.dumps({'content': text, 'msg_type': 0}).encode()
    req2 = urllib.request.Request(
        '%s/v2/users/%s/messages' % (API_BASE, openid), data=payload,
        headers={'Content-Type': 'application/json', 'Authorization': 'QQBot %s' % token,
                 'X-Union-Appid': key('qqbot-appid.txt')})
    r = urllib.request.urlopen(req2, timeout=30)
    return r.status


def read_status():
    """返回 (采集时间 datetime, 一行摘要) 或 (None, None)"""
    if not os.path.exists(STATUS_FILE):
        return None, None
    try:
        txt = open(STATUS_FILE, encoding='utf-8').read()
    except Exception as e:
        log('读不了状态文件: %s' % e)
        return None, None
    m = re.search(r'采集时间：(\d{4}-\d{2}-\d{2} \d{2}:\d{2})', txt)
    at = None
    if m:
        try:
            at = datetime.datetime.strptime(m.group(1), '%Y-%m-%d %H:%M')
        except Exception:
            at = None
    # 取「## 今天（一行）」之后的第一段非空文本
    line = None
    mm = re.search(r'##\s*今天（一行）\s*\n+(.+)', txt)
    if mm:
        line = mm.group(1).strip()
    return at, line


def main(argv):
    dry = '--dry-run' in argv
    force = '--force' in argv          # 无视新鲜度与"今天已报过"

    at, line = read_status()
    if not at or not line:
        log('没有可用的状态文件（%s）—— 不发' % STATUS_FILE)
        return 0

    age_h = (datetime.datetime.now() - at).total_seconds() / 3600.0
    if age_h > MAX_AGE_HOURS and not force:
        log('状态太旧（采集于 %s，%.1f 小时前）⇒ 当他机器没开，不发'
            % (at.strftime('%m-%d %H:%M'), age_h))
        return 0

    today = datetime.date.today().isoformat()
    try:
        st = json.load(open(STATE, encoding='utf-8')) if os.path.exists(STATE) else {}
    except Exception:
        st = {}
    if st.get('lastDate') == today and not force:
        log('今天已经报过了（%s）—— 跳过' % today)
        return 0

    # 带上数据时间 —— 这是快照、不是实时读数，别让人误会（诚实优先）
    text = '【机器状态 · 截至 %s】%s' % (at.strftime('%m-%d %H:%M'), line)
    if dry:
        log('--dry-run 会发这条（采集于 %s，%.1f 小时前）：' % (at.strftime('%m-%d %H:%M'), age_h))
        print(text)
        return 0

    oid = owner_openid()
    if not oid:
        log('找不到超管 openid —— 不发')
        return 2
    try:
        code = send_private(oid, text)
        log('已发（HTTP %s）: %s' % (code, text[:80]))
        json.dump({'lastDate': today, 'lastAt': at.strftime('%Y-%m-%d %H:%M')},
                  open(STATE, 'w', encoding='utf-8'))
    except Exception as e:
        log('发送失败: %s' % e)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
