#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
qqbot-alarm.py —— 闹钟：到点了让大肥鱼**主动**说一句。

设计（2026-10-05 饲主：「可以做定时器，就当闹钟功能了」）
════════════════════════════════════════════════════════
为什么不像话地简单：**不能**用 `dsh --profile qqbot` 唤起一轮对话 ——
那会再起一个 qqbot 实例、连同一个 AppID ⇒ 消息随机分发（当初就是为这个把本机版停掉的）。
所以这条路自己走：
  ① 用人格文件（前 4000 字）当 system prompt
  ② 调它**自己的** DeepSeek key 生成一句
  ③ 用 QQ 官方 API 主动发（不带 msgId = proactive，实测 HTTP 200 可用）

闹钟表：~/qqbot/data/alarms.json
  [
    { "time": "08:00", "prompt": "叫他起床，顺带问一句今天有没有早八", "enabled": true },
    { "time": "20:00", "prompt": "提醒群里今晚八点开黑", "repeat": "daily",
      "target": { "scope": "group", "peerId": "<group_openid>" } }
  ]
- `time` 是**服务器本地时间**（CST，与他在同一时区）
- 同一天同一时刻只发一次（`lastFired`）
- 用 systemd timer 每 5 分钟唤起一次，所以判定窗口是 10 分钟
- `target` 缺省 = 发超管私聊（老条目就是这个，完全向后兼容）；
  `{"scope":"group","peerId":"…"}` = 发到那个群（T-008 的"群提醒"，2026-10-07 加）
  ⚠️ **官方文档写着「群聊主动消息每月 4 条」** —— 但实测没触发（版本播报一天往 3 个群发过 17 次）。
     仍要当心：**有的群会回 `40034105 主动消息失败, 无权限`**（0.8.1 那次栽过）。
     所以失败**不写 lastFired**，下个 5 分钟会自己重试；重试仍失败就在日志里留痕。
- ⚠️ **超管 openid 不写死在本脚本里**（2026-10-07 改）—— 从 `data/relations.json` 里取 `role=admin`，
  与 `qqbot-announce.py` 用同一套姿势。这个脚本是要进**公开仓**的，写死等于把他的标识推到 GitHub。

手动跑：python3 ~/qqbot-alarm.py        （--force = 无视时间，只发第一条）
"""
import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta

HOME = os.path.expanduser('~')
DATA = os.path.join(HOME, 'qqbot', 'data')
ALARMS = os.path.join(DATA, 'alarms.json')
RELATIONS = os.path.join(DATA, 'relations.json')   # 超管 openid 从这儿取（role=admin）
KEYS = os.path.join(HOME, '.qqbot-keys')
PERSONA = os.path.join(HOME, 'qqbot', 'home', 'AGENTS.md')
API_BASE = 'https://api.sgroup.qq.com'
WINDOW_MIN = 10        # 到点后多久之内还算数（timer 每 5 分钟跑一次）

# ── 定期提醒（T-021，2026-10-06）
# repeat 字段：'once'（缺省，响完自动停用）/ 'daily' / [0..6]（周一=0，跟 JS 的 Date.getDay() 一致）
WEEK_NAME = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']


def repeat_of(a):
    """归一成 ('once', None) / ('daily', None) / ('weekly', [天...])"""
    r = a.get('repeat')
    if isinstance(r, str):
        r = r.strip().lower()
        if r in ('daily', '每天'):
            return 'daily', None
        if r in ('', 'once'):
            return 'once', None
    if isinstance(r, list):
        days = [int(x) for x in r if str(x).strip().lstrip('-').isdigit() and 0 <= int(x) <= 6]
        if days:
            return ('daily', None) if len(set(days)) == 7 else ('weekly', sorted(set(days)))
    return 'once', None


def due_today(a, now):
    """今天该不该响（不管时刻）—— 已按 repeat 判过星期"""
    kind, days = repeat_of(a)
    if kind == 'daily':
        return True
    if kind == 'weekly':
        return now.weekday() in days
    return True          # once：交给时刻窗口与 lastFired 判


def target_of(a):
    """归一 target：认不出来一律当私聊（保守 —— 宁可发给他，也别发错群）"""
    t = a.get('target')
    if isinstance(t, dict) and str(t.get('scope', '')).lower() == 'group' and t.get('peerId'):
        return {'scope': 'group', 'peerId': str(t['peerId'])}
    return None


def where_of(a):
    t = target_of(a)
    return ('群 ' + t['peerId'][:8]) if t else '私聊'


PERSONA_CHARS = 4000   # 取人格的前多少字（够表达风格，又不至于太长）


def load(path, default):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return default


def save(path, obj):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)


def owner_openid():
    """超管 openid 从关系表里取（role=admin）—— 不写死在脚本里（与 qqbot-announce.py 同一姿势）。"""
    rel = load(RELATIONS, {})
    for oid, rec in (rel.items() if isinstance(rel, dict) else []):
        if isinstance(rec, dict) and rec.get('role') == 'admin':
            return oid
    return None


def key(name):
    with open(os.path.join(KEYS, name), encoding='utf-8') as f:
        return f.read().strip()


def ds_say(prompt, to_group=False):
    """用人格 + 它的 key 生成一句话。to_group 时按"公开场合"的要求写。"""
    persona = ''
    try:
        with open(PERSONA, encoding='utf-8') as f:
            persona = f.read()[:PERSONA_CHARS]
    except Exception:
        persona = '你叫大肥鱼，自称「本鱼」，说话简短自然。'

    if to_group:
        scene = ('\n\n—— 现在你要在**群里**主动说一句话（不是回复谁）。群里是公开场合：'
                 '简短、自然、别写小作文、**别提任何人的私事、别点人名、别念分数**；直接说事。')
    else:
        scene = ('\n\n—— 现在你要**主动**给饲主发一条消息（不是回复他）。'
                 '要求：简短、自然、像你平时说话；直接说事，别问他问题，别写小作文。')

    body = {
        'model': 'deepseek-chat',
        'messages': [
            {'role': 'system', 'content': persona + scene},
            {'role': 'user', 'content': prompt},
        ],
        'max_tokens': 400,
    }
    req = urllib.request.Request(
        'https://api.deepseek.com/chat/completions',
        data=json.dumps(body).encode('utf-8'),
        headers={'Content-Type': 'application/json',
                 'Authorization': 'Bearer ' + key('sayask-qqbot.txt')})
    with urllib.request.urlopen(req, timeout=90) as r:
        d = json.load(r)
    return (d['choices'][0]['message']['content'] or '').strip()


def qq_send(text, target=None):
    """主动推送（不带 msgId = proactive）。

    target 是 {'scope':'group','peerId':...} ⇒ 发到那个群（`/v2/groups/{id}/messages`），
    否则发超管私聊（`/v2/users/{id}/messages`）—— 与 ~/qqbot-announce.py 用的是同一条通路。
    """
    req = urllib.request.Request(
        'https://bots.qq.com/app/getAppAccessToken',
        data=json.dumps({'appId': key('qqbot-appid.txt'),
                         'clientSecret': key('qqbot-secret.txt')}).encode('utf-8'),
        headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as r:
        token = json.load(r)['access_token']

    t = target if isinstance(target, dict) and target.get('scope') == 'group' else None
    if t:
        path = '/v2/groups/' + t['peerId'] + '/messages'
    else:
        oid = owner_openid()
        if not oid:
            raise RuntimeError('关系表里找不到 role=admin 的超管，没法发私聊')
        path = '/v2/users/' + oid + '/messages'

    req2 = urllib.request.Request(
        API_BASE + path,
        data=json.dumps({'content': text, 'msg_type': 0, 'msg_seq': 1}).encode('utf-8'),
        headers={'Content-Type': 'application/json',
                 'Authorization': 'QQBot ' + token})
    with urllib.request.urlopen(req2, timeout=30) as r:
        return json.load(r)


def main(argv):
    now = datetime.now()
    force = '--force' in argv          # 测试用：无视时间，直接发第一条
    alarms = load(ALARMS, [])
    if not isinstance(alarms, list) or not alarms:
        print('[alarm] 没有闹钟（%s）' % ALARMS)
        return 0

    fired = 0
    print('[alarm] 检查 %d 条闹钟（现在 %s）' % (len(alarms), now.strftime('%Y-%m-%d %H:%M')))
    for a in alarms:
        if force and fired:
            break                      # --force 只发第一条（测试用，别把全部条目都轰一遍）
        if not isinstance(a, dict) or not a.get('enabled', True):
            continue
        if not force and not due_today(a, now):
            kind, days = repeat_of(a)
            print('[alarm] 今天不响（%s，今天是%s）: %s'
                  % ('每周' + '、'.join(WEEK_NAME[d] for d in days or []), WEEK_NAME[now.weekday()], a.get('time')))
            continue
        if not force:
            if str(a.get('lastFired', ''))[:10] == now.strftime('%Y-%m-%d'):
                continue
            try:
                h, m = [int(x) for x in str(a.get('time', '')).split(':')]
            except Exception:
                print('[alarm] 时间格式不对，跳过: %r' % a.get('time'))
                continue
            target_dt = now.replace(hour=h, minute=m, second=0, microsecond=0)
            if not (target_dt <= now < target_dt + timedelta(minutes=WINDOW_MIN)):
                continue

        prompt = a.get('prompt') or ('提醒饲主：' + str(a.get('text', '')))
        tgt = target_of(a)
        try:
            text = ds_say(prompt, to_group=bool(tgt))
        except Exception as e:
            print('[alarm] 生成失败: %s' % e)
            continue
        try:
            qq_send(text, tgt)
            a['lastFired'] = now.strftime('%Y-%m-%d %H:%M')
            kind, days = repeat_of(a)
            note = '每天' if kind == 'daily' else ('每周' + '、'.join(WEEK_NAME[d] for d in days or [])
                                                 if kind == 'weekly' else '只一次')
            if kind == 'once':
                # 一次性的响完就停用 —— 免得它天天"到点但被 lastFired 挡住"地空转
                a['enabled'] = False
                note += '（已自动停用）'
            fired += 1
            print('[alarm] 已发（%s · %s · →%s）: %s' % (a.get('time', '?'), note, where_of(a), text[:70]))
        except Exception as e:
            print('[alarm] 发送失败（→%s）: %s' % (where_of(a), e))

    if fired:
        save(ALARMS, alarms)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
