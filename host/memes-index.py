#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""memes-index.py —— 给云端 269 张表情包建「画面内容索引」（一次性，之后长期受益）。

为什么要它：现在表情包库是**按情绪分类**的（angry/happy/daily…），
想找"一张生气但可爱的"容易，想找"**一张在吃饭的**"就只能瞎猜。
建完索引之后就能按**画面内容**搜 —— 这是"表情包体系"真正立起来的那一步。

产物（都在 ~/qqbot/work/）：
  memes-index.json   机器用：{ "rel/path": {"cat":…, "desc":…, "text":…, "at":…} }
  MEMES-INDEX.md     人用：按分类分组、每张一行
  memes-index.log    进度日志（可 nohup 后台跑，断了重跑会**跳过已完成**的）

跑法：python3 ~/memes-index.py            # 可重复跑，自动续
"""
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

HOME = os.path.expanduser('~')
WORK = os.path.join(HOME, 'qqbot', 'work')
MEMES = os.path.join(WORK, 'memes')
OUT_JSON = os.path.join(WORK, 'memes-index.json')
OUT_MD = os.path.join(WORK, 'MEMES-INDEX.md')
LOG = os.path.join(WORK, 'memes-index.log')

KEY = open(os.path.join(HOME, '.qqbot-keys', 'dashscope.txt')).read().strip()
API = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
MODEL = 'qwen3-vl-plus'
EXTS = ('.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp')
SLEEP = 0.6          # 礼貌一点，别把免费额度打成 429

PROMPT = (
    '这是一张聊天用的表情包。请**只回一行**，格式严格如下：\n'
    '主体|在做什么或什么表情|情绪|有没有文字\n'
    '要求：每段不超过 12 个字；没有文字就写「无」；有文字就**原样抄下来**（不要翻译）。\n'
    '例：猫|双手抱胸扭头|傲娇|无\n'
    '例：鲸鱼|举着饭碗流泪|委屈|「饿饿」\n'
    '不要任何解释、不要 Markdown、不要引号。'
)


def log(msg):
    line = time.strftime('[%H:%M:%S] ') + msg
    print(line, flush=True)
    try:
        with open(LOG, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except Exception:
        pass


def load():
    try:
        with open(OUT_JSON, encoding='utf-8') as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def save(d):
    tmp = OUT_JSON + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(d, f, ensure_ascii=False, indent=1, sort_keys=True)
    os.replace(tmp, OUT_JSON)


def describe(path):
    with open(path, 'rb') as f:
        raw = f.read()
    mime = 'image/png' if raw[:4] == b'\x89PNG' else ('image/gif' if raw[:3] == b'GIF' else 'image/jpeg')
    b64 = base64.b64encode(raw).decode()
    body = {
        'model': MODEL,
        'messages': [{'role': 'user', 'content': [
            {'type': 'image_url', 'image_url': {'url': 'data:%s;base64,%s' % (mime, b64)}},
            {'type': 'text', 'text': PROMPT},
        ]}],
        'max_tokens': 120,
    }
    req = urllib.request.Request(
        API, data=json.dumps(body).encode(),
        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY})
    with urllib.request.urlopen(req, timeout=90) as r:
        d = json.load(r)
    txt = (d['choices'][0]['message']['content'] or '').strip()
    txt = re.sub(r'^```.*?\n|```$', '', txt).strip().strip('"').strip()
    return txt.split('\n')[0][:120]


def main():
    if not os.path.isdir(MEMES):
        log('找不到表情包目录：%s' % MEMES)
        return 2
    files = []
    for root, _dirs, names in os.walk(MEMES):
        for n in sorted(names):
            if n.lower().endswith(EXTS):
                files.append(os.path.join(root, n))
    files.sort()
    done = load()
    todo = [f for f in files if os.path.relpath(f, WORK) not in done]
    log('共 %d 张，已完成 %d，本轮待处理 %d' % (len(files), len(done), len(todo)))

    ok = err = 0
    for i, path in enumerate(todo, 1):
        rel = os.path.relpath(path, WORK)
        cat = os.path.basename(os.path.dirname(path))
        for attempt in (1, 2, 3):
            try:
                desc = describe(path)
                if not desc:
                    raise ValueError('空回答')
                done[rel] = {'cat': cat, 'desc': desc, 'at': time.strftime('%Y-%m-%d %H:%M')}
                ok += 1
                if i % 10 == 0 or i == len(todo):
                    save(done)
                    log('进度 %d/%d（本轮 成功 %d 失败 %d）' % (i, len(todo), ok, err))
                break
            except urllib.error.HTTPError as e:
                if e.code == 429 and attempt < 3:
                    time.sleep(5 * attempt)
                    continue
                err += 1
                log('  ✗ %s → HTTP %s' % (rel, e.code))
                break
            except Exception as e:
                if attempt < 3:
                    time.sleep(3 * attempt)
                    continue
                err += 1
                log('  ✗ %s → %s' % (rel, str(e)[:120]))
                break
        time.sleep(SLEEP)

    save(done)

    # 人读版
    lines = ['# 表情包画面索引（机器生成，别手改）', '',
             '> 由 `~/memes-index.py` 用视觉模型批量读出。**用途：按画面内容搜图**（不是只有情绪分类）。',
             '> 格式：`主体|在做什么/表情|情绪|文字`', '',
             '共 %d 张。' % len(done), '']
    bycat = {}
    for rel, v in sorted(done.items()):
        bycat.setdefault(v.get('cat', '?'), []).append((rel, v.get('desc', '')))
    for cat in sorted(bycat):
        lines.append('## %s（%d 张）' % (cat, len(bycat[cat])))
        lines.append('')
        for rel, desc in bycat[cat]:
            lines.append('- `%s` — %s' % (rel, desc))
        lines.append('')
    with open(OUT_MD, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))
    log('完成：成功 %d 失败 %d；索引 %d 条 → %s' % (ok, err, len(done), OUT_MD))
    return 0


if __name__ == '__main__':
    sys.exit(main())
