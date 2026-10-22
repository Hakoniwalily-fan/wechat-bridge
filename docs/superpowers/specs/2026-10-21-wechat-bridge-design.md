# 微信 ↔ DSH 桥（wechat-bridge）设计规格

- 日期：2026-10-21
- 状态：设计已确认，待实施
- 目标机器：本机 Windows，工作区 `D:\DHS`

## 1. 目标

在本机常驻一个桥接服务，让用户能够直接在自己**个人微信**里和一个常驻的 DeepSeek Harness（DSH）实例对话：发消息下达任务，DSH 在 `D:\DHS` 里真实执行（读写文件、跑命令、查资料），结果回到微信。

非目标：
- 不是通用多租户微信机器人平台
- 不替代 DSH 的桌面/Web 界面
- 不做群聊

## 2. 已验证的前提（spike 结论）

| 前提 | 验证方式 | 结论 |
|---|---|---|
| 微信官方 iLink Bot API 可裸调，无需 OpenClaw | 直接 `GET /ilink/bot/get_bot_qrcode?bot_type=3` | ✅ `ret: 0`，无需任何鉴权头 |
| 扫码可换取可用 `bot_token` | 生成二维码 → 手机扫码 → 轮询 `get_qrcode_status` | ✅ `confirmed`，返回 `bot_token` / `ilink_bot_id` / `ilink_user_id` |
| 可收到真实用户消息 | `POST /ilink/bot/getupdates` 长轮询 | ✅ 收到 `"hello"`，含 `context_token` |
| 可回发消息 | `POST /ilink/bot/sendmessage` | ✅ HTTP 200，返回 `message_id` |
| DSH 可被程序驱动 | `dsh --profile headless --json "只回复两个字：收到"` | ✅ NDJSON 事件流，9 秒返回，含 `session` / `final` |
| DSH 支持会话续接 | `dsh --profile headless --json --session-id <id>` | 帮助文本声明支持（实施时验证） |
| Node 可直连外网 | `node -e "fetch(...)"` | ✅ 200（PowerShell 的 Invoke-WebRequest 走代理会超时，但 Node 不受影响） |

iLink 协议要点（来自公开协议整理与实测）：
- 基座 `https://ilinkai.weixin.qq.com`，HTTP/JSON
- 业务请求头：`Content-Type: application/json`、`AuthorizationType: ilink_bot_token`、`Authorization: Bearer <bot_token>`、`X-WECHAT-UIN: base64(十进制随机 uint32)`
- 所有业务 POST 需带 `base_info: { channel_version }`
- 收消息是**长轮询**（服务端 hold ~35 秒），不是 WebSocket
- `get_updates_buf` 是**不透明游标**，必须原样持久化并回传
- 回复必须回传入站消息的 `context_token`，否则无法投递到正确会话
- `ret/errcode = -14` 表示 session 过期，只能重新扫码
- 文本建议按 2000 字符分片

## 3. 架构

```
微信 App
   │  iLink HTTPS（getupdates 长轮询 / sendmessage）
   ▼
bridge（Node，常驻单进程）
   ├ ilink.mjs   登录、长轮询、发送、typing
   ├ router.mjs  命令解析、串行队列、急停
   ├ dsh.mjs     spawn dsh headless --json，解析事件，管理会话映射
   ├ chunk.mjs   2000 字友好分片
   ├ qr.mjs      二维码渲染（终端 + PNG）
   ├ store.mjs   状态原子持久化
   └ log.mjs     按天切分的日志
   │  child_process（stdin 传任务，stdout 读 NDJSON）
   ▼
dsh --profile headless --json --session-id <id>
   │
   ▼
工作区 D:\DHS
```

进程与文件布局：

```
D:\DHS\wechat-bridge\
  package.json
  src/{main,ilink,router,dsh,chunk,qr,store,log}.mjs
  test/*.test.mjs
  scripts/install-task.ps1
  README.md
  docs/superpowers/specs/2026-10-21-wechat-bridge-design.md

%USERPROFILE%\.wechat-bridge\
  creds.json       { token, baseUrl, accountId, userId, savedAt }
  cursor.json      { botId, getUpdatesBuf }
  session.json     { userId: { sessionId, turns, totalTokens, updatedAt, summary } }
  seen.json        { messageIds: [...] }       最近 200 个
  logs\bridge-YYYY-MM-DD.log
  qr.png           重登用二维码
```

依赖策略：仅 `qrcode` 一个运行时依赖（渲染二维码），其余全部使用 Node 内置（`fetch`、`node:crypto`、`node:test`）。

## 4. 模块契约

### 4.1 `store.mjs`

```js
createStore(dir)
  .read(name, fallback)      // 读取 JSON，缺失或损坏返回 fallback
  .write(name, value)        // 原子写：写 .tmp 再 rename
```

不做缓存，每次调用走磁盘——状态文件很小，正确性优先。

### 4.2 `ilink.mjs`

```js
createIlink({ creds, channelVersion, fetchImpl, logger })
  .cursor                    // 读写 get_updates_buf 游标（getter/setter）；凭证是否存在由 store 判断
  .login(onQr)               // 出二维码 → onQr(pngPath, url) → 轮询至 confirmed → 返回 creds
  .poll({ signal })          // 一次 getupdates，返回 { msgs, cursor }；本地超时返回 { msgs: [], cursor: undefined }
  .sendText({ toUserId, contextToken, text })
  .sendTyping({ toUserId, contextToken, status })   // 1 开始 / 2 结束；失败静默
```

- `fetchImpl` 可注入，集成测试用假服务替换
- 所有错误归一为 `IlinkError { kind: 'session-expired' | 'network' | 'server' | 'auth', ret?, message }`
- `poll` 内部超时设 35 秒，超时不是错误

### 4.3 `dsh.mjs`

```js
createRunner({ dshBin, profile, workspace, logger })
  .run({ taskText, sessionId, onEvent, signal })   // 返回 { sessionId, finalText, usage, exitCode, stderrTail }
```

- 用 `spawn(dshBin, ['--profile', profile, '--json', ...(sessionId ? ['--session-id', sessionId] : []), '-'], { cwd: workspace })`
- **必须传 `env: { ...process.env, DSH_PERMISSION_MODE: 'danger-full-access' }`**。headless profile 禁用了 `settings` 插件，`settings.yaml` 的 `permission.defaultPreset` 不生效，默认落在 `workspace-write` 沙箱；本机该沙箱给 `D:\DHS` 授权时失败（`SetNamedSecurityInfoW Win32 5`），而提权又无审批通道，结果任何命令都执行不了（实测：不传该变量时 `pwd` 直接报错，传入后正常）。这个变量同时把 approval 切成 `never`，与 §9 的「完全授权」一致。
- 任务文本走 **stdin**（规避 Windows 命令行长度限制），写完即 `end()`
- 逐行解析 NDJSON；解析失败的行记日志并跳过（宽容策略）
- 事件类型：`session`、`status`（含 `phase`）、`thinking`、`text`、`final`
- `onEvent` 每个事件回调一次，供上层做进度与 token 累计
- `signal` 触发时 kill **整个进程树**（Windows 用 `taskkill /T /F /PID`），保证不留下孤儿进程

### 4.4 `chunk.mjs`

```js
chunkText(text, limit = 2000)  // => string[]
```

优先在 `\n\n` 切，其次 `\n`，其次空格，最后硬切；不产生空片；超长单行也能切。

### 4.5 `router.mjs`

```js
createRouter({ ilink, runner, store, logger, workspace, preamble, limits })
  .handle(msg)      // 入站消息 → 命令或任务
  .stop()           // 急停：kill 当前进程 + 清队列
  .status()         // 供 /status 使用
```

串行：内部单 worker 循环消费队列；队列上限 5，超出立即回「还在忙，已排队 5 条，多的先不收了」。

### 4.6 `qr.mjs`

```js
renderQr(url, { pngPath })   // 终端 ASCII + 落 PNG，返回 pngPath
```

## 5. 会话与上下文

- 键：`ilink_user_id`（本方案只有你一个人，但结构支持多用户）
- 首条消息不带 `--session-id`，从 `session` 事件取 `sessionId` 落盘
- 之后每条都带 `--session-id`
- 计数口径：`turns` = 该会话已成功完成的任务数（每次 `turn_end` 且未抛错加一）；`totalTokens` = 所有 `status.step_end.usage.totalTokens` 之和，累计到 `session.json`
- **自动换代**：`totalTokens > 400_000` 或 `turns > 40` 时触发
  1. 用旧会话跑一次「把目前为止的关键信息和结论压成 300 字以内」
  2. 取该次 `final` 作为 `summary`
  3. 新会话首条消息前缀 `（前情提要：<summary>）\n\n`
  4. 重置 `turns` / `totalTokens`，保留 `summary`
  5. 不发任何提示，只记一条日志（多一条消息会打断对话）
- 摘要在内存中保留一份，换代失败（模型报错）则不带摘要直接换，并告知用户

## 6. 消息处理流程

```
入站 msg
  ├ message_id 在 seen 中 → 丢弃
  ├ message_type !== 1（用户消息）→ 丢弃
  ├ item.type !== 1（文本）→ 回「暂时只支持文字」
  ├ 文本命中命令表 → 桥自行处理
  └ 否则 → 入队
        └ worker 取出
              ├ 会话续接或新建（必要时先换代）
              ├ 出队即发固定回执「收到，开始处理…」（不依赖模型，保证立刻有反馈）
              ├ sendTyping(1) 并每 5 秒保活
              ├ runner.run(...)
              │    ├ step_end          → 累计 token
              │    └ 超过 45 秒未出结果 → 推一条轻进度（每次任务最多一条）
              ├ sendTyping(2)
              ├ finalText 分片发送；空则用累积 text；再空则「任务结束，没有输出」
              └ 非零退出 → 附 stderr 尾部（800 字）
```

命令表：

| 命令 | 别名 | 行为 |
|---|---|---|
| `/stop` | `/急停` | kill 进程树 + 清队列，回「已停」 |
| `/status` | `/状态` | 当前任务、已排队数、会话 id、累计 token |
| `/new` | `/新会话` | 强制换代 |
| `/help` | `/帮助` | 命令列表 |

命令匹配前去首尾空白、大小写不敏感。

## 7. 汇报节奏

桥在任务文本前注入可配置前缀（默认）：

```
[微信通道·手机端] 你的回复会被分片显示在手机上。结论控制在 2000 字内；如果产出文件或需要用户选形式，先问再动手。

```

「收到，开始处理…」由桥自己发，不写进前缀——模型只在最后产出一次，指望它及时确认是做不到的。

用户明确要求：**汇报详略与是否回传文件，由 DSH 在每个任务中自行判断、必要时先问用户**，桥不写死策略，只提供能力（确认、进度、分片、询问）。

## 8. 失败处理

| 情况 | 处理 |
|---|---|
| 长轮询本地超时 | 视为空轮询，立即发下一轮 |
| `ret/errcode = -14` | 清 `creds.json` 与 `cursor.json` → 重新出二维码 → PNG 落 `%USERPROFILE%\.wechat-bridge\qr.png` → 日志首行醒目提示 |
| 网络错误 | 2 秒后重试；连失 3 次退避 30 秒；期间不回用户消息（避免刷屏） |
| 服务端 5xx | 同上 |
| 子进程非零退出 | 把 stderr 尾部 800 字发到微信，队列继续 |
| 子进程超时（30 分钟） | kill 进程树，回「任务超时，已中止」 |
| 桥进程崩溃 | 任务计划程序拉起；`cursor.json` 恢复游标；`seen.json` 去重 |
| 重复 `message_id` | 只处理一次 |
| 状态文件损坏 | `read` 返回 fallback 并记警告日志，不中断 |

## 9. 安全

- 决策：**完全授权**（`danger-full-access`，与当前会话一致）+ `/stop` 急停
- 边界依据：ClawBot 会话只有扫码者本人能发消息；`ilink_user_id` 严格校验，非本人 `from_user_id` 一律丢弃并记日志
- 凭证文件写入 `%USERPROFILE%\.wechat-bridge\`，尽力收紧 ACL；token 不写日志（日志中统一脱敏为 `ilinkbot_***`）
- 不在日志中记录消息正文（只记长度与 hash），避免敏感内容落盘

## 10. 测试策略

单元（`node --test`）：

- `chunk.mjs`：边界、空串、超长单行、优先切分点、不产生空片
- `dsh.mjs` 事件聚合：正常流、残缺行、无 `final`、非零退出
- `ilink.mjs`：`X-WECHAT-UIN` 格式、请求头与 body 结构、错误归一（`-14` → `session-expired`）
- `router.mjs`：命令匹配与别名、队列上限、去重、非文本消息、非本人消息
- 换代判定：token 阈值、轮次阈值、摘要失败回退

集成：

- 本地 `http.createServer` 假 iLink 服务，模拟 `getupdates`（返回构造消息）与 `sendmessage`（断言收到的 body 含 `context_token` 与分片文本），驱动 `router` 全链路
- 真跑一条 `dsh --profile headless --json "只回复 OK"` 验证 runner 契约

手工验收：

1. 启动桥，终端/日志出二维码（已登录则跳过）
2. 微信发「你好」→ 收到确认与回答
3. 发「在 D:\DHS 建一个 test-wechat.txt，内容是 hello」→ 文件真实出现，微信收到结果
4. 发一个长任务后 `/stop` → 任务中止
5. `/status` 能报会话与 token

## 11. 实施期确定的行为（与最初设计的差异）

以下几条是在实现和审查过程中定下来的，与 §4–§8 的初稿有出入，以本节为准。

1. **出站发送是 best-effort。** 所有文本出站走 `safeSend()`：内部 `chunkText` 分片、整段 try/catch、失败只 `logger.warn` 并返回 `false`，不让异常穿出 `runTask`。代价是**多片回答若在第 k 片失败会静默截断**，调用方拿不到返回值、`/status` 也看不出来。取舍理由：一条发送失败不能拖垮常驻进程或卡死队列。
2. **`/stop` 在换代摘要期间也会中止摘要。** `maybeRollover` 接受 `signal` 并转发给摘要子运行。代价：若停止落在摘要中途，换代仍会落盘（`summary: null`、`sessionId: null`），旧上下文丢失且不会发「上下文换新了」的提示——下次任务从空上下文开始。
3. **关停走 `router.stop()`。** SIGINT/SIGTERM → 置停止标志 → `router.stop()`（清队列 + abort 在跑任务，子进程被 kill 树）→ abort 长轮询；随后最多等 5 秒让在跑任务收尾，超时记「强制退出」并以 0 退出。轮询退避的 sleep 也是可中止的。
4. **登录失败可重试，不再直接退出。** `network` / `server` 按 2s、2s、30s 退避重试；`aborted`（例如扫码期间 Ctrl-C）记提示后干净退出 0；`auth` 等不可重试错误才走致命路径。没有尝试次数上限。
5. **DSH 子进程的启动方式**（见 §4.3）：Windows 经 `cmd.exe /d /c dsh` 间接启动，并注入 `DSH_PERMISSION_MODE=danger-full-access`。
6. **换代阈值硬编码** 400k token / 40 轮，未做成配置项。

## 12. 入站媒体（已实现）

用户发来的图片、语音、文件现在都能收到。管线在 `src/media.mjs`，只做一件事：把微信 CDN 上的加密引用变成磁盘上的普通文件。

**落盘位置**：`D:\DHS\.wechat-inbox\<YYYY-MM-DD>\<messageId>-<安全文件名>`，按天分目录，不自动清理。

**协议**：媒体用 AES-128-ECB + PKCS7 加密，`GET https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=<urlencode>` 取回密文，本地解密。`aes_key` 有三种编码（`base64(16字节)` / `base64(32个hex字符)` / 纯 32 位 hex，图片的 `image_item.aeskey` 是第三种），全部兼容。

**交给 DSH 的方式**：桥不看图、不做识别，只把路径写进任务描述，由 DSH 自己去读。这样不需要视觉模型。

| 类型 | 任务文案 |
|---|---|
| 图片 | 「已保存到 `<path>`，请先用读图工具查看」→ 相当于自动读 |
| 语音 | 「微信自动转写：`<voice_item.text>`；原始音频在 `<path>`」 |
| 文件 | 「文件 `<name>` 已保存到 `<path>`（`<bytes>` 字节）」 |
| 视频 | 明确拒绝，不下载 |

**限制与安全**：

- 单文件上限 20 MB；声明大小超限直接拒绝、不发起下载
- `file_name` 是不可信输入：只取 basename、过滤非法字符、剥掉开头的点，防止 `..\..\` 写到工作区外
- 下载/解密失败回一句可读原因，不带 CDN 参数
- 下载在轮询循环里同步等待，期间新消息排到下一次 `getuptes` 之后；单用户场景可接受

**出站（生成文件发回微信）** —— 见 §13。

## 13. 出站媒体（已实现）

模型在回复里写一行 `[[send: <绝对路径>]]`，桥解析出来后上传发送，**标记本身不出现在用户看到的消息里**。

流程（`src/upload.mjs`）：

```
1. POST /ilink/bot/getuploadurl
   { filekey(16字节hex), media_type, to_user_id, rawsize,
     rawfilemd5, filesize = ceil((rawsize+1)/16)*16, no_need_thumb:true, aeskey(hex) }
2. 本地 AES-128-ECB + PKCS7 加密
3. POST https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=…&filekey=…
   → 响应头 x-encrypted-param
4. POST /ilink/bot/sendmessage，item 带 CDNMedia
```

**类型判定**：按扩展名，`.jpg/.jpeg/.png/.gif/.webp` → `media_type 1` + `image_item`（带 `mid_size`）；其余 → `media_type 3` + `file_item`（带 `file_name`、`len`）。上限 20 MB。

**与入站不同、必须写死的三处**：

- 出站 `aes_key` 是 `base64(hex 字符串)`，不是原始 16 字节
- `file_item.len` 是**字符串**形式的明文字节数
- `filesize` 是 PKCS7 填充后的密文长度，不是文件大小

**失败处理**：文件不存在 / 超限 / 上传失败 / 缺 `x-encrypted-param`，都单独回一句原因，然后**照常把正文发出去**——附件失败不能把回答一起吞掉。只发附件没写正文时补一句「已发出 N 个文件」。

**上传器必须绑定当前 `ilink` 实例**：重新登录会换 client，旧实例的 token 已经失效，所以 `makeRouter` 每次都用传入的 client 新建 uploader。

## 14. 范围外

- 视频入站 / 出站
- 群聊（协议有 `group_id`，公开实现只做单聊）
- 多用户 / 多 bot
- 主动定时推送（保留 `notify()` 接口，先不接）
- Web 管理界面

## 15. 上线步骤

1. `npm i`（仅 qrcode）
2. `node src/main.mjs` 首次跑，扫码
3. 验收清单（见 §10 手工验收）
4. `scripts/install-task.ps1` 注册开机自启
5. 观察一天日志，确认长轮询稳定、无 `-14`
