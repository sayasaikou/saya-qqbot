# saya-qqbot

一个带**人格、跨会话记忆、视觉理解**的 QQ 机器人，跑在 [DeepSeek Harness](https://github.com/deepseek-ai) 的独立 profile 上。

基于 QQ 官方机器人平台（`bot.q.qq.com`）+ 腾讯官方插件 [`@tencent-connect/dsh-qqbot`](https://www.npmjs.com/package/@tencent-connect/dsh-qqbot)。

---

## 它解决什么问题

QQ 官方机器人有两个硬约束，直接决定了架构：

| 约束 | 后果 |
| --- | --- |
| **群聊被动回复窗口 5 分钟 / 5 次**，单聊 60 分钟 / 4 次 | 不能"想发就发"，要控制回复频率 |
| **发消息要求 WebSocket 在线** | 进程必须常驻，掉线即失联 |

在此之上，本项目的重点是三件"通用机器人框架通常不做"的事：

1. **人格与记忆隔离** —— 机器人有独立人格，但**不知道主机用户的私人信息**（避免人格文件里的私人内容泄漏到群聊）
2. **跨会话记忆** —— 同一个人在不同群/私聊里说的话，机器人"记得"
3. **看图** —— 不只是"丢给视觉模型问一句"（那会出错，见下方）

---

## 三个设计决定（都是实测逼出来的）

### 一、机械动作必须硬编码，不能靠提示词让模型自觉

**失败的版本**：把"记录对话到共享记忆"写成人格里的建议 —— 模型把它当成**可选提议**，于是：
> 「本鱼这边是真不记得。会话之间是隔离的……想让我跨会话记住，就说一声。」

**改法**：用 DSH 的事件钩子（`session/event`）在插件里硬记录，用 `system-prompt/assemble` 硬注入。
⇒ **凡是"每次都该发生的机械动作"，交给模型自觉就会失败。**

### 二、看细节必须先裁出放大

**失败的版本**：把整张 4 MP 的图丢给视觉模型问"这图里是什么"：
> 「金色长发，兜帽上有红色狐狸耳，**银色配红色的露脐装**……」

**实际是**：红色无袖披风（敞开）＋ 里面银灰色胸衣，**没有露脐**。

**原因**：图被缩到模型输入尺寸后，两件衣服重叠成一个色块。

**改法**：定位主体 → 裁剪 → 放大 → 对那一块提问。
⇒ 完整的识图工具链已独立成仓：[`saya-vision`](https://github.com/sayasaikou/saya-vision)。

### 三、颜色不靠模型，靠算法

两个不同的视觉模型**异口同声**说某件衬衫是金色；PIL 取色一算：**深蓝近黑 `#272948`，占 62%**。

⇒ 取色一律用 `imgtool.py`，模型的话只用来补充**形状、语义、关系**。

---

## 结构

```
persona/AGENTS.md        人格规格（会被注入 agent 的指令文件）
work/MEMORY.md           跨会话记忆的规范（给模型看的）
work/MEMES.md            表情包清单（分类 + 路径）
work/vision-workflow.md  看图工作流（给模型看的作业指导）
plugin/                  自研 DSH 插件：qqbot-memory
  index.js                 会话记录 + 跨会话记忆注入 + 每日 token 限额
  look-tool.js             看图工具 qqbot_look（定位/裁块/超分/反向搜图）
  selftest.mjs             16 项自测，用假 ctx 跑真实代码
config/cordis.patch.yml  profile 配置（沙箱/权限/视觉 provider）
tools/                   识图工具链（与 saya-vision 同源）
.env.example             需要配置的路径（复制成 .env 或设为环境变量）
```

**数据不在这个仓里** —— 聊天记录、token 统计、跨会话记忆在私有仓
[`saya-qqbot-data`](https://github.com/sayasaikou/saya-qqbot-data)（私有，因为含 QQ openid）。

理由：数据每天变、代码偶尔改。混在一起时 `git log` 里全是"sync: 数据"，真正的代码改动被淹没。

**本机同步**：`sync-qqbot.ps1` 把运行时文件分别推到两个仓 ——
代码/文档 → `saya-qqbot`，数据 → `saya-qqbot-data`。

---

## 插件：qqbot-memory

三个功能，都在 `plugin/index.js` 与 `plugin/look-tool.js`：

| 功能 | 实现 |
| --- | --- |
| **聊天记录** | `session/event` 钩子 → 按会话写 JSONL |
| **跨会话记忆** | `system-prompt/assemble`（**必须带 `{ global: true }`**）→ 注入"其它场合的近期对话" |
| **每日 token 限额** | 落盘统计 → 超额时在提示词里注入收尾指示（**软拦截**，不是硬拒绝） |

### 三个必须知道的坑（都实测过）

| 坑 | 现象 |
| --- | --- |
| **`export const inject = []`（空数组）** | 插件**静默不加载** —— 不报错、不留日志、`apply` 根本不执行。不写这个导出即可 |
| **`system-prompt/assemble` 不带 `{ global: true }`** | 监听器注册在收不到事件的作用域上 → 注入永远不生效、**也不报错** |
| **事件结构是 `raw.data`，不是 `raw.message`** | 猜错就一条记录都写不下来（`extractMessage` 的注释里有实测结构） |

### 改完必须跑自测

```bash
node plugin/selftest.mjs
```

16 项断言，**用假 ctx / 假 llm 跑真实代码**，几秒出结果。

**为什么必须**：这条链路连续出过三个 bug —— 跨作用域引用块内 `const`（`r is not defined`）、
文件扩展名不一致（存 `.jpg` 读 `.png` → ENOENT）、路径拼接被 JS 的 `$'` 特殊模式改写。
**`node --check` 和 `py_compile` 一个都查不出来**，全都是运行期错。

---

## 部署

```bash
# 1) 凭据：每个值一个文件，值不进脚本、不进命令行
#    <keydir>/sayask.txt        -> DEEPSEEK_API_KEY
#    <keydir>/qqbot-appid.txt   -> QQBOT_APPID
#    <keydir>/qqbot-secret.txt  -> QQBOT_SECRET

# 2) 路径：复制 .env.example，按自己的环境改
cp .env.example .env

# 3) 启动（-Hidden 后台运行）
pwsh -NoProfile -File ./start-qqbot.ps1 -Restart -Hidden
```

**长期运行**（Windows 计划任务）：
- 登录自启：一次 `-Start`
- 每 5 分钟巡检：`-Check` —— 进程不在就拉起，带 3 分钟退避防崩溃循环
- 注意： 计划任务脚本**必须纯 ASCII**（PS 5.1 按 ANSI 读无 BOM 的 UTF-8）
- 注意： `.cmd` 包装器**必须 CRLF**（裸 LF 会让 cmd 吃掉下一行首字符）

---

## 已知边界

- **限流是软拦截**：超额后模型会收尾，但**仍会调用一次 LLM**（提示词里注入了指示）。
  真正的硬闸门是账户余额。
- **插件源码仍带着本机的绝对路径**（`plugin/look-tool.js` 里的 Python 路径等）。
  它们已参数化成 `${QQBOT_*}` / `${DSH_*}` 变量，但**你在自己环境里需要核对一遍**。
- **正向识别角色受网络限制**：`trace.moe` 可用，SauceNAO / ascii2d 在受限网络下不通。
- 这份实现是**为"少人数、私域"场景**写的。开放给陌生人用之前，
  `config/cordis.patch.yml` 里的沙箱与权限设置**必须收紧**。

---

## License

MIT
