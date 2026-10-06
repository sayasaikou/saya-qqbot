#!/usr/bin/env node
/**
 * apply-patch.mjs —— 重打 `@tencent-connect/dsh-qqbot` 上的两个补丁（**幂等**）
 *
 * ════════════════════════════════════════════════════════════════
 * 为什么要这个脚本
 * ════════════════════════════════════════════════════════════════
 *
 * 这两个补丁改的是**第三方包的编译产物**（`dist/`，不是 TS 源码）——
 * 只要 `@tencent-connect/dsh-qqbot` 被重装或升级，补丁就没了，而且**不会报错**：
 *
 *   ① **私聊也带 senderTag**（2026-10-05）
 *      症状：私聊里超管判定整个失效（工具回「这个指令只有超管能下」）。
 *      根因：`buildUserMessage()` 只给群聊拼 `[昵称 (openid)]` 前缀，私聊直接返回内容，
 *            而关系层正是靠这个前缀认人。
 *   ② **入站时把"本轮说话人 / 所在群"落盘**（2026-10-06 · T-005）
 *      症状：关系卡稳定慢一轮 ⇒ 认错人、改错分。
 *      根因：dsh 的一个 turn 是「先组装 system prompt、后 append 用户消息」
 *            （dsh-agent-loop/lib/index.js：preStep 907 assemble / step 1046 append），
 *            插件挂在 assemble 上的钩子永远读不到本轮说话人。
 *      做法：`features/peer-registry.js` + 在 `handleInbound` 的 `followup` 之前调一次。
 *
 * ════════════════════════════════════════════════════════════════
 * 跑法
 * ════════════════════════════════════════════════════════════════
 *
 *   node apply-patch.mjs                 # 自动找 profile（$DSH_HOME → 常见路径）
 *   node apply-patch.mjs --profile-dir /home/ubuntu/.dsh/profiles/qqbot
 *   node apply-patch.mjs --check         # 只体检、不改任何文件
 *
 * 退出码：0 = 补丁齐全（或已成功补齐）｜2 = 有问题（缺文件 / 结构对不上）
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const HERE = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const pdIdx = args.indexOf('--profile-dir');
const profileDirArg = pdIdx >= 0 ? args[pdIdx + 1] : null;

const problems = [];
const notes = [];

function findProfileDir() {
  if (profileDirArg) return profileDirArg;
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const cand = [
    join(home, 'profiles', 'qqbot'),
    join(homedir(), '.dsh', 'profiles', 'qqbot'),
    'C:\\Users\\xia54\\.dsh\\profiles\\qqbot',
    '/home/ubuntu/.dsh/profiles/qqbot',
  ];
  for (const c of cand) if (existsSync(c)) return c;
  return null;
}

const profileDir = findProfileDir();
if (!profileDir) {
  console.error('[patch] 找不到 qqbot profile 目录 —— 用 --profile-dir 指定');
  process.exit(2);
}

const dist = join(profileDir, 'node_modules', '@tencent-connect', 'dsh-qqbot', 'dist');
const inboundPath = join(dist, 'transport', 'inbound.js');
const peerSrc = join(HERE, 'peer-registry.js');
const peerDst = join(dist, 'features', 'peer-registry.js');

console.log(`[patch] profile = ${profileDir}`);
console.log(`[patch] dist    = ${dist}`);

if (!existsSync(inboundPath)) {
  console.error(`[patch] 找不到 ${inboundPath} —— 适配器没装在这个 profile 里？`);
  process.exit(2);
}

// ── 补丁 ②-a：peer-registry.js 本体
if (!existsSync(peerSrc)) {
  console.error(`[patch] 补丁源文件不在：${peerSrc}`);
  process.exit(2);
}
const peerSame = existsSync(peerDst)
  && readFileSync(peerDst, 'utf8') === readFileSync(peerSrc, 'utf8');
if (peerSame) {
  notes.push('peer-registry.js 已在位且内容一致');
} else if (checkOnly) {
  problems.push('peer-registry.js 缺失或与补丁源不一致');
} else {
  mkdirSync(dirname(peerDst), { recursive: true });
  copyFileSync(peerSrc, peerDst);
  notes.push('peer-registry.js 已写入');
}

// ── 补丁 ②-b：inbound.js 的两处插入
let src = readFileSync(inboundPath, 'utf8');
const IMPORT_LINE = 'import { rememberPeer } from "../features/peer-registry.js";';
const ANCHOR_IMPORT = 'import { clearGroupHistory } from "../features/history-store.js";';
const ANCHOR_CALL = '    record.agent.followup(message);';
const CALL_BLOCK = [
  '    // ⚠️ 必须在 followup **之前**：turn 一旦开始，system prompt 就先组装了。',
  '    rememberPeer({',
  '        cwd: config.cwd,',
  '        sessionId: record.sessionId,',
  '        scope,',
  '        peerId,',
  '        senderId: msg.senderId,',
  '        senderName: msg.senderName,',
  '    });',
  ANCHOR_CALL,
].join('\n');

const hasImport = src.includes(IMPORT_LINE);
const hasCall = src.includes('rememberPeer({');

if (hasImport && hasCall) {
  notes.push('inbound.js 两处插入都在位');
} else if (checkOnly) {
  problems.push(`inbound.js 缺插入（import=${hasImport} call=${hasCall}）`);
} else {
  if (!hasImport) {
    if (!src.includes(ANCHOR_IMPORT)) {
      problems.push('inbound.js 里找不到锚点 import —— 包结构变了，需要人工看');
    } else {
      src = src.replace(ANCHOR_IMPORT, `${ANCHOR_IMPORT}\n${IMPORT_LINE}`);
    }
  }
  if (!hasCall) {
    if (!src.includes(ANCHOR_CALL)) {
      problems.push('inbound.js 里找不到锚点 record.agent.followup(message); —— 包结构变了，需要人工看');
    } else {
      src = src.replace(ANCHOR_CALL, CALL_BLOCK);
    }
  }
  if (problems.length === 0) {
    const bak = `${inboundPath}.bak-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
    copyFileSync(inboundPath, bak);
    writeFileSync(inboundPath, src, 'utf8');
    notes.push(`inbound.js 已打补丁（备份 ${bak}）`);
  }
}

// ── 补丁 ①：私聊 senderTag（**要能修，不只是体检**）
//
// ⚠️ 2026-10-06 实测抓到的漏洞：这一段原来**只检测不修复**，于是包一升级
//    peer-registry 修好了、私聊 senderTag 却仍然缺 —— 而且失败是**静默**的
//    （症状：私聊里超管判定失效，工具回「这个指令只有超管能下」）。
//    现在补上 apply 分支：定位 buildUserMessage 里那段私聊逻辑，改成带 senderTag 返回。
const C2C_PATCH_MARK = 'PATCH 2026-10-05 (saya)';
const C2C_ALREADY = new RegExp('return `\\$\\{quotePart\\}\\$\\{senderTag\\} \\$\\{userContent\\}`;');
let c2cPatched = src.includes(C2C_PATCH_MARK) || C2C_ALREADY.test(src);

if (c2cPatched) {
  notes.push('私聊 senderTag 补丁在位');
} else if (checkOnly) {
  problems.push('**私聊 senderTag 补丁不在**（2026-10-05 那个）—— 私聊里超管判定会失效');
} else {
  // 窄锚点：只在「非群聊」那一段里替换，且要求它出现在 buildUserMessage 函数体内。
  const fnAt = src.indexOf('function buildUserMessage(');
  const c2cAt = fnAt >= 0 ? src.indexOf('if (!isGroup) {', fnAt) : -1;
  const plainReturn = 'return `${quotePart}${userContent}`;';
  if (c2cAt < 0) {
    problems.push('inbound.js 里找不到 buildUserMessage 的私聊分支（if (!isGroup) {）—— 包结构变了，需要人工看');
  } else {
    const segEnd = src.indexOf('\n}', c2cAt);
    const seg = segEnd > c2cAt ? src.slice(c2cAt, segEnd) : '';
    // 结构替换：两种形态都吃（见本轮文件头的教训）
    //   A) 干净版：分支里是裸的 `return quotePart + userContent;`（**可能跨行**）
    //   B) 已打过旧补丁：分支里是「注释块 + 带 senderTag 的 return」
    const c2cReturnRe = /return\s+`\$\{quotePart\}`\s*\+?\s*`\$\{userContent\}`;/;
    const anyReturnRe = /return\s+`\$\{quotePart\}`[^;]*;/;
    const guardedRe = /\/\/\s*PATCH 2026-10-05 \(saya\)[\s\S]*?return\s+`\$\{quotePart\}\$\{senderTag\} \$\{userContent\}`;/;

    const indent = '        ';
    const MARK = '// ' + C2C_PATCH_MARK + ': c2c used to omit the sender tag entirely,\n'
      + indent + '// so downstream plugins could not tell who was talking (super-admin check silently failed).\n'
      + indent + 'return `${quotePart}${senderTag} ${userContent}`;';

    let newSeg = null;
    if (guardedRe.test(seg)) {
      // 已经是打过补丁的形态：把注释块规范化（幂等的关键 —— 保证二次运行结果一致）
      const norm = seg.replace(guardedRe, MARK);
      if (norm !== seg) newSeg = norm;
      c2cPatched = true;
    } else if (c2cReturnRe.test(seg)) {
      newSeg = seg.replace(c2cReturnRe, MARK);
    } else {
      const anyRet = anyReturnRe.exec(seg);
      if (anyRet) {
        // 有 return 但形状不认识（可能带了别的变量）—— 换成标准形态，但仍要人工确认过
        newSeg = seg.slice(0, anyRet.index) + MARK + seg.slice(anyRet.index + anyRet[0].length);
        notes.push('私聊分支的 return 形状与预期不同，已按标准形态改写（建议人工扫一眼）');
      } else {
        problems.push('私聊分支里既没有裸 return 也没有带 senderTag 的 return —— 包结构变了，需要人工看');
      }
    }

    if (newSeg !== null) {
      src = src.slice(0, c2cAt) + newSeg + src.slice(segEnd);
      c2cPatched = true;
      const bak = `${inboundPath}.bak-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
      copyFileSync(inboundPath, bak);
      writeFileSync(inboundPath, src, 'utf8');
      notes.push(`私聊 senderTag 补丁已打（备份 ${bak}）`);
    }
  }
}

// ── 复检：语法（用 node --check 同源的方式跑一遍解析）
if (!checkOnly && problems.length === 0) {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, ['--check', inboundPath], { encoding: 'utf8' });
  if (r.status !== 0) {
    problems.push(`打补丁后 inbound.js 语法不过：${(r.stderr || '').split('\n')[0]}`);
  } else {
    notes.push('node --check 通过');
  }
}

for (const n of notes) console.log(`  ✓ ${n}`);
for (const p of problems) console.log(`  ✗ ${p}`);
console.log(problems.length === 0 ? '[patch] VERDICT: OK' : '[patch] VERDICT: FAIL');
process.exit(problems.length === 0 ? 0 : 2);
