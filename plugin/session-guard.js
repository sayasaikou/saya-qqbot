/**
 * session-guard —— 启动时扫一遍会话持久化文件，把**明确坏掉的**隔离掉。
 *
 * ════════════════════════════════════════════════════════════════
 * 为什么要它（2026-10-06 超管私聊实测踩到）
 * ════════════════════════════════════════════════════════════════
 *
 * 那次的现象：**私聊整条路挂了**，机器人只回一句「处理消息时出现异常」。
 * 根因是私聊会话的持久化文件坏了 —— 68 字节，内容是
 * 「00000000: 28b5 2ffd 0458 5d04 …」这样一段 xxd 文本（显然某次被就地覆盖写坏）。
 * 适配器的 getOrCreate() 于是：resume 解不开 ⇒ 失败；create 又因文件已存在 ⇒ 失败
 * ⇒ **整条会话创建链断掉，而且不自愈**：每次来消息都撞同一面墙。
 *
 * ⚠️⚠️ 判据必须**极保守**（2026-10-06 首版把 4 个**好**会话全隔离了，当场回滚）：
 *
 *   首版的错：拿 `zlib.inflateSync()` 解不开就当坏。**这是错的** ——
 *   dsh 的会话日志是**追加式多帧 zstd**，整段喂给 inflateSync 必然失败，
 *   于是一屋子好文件全被判坏。教训：**"我解不开" ≠ "它坏了"。**
 *
 *   现版只认两种**铁证**：
 *     ① 大小为 0（没有内容可丢，且必然 resume 失败）；
 *     ② **头 4 字节不是 zstd 魔数**（28 b5 2f fd）——
 *        这正是那次事故的特征（文件头是 ASCII 的 "0000"）。
 *   另加一条**反向豁免**：扫一遍帧头，若发现 ≥2 个对齐的 zstd 魔数，
 *   说明它是"多帧追加"的正常文件 ⇒ **一律放过**（哪怕 inflate 解不开）。
 *
 * ⚠️ 本文件**注释里不许出现反引号**（2026-10-06 实测：注释里的反引号会与
 *    /api/** 那种写法配错对，把注释提前闭合，报出莫名其妙的语法错 —— 当天栽过一次）。
 */

import { existsSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** zstd 帧魔数 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const SESSION_FILE = 'session.v4.jsonl.zstd';

/** 一次扫描最多隔离几个（防某个目录被批量写坏时把启动拖死） */
const MAX_QUARANTINE = 20;

/** 扫帧头的上限（不用读整个大文件；只要能证明"多帧"就够） */
const SCAN_BYTES = 8 * 1024 * 1024;

function startsWithZstd(buf) {
  return buf.length >= 4 && buf.subarray(0, 4).equals(ZSTD_MAGIC);
}

/**
 * 是不是"正常的多帧追加文件"。
 *
 * 判据极宽：只要在开头一段里找到 **第二个** 对齐的 zstd 魔数就放过。
 * （追加式写入的会话日志帧与帧首尾相接，魔数会在偏移处原样出现。）
 */
function looksLikeMultiFrameZstd(buf) {
  if (!startsWithZstd(buf)) return false;
  const limit = Math.min(buf.length - 4, SCAN_BYTES);
  for (let i = 4; i <= limit; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) {
      return true;
    }
  }
  return false;
}

/**
 * 扫描并隔离明确坏掉的会话文件。
 * @returns {{scanned:number, quarantined:string[], suspected:number}}
 */
export function guardSessionFiles(sessionsRoot, logger) {
  const out = { scanned: 0, quarantined: [], suspected: 0 };
  try {
    if (!sessionsRoot || !existsSync(sessionsRoot)) return out;
    const stampStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    for (const ws of readdirSync(sessionsRoot)) {
      const wsDir = join(sessionsRoot, ws);
      let sessions = [];
      try { sessions = readdirSync(wsDir); } catch { continue; }
      for (const sid of sessions) {
        const file = join(wsDir, sid, SESSION_FILE);
        let size = 0;
        try {
          if (!existsSync(file)) continue;
          size = statSync(file).size;
        } catch { continue; }
        out.scanned++;

        let bad = false;
        let why = '';

        if (size === 0) {
          bad = true;
          why = '文件为空';
        } else {
          let head;
          try {
            head = readFileSync(file).subarray(0, Math.min(size, SCAN_BYTES));
          } catch {
            continue;   // 读不到 = 权限之类，**放过**（不能误伤）
          }
          if (!startsWithZstd(head)) {
            bad = true;
            why = '头 4 字节不是 zstd 魔数（' + head.subarray(0, 4).toString('hex') + '）';
          } else if (looksLikeMultiFrameZstd(head)) {
            bad = false;              // 多帧追加的正常文件 ⇒ 放过
          } else {
            // 单帧、魔数对：**无法用 inflate 判好坏**（多帧会解不开）⇒ 只记一笔，不动它
            out.suspected++;
            logger?.warn?.('会话文件看着像单帧 zstd，未动（仅供排查）：' + ws + '/' + sid);
          }
        }

        if (bad) {
          const target = file + '.CORRUPT-' + stampStr;
          try {
            renameSync(file, target);
            out.quarantined.push(ws + '/' + sid);
            logger?.warn?.('会话文件损坏，已隔离（' + why + '）：' + ws + '/' + sid + ' → ' + target);
          } catch (err) {
            logger?.warn?.('隔离失败（' + why + '）：' + ws + '/' + sid + ' —— ' + (err?.message ?? err));
          }
          if (out.quarantined.length >= MAX_QUARANTINE) return out;
        }
      }
    }
  } catch (err) {
    logger?.warn?.('会话文件巡检失败（不影响启动）：' + (err?.message ?? err));
  }
  return out;
}
