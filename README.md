# wechat-bridge

把个人微信接成 DeepSeek Harness 的对话入口。微信里发消息 → 本机 `dsh headless` 执行 → 结果回微信。支持文字、图片、语音、文件双向。

## 依赖

- Node.js >= 24
- `dsh` 在 PATH 上

## 首次运行

```powershell
npm i
node src/main.mjs
```

终端会打印二维码，微信扫码确认。凭证存到 `%USERPROFILE%\.wechat-bridge\creds.json`，之后不再需要扫码。

## 命令

| 命令 | 说明 |
|---|---|
| `/stop` `/急停` | 中止当前任务并清空队列 |
| `/status` `/状态` | 当前任务、会话、用量 |
| `/new` `/新会话` | 强制换新会话 |
| `/help` `/帮助` | 命令列表 |

## 媒体（入站）

可以直接发**图片、语音、文件**给它：

- **图片**：落盘到 `D:\DHS\.wechat-inbox\<日期>\`，然后它自己用读图工具看
- **语音**：用微信自带的转写结果当正文，同时保存原始音频（`.silk`）
- **文件**：落盘后由它按需读取

单文件上限 **20 MB**，超了直接回一句、不下载。视频暂不支持。

入站文件**保留 7 天**，启动时和每天各清理一次；空目录一并删除。

## 媒体（出站）

它生成文件后，只要在回复里写一行标记，桥就会把文件发到你微信：

```
报告做好了。[[send: D:\DHS\报告.docx]]
```

标记不会显示在你收到的消息里。按扩展名分流：`.jpg/.jpeg/.png/.gif/.webp` 走图片消息，其余走文件消息。上限同样是 20 MB。

上传失败（文件不存在、超限、CDN 报错）会单独回一句原因，**正文照发**，不会连回答一起吞掉。

## 开机自启

**首选：计划任务（需要管理员）**

```powershell
# Win+X -> 终端(管理员)，然后：
powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1
```

任务在**登录时**触发，并额外每 **5 分钟**触发一次（已在运行则忽略），所以：

- 任务动作是 `start-hidden.vbs`（隐藏窗口）→ `start.cmd`（supervisor 循环）→ `node src\main.mjs`
- node 无论怎么死（崩溃、被 taskkill、被控制台中断），**5 秒内自动回来**
- 连 supervisor 一起没了，最多 5 分钟被脉冲拉起来
- 单实例锁保证不会同时跑两个桥（多出来的会打印 `已有实例在运行 pid=…` 并以退出码 3 退出，supervisor 见到 3 就退避 60 秒）

脚本会先停掉旧实例、清掉 Run 自启动项；非提权运行会直接报错退出，不会装出半个任务。

**备选：当前用户自启（不需要管理员）**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
```

写 `HKCU\...\CurrentVersion\Run` + `start.cmd`。仅在没有管理员权限时使用；**不要和计划任务同时启用**。

## 运维

```powershell
# 看状态
Get-ScheduledTaskInfo -TaskName WeChatBridge

# 只重启内层桥（最常用）—— supervisor 会自动拉起
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*main.mjs*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# 彻底停：Stop-ScheduledTask 只杀最外层 wscript，必须连 cmd 和 node 一起清
Stop-ScheduledTask -TaskName WeChatBridge
Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -like '*main.mjs*' -or
  $_.CommandLine -like '*start.cmd*' -or
  $_.CommandLine -like '*start-hidden.vbs*'
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# 卸载
Unregister-ScheduledTask -TaskName WeChatBridge -Confirm:$false
```

## 排查

| 文件 | 内容 |
|---|---|
| `%USERPROFILE%\.wechat-bridge\logs\bridge-YYYY-MM-DD.log` | 桥自身日志（ISO 时间戳） |
| `%USERPROFILE%\.wechat-bridge\logs\supervisor.log` | 进程重启记录（无时间戳，只有序号和退出码） |
| `%USERPROFILE%\.wechat-bridge\qr.png` | 需要重新扫码时的二维码 |
| `%USERPROFILE%\.wechat-bridge\bridge.lock` | 单实例锁，内容是持有者 pid |

常见情况：

- 收到 `-14` 或 `auth` → 自动清凭证并要求重新扫码
- 日志出现 `已有实例在运行 pid=…` → 有残留实例，按上面「彻底停」清一遍
- 没回复但进程在 → 看 `bridge-*.log` 有没有 `轮询失败`；没有就是把消息当成了陌生来源（`忽略陌生来源消息 from=… expected=…`）

## 已知限制

- 视频不支持（入站出站都不行）
- 群聊不支持
- 会话换代阈值硬编码 150k token / 40 轮
- 单用户（只有绑定者本人能用）
- 主动推送受微信 24 小时窗口限制
