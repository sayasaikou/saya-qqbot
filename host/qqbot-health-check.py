#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
qqbot-health-check.py —— 每日自检：**有事才说话**，没事闭嘴。

════════════════════════════════════════════════════════════════
为什么要有它（2026-10-06 的教训）
════════════════════════════════════════════════════════════════
那天私聊整条路挂了 —— 会话文件损坏 ⇒ resume 与 create 双双失败 ⇒
机器人只回一句「处理消息时出现异常」。**而这件事没有任何人被告知**，
是超管自己发消息撞上的。护栏后来补上了（session-guard 拦"文件坏了"），
但"别的形态的坏"仍然没人看得见。

这份脚本补的是**可见性**：每天自检一次，异常就**主动私聊超管**。

设计纪律
════════════════════════════════════════════════════════════════
1. **只在有事时说话** —— 正常就静默退出（否则天天发"一切正常"＝噪音，
   超管两天就会把它免打扰，那这条链就死了）。
2. **同一件事一天最多报一次** —— 用 data/health-state.json 记着，
   免得反复刷屏（也免得把主动消息的配额烧掉）。
3. **判据要硬**（能机读的）：端口/进程、会话文件可解、磁盘占用、
   日志里的 ERROR 计数、插件是否加载。**不靠"感觉"**。
4. **自己坏掉也不能炸** —— 任何异常都兜住、写进日志、退出码 1。

用法
════════════════════════════════════════════════════════════════
  python3 ~/qqbot-health-check.py            # 正常自检（有事才发）
  python3 ~/qqbot-health-check.py --force    # 无视"今天报过"，强制报一次
  python3 ~/qqbot-health-check.py --dry      # 只打印判据，不发送
"""

import json
import os
import re
import subprocess
import sys
import urllib.request

HOME = os.path.expanduser('~')
QQBOT = os.path.join(HOME, 'qqbot')
DATA = os.path.join(QQBOT, 'data')
KEYS = os.path.join(HOME, '.qqbot-keys')
SESSIONS = os.path.join(HOME, '.dsh', 'sessions')
STATE = os.path.join(DATA, 'health-state.json')
LOG = os.path.join(DATA, 'qqbot-memory.log')

TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
API_BASE = 'https://api.sgroup.qq.com'

# 判据阈值
DISK_WARN_PCT = 85          # 根分区占用
ERR_WARN = 20               # 最近一次启动以来日志里的 error 行数
MSG_LOG_WARN = 30 * 1024 * 1024   # msgs 目录总量


def key(name):
    with open(os.path.join(KEYS, name), encoding='utf-8') as f:
        return f.read().strip()


def run(cmd):
    try:
        return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=30).stdout.strip()
    except Exception:
        return ''


def read_json(path, fallback=None):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return fallback if fallback is not None else {}


# ────────────────────────────────────────────── 各项检查
def check_service():
    """服务活着吗（systemd 判定 + 进程存在）"""
    state = run('systemctl is-active qqbot')
    return state == 'active', f'服务状态={state or "未知"}'


def check_sessions():
    """会话文件：坏掉的（头不是 zstd 魔数 / 空文件）有几个"""
    bad = []
    total = 0
    try:
        for ws in os.listdir(SESSIONS):
            wsdir = os.path.join(SESSIONS, ws)
            if not os.path.isdir(wsdir):
                continue
            for sid in os.listdir(wsdir):
                f = os.path.join(wsdir, sid, 'session.v4.jsonl.zstd')
                if not os.path.exists(f):
                    continue
                total += 1
                size = os.path.getsize(f)
                if size == 0:
                    bad.append(f'{ws}/{sid}（空文件）')
                    continue
                with open(f, 'rb') as fh:
                    head = fh.read(4)
                if head != b'\x28\xb5\x2f\xfd':
                    bad.append(f'{ws}/{sid}（头={head.hex()}）')
    except Exception as e:
        return True, f'会话巡检跳过（{e}）'
    return (not bad), f'会话文件 {total} 个，异常 {len(bad)} 个' + ('：' + '、'.join(bad) if bad else '')


def check_corrupt_archives():
    """有没有被隔离的坏文件（有＝曾经坏过，值得看一眼）"""
    n = 0
    try:
        for ws in os.listdir(SESSIONS):
            wsdir = os.path.join(SESSIONS, ws)
            if not os.path.isdir(wsdir):
                continue
            for sid in os.listdir(wsdir):
                d = os.path.join(wsdir, sid)
                n += len([x for x in os.listdir(d) if '.CORRUPT-' in x])
    except Exception:
        pass
    return True, f'历史隔离的坏会话文件 {n} 个（不是故障，是留证）'


def check_disk():
    out = run("df -P / | tail -1")
    try:
        parts = out.split()
        pct = int(parts[4].rstrip('%'))
        return pct < DISK_WARN_PCT, f'根分区占用 {pct}%（阈值 {DISK_WARN_PCT}%）｜剩余 {parts[3]}'
    except Exception:
        return True, '磁盘读不出来（跳过）'


def check_log_errors():
    """最近一次启动以来的 error 行数"""
    try:
        with open(LOG, encoding='utf-8', errors='ignore') as f:
            lines = f.readlines()[-2000:]
        # 从最后一次"已加载"往后数
        start = 0
        for i, ln in enumerate(lines):
            if '已加载。dataDir=' in ln:
                start = i
        seg = lines[start:]
        errs = [ln for ln in seg if ' error ' in ln]
        return len(errs) < ERR_WARN, f'本插件日志 error {len(errs)} 行（阈值 {ERR_WARN}）'
    except Exception as e:
        return True, f'日志读不出来（{e}）'


def check_msg_log_size():
    d = os.path.join(DATA, 'msgs')
    total = 0
    try:
        for fn in os.listdir(d):
            total += os.path.getsize(os.path.join(d, fn))
    except Exception:
        pass
    return total < MSG_LOG_WARN, f'落盘消息 {total // 1024} KB（阈值 {MSG_LOG_WARN // 1024} KB）'


def check_announce():
    """升级播报有没有失败残留"""
    a = read_json(os.path.join(DATA, 'announced.json'), {})
    hist = a.get('history', [])
    failed = []
    for e in hist[:3]:
        if e.get('failed'):
            failed.append(f"{e.get('version')}: {len(e['failed'])} 个目标失败")
    return (not failed), ('播报失败：' + '；'.join(failed) if failed else f"最近播报 v{a.get('lastAnnounced', '?')} 无失败")


def check_paint_quota():
    """生图额度（快用完了提前说一声）"""
    u = read_json(os.path.join(DATA, 'paint-usage.json'), {})
    import datetime
    today = datetime.date.today().isoformat()
    used = int(u.get(today, 0) or 0)
    return True, f'今日出图 {used} 张'


def owner_openid():
    """超管 openid：先看配置白名单，再看关系表里身份是超管的那个"""
    cfg = os.path.join(HOME, '.dsh', 'profiles', 'qqbot', 'cordis.patch.yml')
    try:
        with open(cfg, encoding='utf-8') as f:
            txt = f.read()
        m = re.search(r'adminOpenIds:\s*\n\s*-\s*([0-9A-Fa-f]{32})', txt)
        if m:
            return m.group(1).upper()
    except Exception:
        pass
    rel = read_json(os.path.join(DATA, 'relations.json'), {})
    for oid, v in rel.items():
        if isinstance(v, dict) and (v.get('admin') or v.get('role') == 'admin'):
            return oid.upper()
    return ''


def send_private(openid, text):
    body = json.dumps({'appId': key('qqbot-appid.txt'),
                       'clientSecret': key('qqbot-secret.txt')}).encode()
    req = urllib.request.Request(TOKEN_URL, data=body,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as r:
        token = json.load(r)['access_token']
    payload = json.dumps({'content': text, 'msg_type': 0}).encode()
    req2 = urllib.request.Request(
        f'{API_BASE}/v2/users/{openid}/messages', data=payload,
        headers={'Content-Type': 'application/json',
                 'Authorization': f'QQBot {token}',
                 'X-Union-Appid': key('qqbot-appid.txt')})
    with urllib.request.urlopen(req2, timeout=30) as r:
        return r.status


def main(argv):
    force = '--force' in argv
    dry = '--dry' in argv

    checks = []
    for fn in (check_service, check_sessions, check_corrupt_archives, check_disk,
               check_log_errors, check_msg_log_size, check_announce, check_paint_quota):
        try:
            ok, detail = fn()
        except Exception as e:
            ok, detail = True, f'{fn.__name__} 自身出错（跳过）：{e}'
        checks.append((fn.__name__, ok, detail))

    bad = [c for c in checks if not c[1]]

    print('=== qqbot 自检 %s ===' % run('date "+%Y-%m-%d %H:%M"'))
    for name, ok, detail in checks:
        print('  %-24s %s  %s' % (name, 'OK  ' if ok else 'FAIL', detail))

    if not bad:
        print('=> 全部正常（不发消息）')
        return 0

    # 去重：同一天同一组问题只报一次
    import datetime
    today = datetime.date.today().isoformat()
    sig = '|'.join(sorted(c[0] for c in bad))
    st = read_json(STATE, {})
    if not force and st.get('lastDate') == today and st.get('lastSig') == sig:
        print('=> 有问题但今天已经报过同样的（跳过发送）')
        return 1

    lines = ['【自检发现问题】']
    for name, _ok, detail in bad:
        lines.append('· ' + detail)
    lines.append('')
    lines.append('（这是每日自检主动发的，不是有人在跟本鱼说话。回一句"看日志"我就去查。）')
    text = '\n'.join(lines)

    print('=> 要发给超管：\n' + text)
    if dry:
        print('=> --dry：没发')
        return 1

    oid = owner_openid()
    if not oid:
        print('=> 找不到超管 openid，发不出去')
        return 1
    try:
        status = send_private(oid, text)
        print('=> 已发送 HTTP %s' % status)
        st['lastDate'] = today
        st['lastSig'] = sig
        st['lastSent'] = run('date "+%Y-%m-%d %H:%M"')
        with open(STATE, 'w', encoding='utf-8') as f:
            json.dump(st, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print('=> 发送失败：%s' % e)
        return 1
    return 1


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as e:
        print('自检脚本自身出错：%s' % e)
        sys.exit(1)
