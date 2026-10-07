#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
qqbot-announce.py —— 版本升级播报：把 CHANGELOG 里还没播过的那几版，发到它所在的每个群 + 超管私聊。

设计（2026-10-06 饲主定的口径）
════════════════════════════════════════════════════════
· 版本号唯一真源 = `~/qqbot/VERSION`；播报内容唯一来源 = `CHANGELOG.md` 里的
  `<!-- ANNOUNCE -->` 段。**取不到就不发** —— 宁可不发，也别发一条"更新了但不知道更新了什么"。
· 正文用模板（可审、可复现），**开头一句**让"另一个它"按人格现说（饲主要的"模板正文 + 它自己加一句开场"）。
  ⚠️ 那句开场只准依据给定事实，不许编功能 —— 事实由文件提供，模型只负责口气。
· 🔴 **公告口吻（2026-10-06 超管亲口定）：对象是「所有群友」，不是他个人。**
  ⇒ 正文**不许出现**「你」「你自己的」「饲主」「为你做的」「提醒你」这类**对某一个人说话**的写法；
  也不许提内部实现（函数名 / 好感度 / 分数 / 文件路径 / 哪台机器 / 花了多少钱）。
  就讲"这套机器人现在有什么变化"，中性第三人称。**判据：一个陌生人读到它，不觉得是写给别人的私信。**
  ⚠️ 开场句同理（给模型的约束里也写了）。
· 目标 = `data/groups.json` 里的全部群 + 超管私聊；**不 @ 任何人**。
· 幂等：`data/announced.json` 记已播过的版本；同一版只播一次。`--force` 只重播当前版。
· 合并：如果有好几版没播过（比如脚本刚上线），**合并成一条**发出去，不刷屏。

为什么不能用 `dsh --profile qqbot` 唤起一轮：那会再起一个 qqbot 实例、连同一个 AppID
⇒ 消息随机分发（当初就是为这个把本机版停掉的）。所以这里自己走 HTTP：
拿 app access token → 直接调官方发消息接口。

跑法
════════════════════════════════════════════════════════
  python3 ~/qqbot-announce.py --dry-run          # 只看会发什么、发给谁（一个字都不发）
  python3 ~/qqbot-announce.py --only-owner       # 只发给超管私聊（**首次测试用这个**）
  python3 ~/qqbot-announce.py --only-groups      # 只发群（测群这条链路）
  python3 ~/qqbot-announce.py                    # 正式：所有群 + 超管私聊
  python3 ~/qqbot-announce.py --force            # 无视"已播过"，重播当前版
  python3 ~/qqbot-announce.py --no-model         # 开场句用固定文案（不调模型）

退出码：0 = 都发出去了（或没什么可发的）｜2 = 有失败（明细在 stdout 与 announced.json）
"""

import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime

HOME = os.path.expanduser('~')
QQBOT = os.path.join(HOME, 'qqbot')
DATA = os.path.join(QQBOT, 'data')
VERSION_FILE = os.path.join(QQBOT, 'VERSION')
CHANGELOG = os.path.join(QQBOT, 'CHANGELOG.md')
GROUPS = os.path.join(DATA, 'groups.json')
ANNOUNCED = os.path.join(DATA, 'announced.json')
RELATIONS = os.path.join(DATA, 'relations.json')
KEYS = os.path.join(HOME, '.qqbot-keys')
PERSONA = os.path.join(QQBOT, 'home', 'AGENTS.md')
PERSONA_CHARS = 4000

TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
API_BASE = 'https://api.sgroup.qq.com'
SEND_INTERVAL = 1.2          # 群之间歇一下（官方：bot 维度 60/qpm、单群 20/qpm，一条公告远够）
WAIT_SECONDS = 30            # 等它上线的最长时间


# ────────────────────────────────────────────── 小工具

def key(name):
    with open(os.path.join(KEYS, name), encoding='utf-8') as f:
        return f.read().strip()


def load_json(path, default):
    try:
        with open(path, encoding='utf-8') as f:
            obj = json.load(f)
        return obj if isinstance(obj, (dict, list)) else default
    except Exception:
        return default


def save_json(path, obj):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def owner_openid():
    """超管 openid 从关系表里取（role=admin）—— 不写死在脚本里。"""
    rel = load_json(RELATIONS, {})
    for oid, rec in (rel.items() if isinstance(rel, dict) else []):
        if isinstance(rec, dict) and rec.get('role') == 'admin':
            return oid
    return None


# ────────────────────────────────────────────── CHANGELOG 解析

HEAD_RE = re.compile(r'^##\s*\[(\d+\.\d+\.\d+)\]\s*(.*)$', re.M)
ANN_RE = re.compile(r'<!--\s*ANNOUNCE\b([^>]*)-->(.*?)<!--\s*/ANNOUNCE\s*-->', re.S)
# T-024：`target=owner` 的公告**只发超管私聊**（只有他能用的功能，群友看了也用不上）
TARGET_RE = re.compile(r'target\s*=\s*([A-Za-z]+)')


def parse_changelog(path=CHANGELOG):
    """返回 [(version, date, announce_text)]，**新的在前**。没有 ANNOUNCE 段的条目 announce 为 None。"""
    try:
        with open(path, encoding='utf-8') as f:
            text = f.read()
    except Exception:
        return []
    marks = list(HEAD_RE.finditer(text))
    out = []
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        body = text[m.end():end]
        ann = ANN_RE.search(body)
        if ann:
            tm = TARGET_RE.search(ann.group(1) or '')
            target = (tm.group(1).lower() if tm else 'everyone')
            if target not in ('owner', 'everyone'):
                target = 'everyone'          # 认不出来的当群发（保守：宁可多发，别把该说的漏了）
            ann_text = ann.group(2).strip()
        else:
            target, ann_text = 'everyone', None
        # ⚠️ 别把变量叫 text —— 上面那个 text 是整份 CHANGELOG，
        #    覆盖它会让下一轮的 text[m.end():end] 拿公告正文去切片（实测报 NoneType）。
        out.append((m.group(1), m.group(2).strip(' -·'), ann_text, target))
    return out


def pick_entries(entries, last, force, current):
    """挑出要播的条目：默认 = 比 last 新的那些；--force = 只挑 current 这一版。"""
    if force:
        return [e for e in entries if e[0] == current]
    if last is None:
        return entries
    out = []
    for e in entries:
        if e[0] == last:
            break
        out.append(e)
    return out


def body_of(entries):
    """把这几版的 ANNOUNCE 段拼成正文（compose 与开场句判重都用它）。取不到就返回 ''。"""
    parts = [e[2] for e in entries if len(e) > 2 and e[2]]
    return '\n\n'.join(parts).strip()


def compose(entries, current, opening):
    head = '【本鱼 v%s】' % current
    body = body_of(entries)
    if not body:
        return None
    # 没开场句时不留空行（T-011：默认就是没有开场句，别再插一个空段落）。
    return '%s\n\n%s' % (head, body) if not (opening or '').strip() \
        else '%s\n\n%s\n\n%s' % (head, opening, body)


# ────────────────────────────────────────────── 开场句（可选，调模型）

# T-011（2026-10-06）：开场句不能复述正文。
#
# 病根不是"模型不听话"，是**喂错了东西**：原来把 ANNOUNCE 正文整段当"事实"递给它，
# 它的自然反应就是把刚读到的话再说一遍 —— 结果公告里同一件事说了两遍，
# 群里的观感就是"这公告发了两遍"（0.8.0 那次的日志原文两句几乎一字不差）。
#
# 改法两层：
#   ① **根本不给正文** —— 只给版本号 + 一句"主题"（取正文首句的前若干字），
#      信息量刚好够写引子，又不足以照抄；
#   ② 仍然加一道**重叠判据**兜底：开场里出现正文连续 12 个字符 ⇒ 判为复述，丢掉、用固定文案。
#      判据是硬的（可复核），不是"相信模型会守规矩"。
OVERLAP_N = 12

def _overlaps_body(opening, body):
    """开场句里有没有直接搬正文 —— 连续 OVERLAP_N 个字符相同即算复述。"""
    if not opening or not body:
        return False
    norm = lambda s: re.sub(r'\s+', '', s)
    o, b = norm(opening), norm(body)
    if len(o) < OVERLAP_N or len(b) < OVERLAP_N:
        return False
    grams = {b[i:i + OVERLAP_N] for i in range(len(b) - OVERLAP_N + 1)}
    return any(o[i:i + OVERLAP_N] in grams for i in range(len(o) - OVERLAP_N + 1))


def gen_opening(entries, current, body=''):
    """让"另一个它"按人格说一句开场。**只给主题、不给正文** —— 它只负责口气。"""
    # 主题 = 这几版正文的第一句，短截；给多了它就会复述（T-011 的教训）。
    topic = '；'.join([ann.strip().split('\n')[0] for _v, _d, ann in entries if ann])
    topic = topic[:80]
    try:
        with open(PERSONA, encoding='utf-8') as f:
            persona = f.read()[:PERSONA_CHARS]
    except Exception:
        persona = '你叫大肥鱼，自称「本鱼」，说话简短自然，别端着。'
    body_req = {
        'model': 'deepseek-chat',
        'messages': [
            {'role': 'system', 'content': persona
             + '\n\n—— 现在你要在**群里**发一条升级公告的开场句。'
               '要求：**一句话**、口语、像你平时说话；'
               '**只准依据下面给出的主题**，不许新增任何功能或承诺；不要写"大家好"这类客套。'
               '\n\n⛔ **重点**：开场句后面**紧跟着就是公告正文**，正文会把主题讲清楚。'
               '所以你这句只写"往哪个方向变了"的引子 —— '
               '**绝对不许复述主题里的内容、不许把主题换个说法再说一遍**，那会变成同一件事说两遍。'},
            {'role': 'user', 'content': '版本 v%s。这一版的主题只有几个字：%s\n\n'
                                        '写那一句引子（**不许把这几个字改写一遍**，那是错的做法）。'
                                        % (current, topic)},
        ],
        'max_tokens': 120,
    }
    req = urllib.request.Request(
        'https://api.deepseek.com/chat/completions',
        data=json.dumps(body_req).encode('utf-8'),
        headers={'Content-Type': 'application/json',
                 'Authorization': 'Bearer ' + key('sayask-qqbot.txt')})
    with urllib.request.urlopen(req, timeout=60) as r:
        d = json.load(r)
    line = (d['choices'][0]['message']['content'] or '').strip().strip('"').strip()
    line = line.split('\n')[0].strip()
    if not line:
        return None
    # ⚠️ 2026-10-06 实测踩到：原来写死 [:60]，结果 v0.6.3 那条开场被**切在半句话上**
    #    （"…@ 我的时候引用一下" 后面没了）。开场是要发到群里的，不能这样。
    #    现在放宽到 120，并且**优先在句末标点处收尾**；实在找不到标点才硬切。
    if len(line) > 120:
        cut = max(line.rfind(ch) for ch in '。！？…；')
        line = line[:cut + 1] if cut >= 40 else line[:120]
    # 硬判据兜底：真复述了就丢掉（下一行由调用方落 FALLBACK_OPENING）。
    if _overlaps_body(line, body) or _overlaps_body(line, topic):
        print('[announce] 开场句与正文重叠 ⇒ 丢弃，用固定文案')
        return None
    return line



FALLBACK_OPENING = '本鱼更新了一下自己，说一声 ——'


# ────────────────────────────────────────────── 发送

def get_token():
    req = urllib.request.Request(
        TOKEN_URL,
        data=json.dumps({'appId': key('qqbot-appid.txt'),
                         'clientSecret': key('qqbot-secret.txt')}).encode('utf-8'),
        headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)['access_token']


def post(path, token, payload):
    req = urllib.request.Request(
        API_BASE + path,
        data=json.dumps(payload).encode('utf-8'),
        headers={'Content-Type': 'application/json', 'Authorization': 'QQBot ' + token})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def send_group(token, group_openid, text):
    # 不带 msg_id = 主动消息（官方接口对主动消息有单独频控，公告这种量级远够）
    return post('/v2/groups/%s/messages' % group_openid, token,
                {'content': text, 'msg_type': 0, 'msg_seq': 1})


def send_c2c(token, openid, text):
    return post('/v2/users/%s/messages' % openid, token,
                {'content': text, 'msg_type': 0, 'msg_seq': 1})


# ────────────────────────────────────────────── 健康闸门

def wait_online(seconds):
    """等它真的在线（发送接口要求机器人在线）。超时返回 False —— 宁可这轮不发，也不盲发。"""
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            out = subprocess.run(['systemctl', 'is-active', 'qqbot'],
                                 capture_output=True, text=True, timeout=10).stdout.strip()
            if out == 'active':
                # 再看日志里最近有没有 Bot ready（服务刚起时给它几秒）
                try:
                    with open(os.path.join(HOME, 'qqbot.log'), encoding='utf-8', errors='replace') as f:
                        tail = f.read()[-4000:]
                    if 'Bot ready!' in tail:
                        return True
                except Exception:
                    return True
        except Exception:
            pass
        time.sleep(2)
    return False


# ────────────────────────────────────────────── 主流程

def main(argv):
    dry = '--dry-run' in argv
    force = '--force' in argv
    only_owner = '--only-owner' in argv
    only_groups = '--only-groups' in argv
    no_model = '--no-model' in argv       # 旧开关，保留兼容（现在默认就是不发开场句）
    want_opening = '--opening' in argv    # 想要开场句得显式要（见 T-011 的结论）

    try:
        with open(VERSION_FILE, encoding='utf-8') as f:
            current = f.read().strip()
    except Exception as e:
        print('[announce] 读不到 VERSION（%s）：%s' % (VERSION_FILE, e))
        return 2
    if not re.match(r'^\d+\.\d+\.\d+$', current):
        print('[announce] VERSION 内容不像版本号：%r' % current)
        return 2

    entries_all = parse_changelog()
    state = load_json(ANNOUNCED, {})
    last = state.get('lastAnnounced')

    entries = pick_entries(entries_all, last, force, current)
    entries = [e for e in entries if e[2]]      # 没有 ANNOUNCE 段的条目不参与播报
    # T-024：分成两组 —— 群当然要看的 / 只该超管看的
    def _own(e):
        return (e[3] if len(e) > 3 else 'everyone') == 'owner'
    entries_owner = [e for e in entries if _own(e)]
    entries_group = [e for e in entries if not _own(e)]
    if not entries:
        print('[announce] 没有要播的版本（当前 %s，上次播报 %s）' % (current, last or '（从没播过）'))
        return 0

    # ── 开场句：默认**不发**（T-011 定案，2026-10-06）──
    #
    # 结论不是"提示词没写好"，是**这个位置本身没有内容**：
    # 它既不许复述正文、又不许新增事实 ⇒ 剩下来只能是"今天绕了个圈"这种元评论，
    # 在群里看就是废话（实测：改完提示词+叠了重叠判据，它确实不复述了，但改说元评论）。
    # **治愈方式是拿走这个位置，而不是继续拧提示词。** 人格化留给写 CHANGELOG ANNOUNCE 的人 ——
    # 正文本身就是发给人看的人话。
    # 想要回开场句：加 `--opening`（会用 gen_opening，重叠判据仍然生效）。
    if want_opening and not no_model:
        try:
            # 先把正文拼出来，只为让开场句那道"重叠判据"有东西可比（T-011）。
            opening = gen_opening(entries, current, body=body_of(entries))
        except Exception as e:
            print('[announce] 开场句生成失败（本版不发开场句）: %s' % e)
            opening = ''
    else:
        opening = ''

    text_all = compose(entries, current, opening)          # 超管私聊：每条都发
    text_group = compose(entries_group, current, opening) if entries_group else None
    if not text_all and not text_group:
        print('[announce] 挑出来的条目里没有 ANNOUNCE 段 —— 不发（宁可不发，也不发空公告）')
        return 0

    owner = owner_openid()
    groups = load_json(GROUPS, {})
    gids = sorted(groups.keys()) if isinstance(groups, dict) else []

    print('[announce] 当前版本 %s ｜ 待播 %s ｜ 上次播报 %s'
          % (current, ','.join(e[0] for e in entries), last or '（从没播过）'))
    if entries_owner:
        print('[announce] 其中只发超管私聊的：%s'
              % ','.join(e[0] for e in entries_owner))
    if not entries_group:
        print('[announce] 这一版**没有对全群有用的内容** ⇒ 群一个都不发（T-024）')
    print('[announce] 目标：超管私聊 %s ＋ %d 个群%s'
          % (owner or '（找不到超管！）', len(gids) if entries_group else 0,
             '（--only-owner，跳过群）' if only_owner else ''))
    print('----- 发给超管私聊的内容 -----')
    print(text_all)
    if text_group and text_group != text_all:
        print('----- 发给群的内容（更短）-----')
        print(text_group)
    print('------------------------')

    if dry:
        print('[announce] --dry-run：一个字都没发。')
        return 0

    if not wait_online(WAIT_SECONDS):
        print('[announce] 等了 %d 秒它还没在线 —— 本轮不发（下次再试）' % WAIT_SECONDS)
        return 2

    try:
        token = get_token()
    except Exception as e:
        print('[announce] 取 access token 失败：%s' % e)
        return 2

    ok, failed = [], []
    targets = []
    if owner and not only_groups and text_all:
        targets.append(('c2c', owner, text_all))
    if not only_owner and entries_group and text_group:
        targets += [('group', g, text_group) for g in gids]
    for kind, tid, text in targets:
        try:
            if kind == 'c2c':
                send_c2c(token, tid, text)
            else:
                send_group(token, tid, text)
            ok.append('%s:%s' % (kind, tid[:8]))
            print('[announce] ✓ %s %s' % (kind, tid[:12]))
        except urllib.error.HTTPError as e:
            detail = ''
            try:
                detail = e.read().decode('utf-8', 'replace')[:200]
            except Exception:
                pass
            failed.append({'target': '%s:%s' % (kind, tid), 'error': 'HTTP %s %s' % (e.code, detail)})
            print('[announce] ✗ %s %s → HTTP %s %s' % (kind, tid[:12], e.code, detail))
        except Exception as e:
            failed.append({'target': '%s:%s' % (kind, tid), 'error': str(e)[:200]})
            print('[announce] ✗ %s %s → %s' % (kind, tid[:12], e))
        time.sleep(SEND_INTERVAL)

    state['lastAnnounced'] = current
    hist = state.get('history', [])
    # `announced` 里带 target 后缀（'0.21.0:owner'），方便事后看清哪一版群发过
    hist.insert(0, {'version': current, 'at': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                    'announced': ['%s%s' % (e[0], ':owner' if _own(e) else '') for e in entries],
                    'ok': ok, 'failed': failed})
    state['history'] = hist[:20]
    save_json(ANNOUNCED, state)

    print('[announce] 完成：成功 %d ｜ 失败 %d' % (len(ok), len(failed)))
    return 0 if not failed else 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
