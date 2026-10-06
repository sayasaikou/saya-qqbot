#!/bin/bash
# qqbot-update.sh -- 从 GitHub 拉最新的人格/工作区/工具/插件，装到位并重启。
#
# ⚠️ 有意不覆盖 cordis.patch.yml：仓库里那份是【本机版】（Windows 路径），
#    云端这份是 Linux 路径。覆盖了机器人就起不来。配置要手动同步。
#
# 2026-10-06 改（版本号 + 升级播报上线）：
#   ① 装**第三方包补丁**（patches/dsh-qqbot/apply-patch.mjs，幂等，装包丢了就补回来）
#   ② 装**宿主脚本**（host/*.py → ~/，比如 qqbot-announce.py）
#   ③ **VERSION 挪到最后才装** —— 装早了会出现「公告发了、东西没上」；
#      装完 VERSION 立刻调播报，播报自己也有幂等（data/announced.json）
set -e
SRC=$HOME/qqbot-src
DST=$HOME/qqbot
PROFILE=$HOME/.dsh/profiles/qqbot

cd "$SRC"
git pull --ff-only

echo "--- 人格 ---"
install -m 644 "$SRC/persona/AGENTS.md" "$DST/home/AGENTS.md"

echo "--- 工作区文档 ---"
for f in MEMES.md MEMORY.md vision-workflow.md; do
  if [ -f "$SRC/work/$f" ]; then
    install -m 644 "$SRC/work/$f" "$DST/work/$f"
  fi
done

echo "--- 工具 ---"
for f in "$SRC"/tools/*.py; do
  if [ -f "$f" ]; then
    install -m 755 "$f" "$DST/tools/"
  fi
done

echo "--- 自研插件 ---"
# ⚠️ 仓库里插件是【直接放在 plugin/ 下】，不是 plugin/qqbot-memory/ 子目录。
#    早先按子目录写，`if [ -d ]` 恒为假 ⇒ 插件安装被【静默跳过】，
#    云端插件从部署起就没更新过。判据改成看 plugin/index.js 在不在。
if [ -f "$SRC/plugin/index.js" ]; then
  rm -rf "$PROFILE/node_modules/qqbot-memory"
  mkdir -p "$PROFILE/node_modules/qqbot-memory"
  cp "$SRC"/plugin/*.js "$SRC"/plugin/*.mjs "$SRC"/plugin/*.json "$PROFILE/node_modules/qqbot-memory/" 2>/dev/null || true
  echo "  installed: $(ls "$PROFILE/node_modules/qqbot-memory" | tr '\n' ' ')"
else
  echo "  [X] plugin/index.js 不在，跳过（检查仓库结构）"
fi

echo "--- 第三方包补丁（装包/升级包就会丢，所以每次更新都重打一遍）---"
# 改的是 @tencent-connect/dsh-qqbot 的 dist/ 编译产物：私聊 senderTag + 入站落盘说话人/群登记。
# 脚本是幂等的，已在位就只打勾。退出码 2 = 有问题（缺文件或包结构变了），要人工看。
if [ -f "$SRC/patches/dsh-qqbot/apply-patch.mjs" ]; then
  node "$SRC/patches/dsh-qqbot/apply-patch.mjs" || echo "  [X] 补丁体检没过 —— 见上面的明细"
else
  echo "  [X] patches/dsh-qqbot/apply-patch.mjs 不在"
fi

echo "--- 宿主脚本 ---"
for f in "$SRC"/host/*.py; do
  if [ -f "$f" ]; then
    install -m 755 "$f" "$HOME/$(basename "$f")"
    echo "  installed: $(basename "$f")"
  fi
done

echo "--- 重启 ---"
sudo systemctl restart qqbot
sleep 6
systemctl is-active qqbot
tail -n 2 "$HOME/qqbot.log"

echo "--- 版本号（**最后一步**：装早了会出现「公告发了、东西没上」）---"
install -m 644 "$SRC/VERSION" "$DST/VERSION"
install -m 644 "$SRC/CHANGELOG.md" "$DST/CHANGELOG.md"
echo "  VERSION=$(cat "$DST/VERSION")"

echo "--- 升级播报 ---"
# 播报自己会等它在线的（超时就不发，下一轮再试），并且按 data/announced.json 幂等。
# 这里不用 set -e 兜：播报失败不该让整次更新算失败 —— 已经装完的东西是好的。
python3 "$HOME/qqbot-announce.py" || echo "  [X] 播报有失败（明细见 $DST/data/announced.json）"
