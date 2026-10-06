#!/usr/bin/env bash
# qqbot-post-upgrade.sh -- run this AFTER anything replaces the QQ bot's node_modules.
#
# WHAT IT DOES (in order, stopping the report at the first broken link):
#   1. re-apply the two third-party patches (idempotent: apply-patch.mjs)
#   2. syntax-check the patched files
#   3. restart the service and wait for it to come back
#   4. verify the plugin actually loaded and its tools registered
#   5. verify no new "speaker id missing" lines appeared (that was the T-013 symptom)
#   6. verify the read-only notes mirror still exists and is still read-only
#   7. verify the health timer is still armed
# Then it prints one VERDICT block and (on failure) pings the owner on QQ.
#
# WHY IT EXISTS: both patches live in the COMPILED output of a third-party package.
# `npm/pnpm` replaces that directory wholesale, so an upgrade silently drops them --
# and the failure mode is silent too (private-chat admin check just stops working).
#
# Usage:
#   bash ~/qqbot-post-upgrade.sh              # fix + verify
#   bash ~/qqbot-post-upgrade.sh --check      # verify only, change nothing
#   bash ~/qqbot-post-upgrade.sh --no-restart # do not touch the service (code checks only)
#
# Exit: 0 = all green | 2 = something failed (details printed)

set -u
PATCH_DIR="$HOME/qqbot-src/patches/dsh-qqbot"
PROFILE="$HOME/.dsh/profiles/qqbot"
PLUGIN="$PROFILE/node_modules/qqbot-memory"
LOGF="$HOME/qqbot/data/qqbot-memory.log"
NOTES="$HOME/notes"
HOSTLOG="$HOME/qqbot-post-upgrade.log"

CHECK_ONLY=0
DO_RESTART=1
for a in "$@"; do
  case "$a" in
    --check) CHECK_ONLY=1 ;;
    --no-restart) DO_RESTART=0 ;;
  esac
done

# ⚠️ 计数必须走**文件**：验证块被 `{ ... } | tee` 包着，右侧是**子 shell**，
#    在它里面 ++ 变量传不回外层（2026-10-06 实测：打了 [FAIL] 却报 failures=0）。
FAILED=0
FAILCOUNT_FILE=$(mktemp /tmp/_qqpgcount.XXXXXX)
echo 0 > "$FAILCOUNT_FILE"
say()  { echo "$@" | tee -a "$HOSTLOG"; }
ok()   { say "  [ok]   $1"; }
bad()  { say "  [FAIL] $1"; FAILED=1; echo $(( $(cat "$FAILCOUNT_FILE") + 1 )) > "$FAILCOUNT_FILE"; }

{
  say ""
  say "=== qqbot post-upgrade $(date '+%Y-%m-%d %H:%M:%S') (check_only=$CHECK_ONLY) ==="

  # 1) third-party patches
  if [ ! -f "$PATCH_DIR/apply-patch.mjs" ]; then
    bad "patch script missing: $PATCH_DIR/apply-patch.mjs"
  else
    if [ "$CHECK_ONLY" = "1" ]; then
      out=$(cd "$PATCH_DIR" && node apply-patch.mjs --check --profile-dir "$PROFILE" 2>&1)
    else
      out=$(cd "$PATCH_DIR" && node apply-patch.mjs --profile-dir "$PROFILE" 2>&1)
    fi
    if echo "$out" | grep -q "VERDICT: OK"; then
      ok "third-party patches: $(echo "$out" | grep -c '✓') checks passed"
    else
      bad "third-party patches NOT ok:"
      echo "$out" | sed 's/^/        /' | tee -a "$HOSTLOG"
    fi
  fi

  # 2) syntax of the patched files
  for f in "$PROFILE/node_modules/@tencent-connect/dsh-qqbot/dist/transport/inbound.js" \
           "$PLUGIN/index.js"; do
    if [ -f "$f" ]; then
      if node --check "$f" >/dev/null 2>&1; then ok "syntax ok: $(basename "$(dirname "$f")")/$(basename "$f")"
      else bad "syntax FAILED: $f"; fi
    else
      bad "missing file: $f"
    fi
  done

  # 3) restart + wait
  if [ "$DO_RESTART" = "1" ] && [ "$CHECK_ONLY" = "0" ]; then
    sudo systemctl restart qqbot
    for i in $(seq 1 15); do
      [ "$(systemctl is-active qqbot)" = "active" ] && break
      sleep 2
    done
    if [ "$(systemctl is-active qqbot)" = "active" ]; then ok "service active after restart"
    else bad "service NOT active after restart"; fi
  else
    say "  [skip] restart (check_only or --no-restart)"
  fi

  # 4) plugin loaded + tools registered (proof it is really running, not just 'active')
  if [ -f "$LOGF" ]; then
    since=$(date -d '5 minutes ago' '+%Y-%m-%dT%H:%M' 2>/dev/null || date '+%Y-%m-%dT%H:%M')
    tail -400 "$LOGF" > /tmp/_qqlog.txt
    for tool in qqbot_where qqbot_notes qqbot_scene qqbot_history qqbot_draw qqbot_cost; do
      if grep -q "$tool .*注册成功\|$tool 工具已注册\|$tool 注册成功" /tmp/_qqlog.txt; then
        ok "tool registered: $tool"
      else
        bad "tool NOT registered: $tool"
      fi
    done
    if grep -q "会话文件巡检" /tmp/_qqlog.txt; then ok "session guard ran"; else bad "session guard did not run"; fi
  else
    bad "plugin log missing: $LOGF"
  fi

  # 5) the T-013 symptom counter must not grow
  if [ -f "$LOGF" ]; then
    n=$(grep -c "关系卡跳过" "$LOGF" 2>/dev/null || echo 0)
    say "  [info] 关系卡跳过 count = $n (should stay flat; grow = T-013 regression)"
  fi

  # 5b) plugin self-tests (they catch things `node --check` cannot)
  for t in selftest.mjs selftest-speaker.mjs selftest-history.mjs selftest-rules-e2e.mjs selftest-usage.mjs selftest-audit.mjs; do
    if [ -f "$PLUGIN/$t" ]; then
      line=$(cd "$PLUGIN" && node "$t" 2>&1 | tail -1)
      if echo "$line" | grep -q "0 失败"; then ok "selftest $t: $(echo "$line" | sed 's/===//g' | tr -s ' ')"
      else bad "selftest $t FAILED: $line"; fi
    fi
  done

  # 6) read-only notes mirror
  if [ -d "$NOTES" ]; then
    cnt=$(find "$NOTES" -type f | wc -l)
    if [ "$cnt" -gt 0 ]; then ok "notes mirror: $cnt files"; else bad "notes mirror is empty"; fi
    if touch "$NOTES/._probe" 2>/dev/null; then
      bad "notes dir is WRITABLE (should be read-only)"; rm -f "$NOTES/._probe"
    else
      ok "notes dir is read-only"
    fi
  else
    bad "notes mirror missing: $NOTES"
  fi

  # 7) health timer still armed
  if systemctl is-enabled qqbot-health.timer >/dev/null 2>&1; then ok "health timer enabled"
  else bad "health timer NOT enabled"; fi
} 2>&1 | tee -a "$HOSTLOG"

# ⚠️ 判定必须读**文件**：$FAILED 是在 `{ ... } | tee` 的子 shell 里被改的，外层读不到
#    （2026-10-06 实测：打了 [FAIL] 却仍然报 OK —— 典型的假绿）。
FAILS_NOW=$(cat "$FAILCOUNT_FILE" 2>/dev/null || echo 0)
if [ "$FAILS_NOW" = "0" ]; then
  say "VERDICT: OK -- upgrade verified (failures=0)"
  rm -f "$FAILCOUNT_FILE"
  exit 0
fi

say "VERDICT: FAIL (failures=$(cat "$FAILCOUNT_FILE" 2>/dev/null || echo ?)) -- see the [FAIL] lines above"
rm -f "$FAILCOUNT_FILE"

# On failure, ping the owner (same channel the daily health check uses).
if [ "$CHECK_ONLY" = "0" ]; then
  tail -40 "$HOSTLOG" > /tmp/_qqpost.txt
  sudo -u ubuntu python3 - <<'PY' 2>/dev/null || true
import json, os, re, subprocess, urllib.request
HOME = os.path.expanduser('~')
KEYS = os.path.join(HOME, '.qqbot-keys')
DATA = os.path.join(HOME, 'qqbot', 'data')
def key(n):
    return open(os.path.join(KEYS, n), encoding='utf-8').read().strip()
cfg = os.path.join(HOME, '.dsh', 'profiles', 'qqbot', 'cordis.patch.yml')
oid = ''
try:
    m = re.search(r'adminOpenIds:\s*\n\s*-\s*([0-9A-Fa-f]{32})', open(cfg, encoding='utf-8').read())
    if m: oid = m.group(1).upper()
except Exception: pass
if not oid: raise SystemExit(0)
fails = [l.strip() for l in open('/tmp/_qqpost.txt', encoding='utf-8', errors='ignore') if '[FAIL]' in l]
text = '【升级后自检没过】\n' + '\n'.join(fails[:8]) + '\n\n（这是升级后自动跑的检查，不是有人在跟你说话。）'
body = json.dumps({'appId': key('qqbot-appid.txt'), 'clientSecret': key('qqbot-secret.txt')}).encode()
req = urllib.request.Request('https://bots.qq.com/app/getAppAccessToken', data=body,
                            headers={'Content-Type': 'application/json'})
token = json.load(urllib.request.urlopen(req, timeout=30))['access_token']
payload = json.dumps({'content': text, 'msg_type': 0}).encode()
req2 = urllib.request.Request(f'https://api.sgroup.qq.com/v2/users/{oid}/messages', data=payload,
    headers={'Content-Type': 'application/json', 'Authorization': f'QQBot {token}',
             'X-Union-Appid': key('qqbot-appid.txt')})
print('alert sent', urllib.request.urlopen(req2, timeout=30).status)
PY
  rm -f /tmp/_qqpost.txt
fi

exit 2
