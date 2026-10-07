#!/bin/bash
# qqbot-data-sync.sh -- 云端与私有仓 saya-qqbot-data 之间的双向同步。
#
#  上行（云端 → 仓）：聊天记录 / 用量 / 共享记忆  ← 云端是这些的生产者
#  下行（仓 → 云端）：表情包                      ← 本机是表情包的生产者
#
# 为什么表情包走这里而不是项目仓：其中一部分是社区图，有版权顾虑，
# 放私有仓更合适。项目仓（公开）只放人格与代码。
#
# 私有用 deploy key（只对这一个仓库有效），权限最小化。
set -e
REPO=$HOME/qqbot-data
SRC=$HOME/qqbot
LOG=$HOME/qqbot-data-sync.log
TS=$(date '+%F %T')

log() { echo "$TS $*" >> "$LOG"; }

# 日志自身别无限涨
if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG")" -gt 100000 ]; then
  tail -n 200 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

# 首次 clone（私有仓，走 ~/.ssh/config 里配的 443 通道）
if [ ! -d "$REPO/.git" ]; then
  if ! git clone -q git@github.com:sayasaikou/saya-qqbot-data.git "$REPO" 2>>"$LOG"; then
    log "ERROR clone failed (deploy key 加了吗?)"
    exit 1
  fi
  log "cloned"
fi

cd "$REPO"
git pull -q --ff-only 2>>"$LOG" || log "WARN pull failed, continuing"

# ── 下行：表情包（本机推上来的新增图）──
if [ -d "$REPO/memes" ]; then
  before=$(find "$SRC/work/memes" -type f 2>/dev/null | wc -l)
  mkdir -p "$SRC/work/memes"
  cp -r "$REPO/memes/." "$SRC/work/memes/" 2>/dev/null || true
  after=$(find "$SRC/work/memes" -type f 2>/dev/null | wc -l)
  [ "$before" != "$after" ] && log "memes pulled: $before -> $after"
fi

# ── 上行：聊天记录 / 用量 / 记忆 ──
mkdir -p history usage MEMORY
[ -d "$SRC/data/history" ] && cp -r "$SRC/data/history/." history/ 2>/dev/null || true
[ -d "$SRC/data/usage" ]   && cp -r "$SRC/data/usage/."   usage/   2>/dev/null || true
[ -d "$SRC/work/MEMORY" ]  && cp -r "$SRC/work/MEMORY/."  MEMORY/  2>/dev/null || true

git add -A
if git diff --cached --quiet; then
  log "no changes"
else
  N=$(git diff --cached --name-only | wc -l)
  git -c user.name="qqbot-server" -c user.email="qqbot@localhost" \
      commit -q -m "sync: $TS ($N files)"
  if git push -q 2>>"$LOG"; then
    log "pushed $N files"
  else
    log "ERROR push failed"
    exit 1
  fi
fi
