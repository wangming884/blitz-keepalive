# blitz.cloud 保活方案：用服务器上的真实浏览器定时访问

> 目标：让 blitz.cloud **免费版**应用不进入休眠（30 分钟无访客 → 缩容到 0）。
> 支持两种用法：**单个应用**，或**多个账号 / 多个应用**共用一个常驻进程。
> 做法：在**你自己的服务器**上常驻无头 Chrome/Edge，按目标列表错峰真实访问页面。
> 代码已在本机（Windows + Chrome 155）用模拟的 blitz 休眠/唤醒行为跑通，见「验证结果」。

## 1. 为什么必须用浏览器，而不是 curl / 探活脚本

| 事实 | 出处 |
| --- | --- |
| 免费版应用 **30 分钟**没有访客就休眠，下次浏览器访问时唤醒（约 10 秒） | [limits](https://blitz.cloud/docs/limits/) |
| **2026-09-29 起**，程序请求（uptime 监控、脚本、webhook、API 客户端）**不再唤醒**免费版应用，只会拿到「asleep」响应 | [changelog](https://blitz.cloud/changelog/) |
| 唤醒页在唤醒超过 5 秒时展示，页面会**自行刷新**直到应用就绪 | [limits](https://blitz.cloud/docs/limits/) |
| 官方「Keep it awake」是 Pro（7 EUR/月，**按账号**计费）功能 | [pricing](https://blitz.cloud/pricing/) |

所以：`curl`、Uptime Kuma、GitHub Actions 定时 ping 全部无效；必须是一个会执行 HTML/JS、带浏览器导航头的真实浏览器访问。

## 2. 方案对比与取舍

| 方案 | 成本 | 可靠性 | 结论 |
| --- | --- | --- | --- |
| **A. Pro + Keep it awake** | 7 EUR/月/账号 | 官方保证，webhook 随时可达 | **生产环境首选** |
| **B. 服务器浏览器定时访问（本方案）** | 免费 | 中：依赖 blitz 的访客判定与页面文案 | 个人项目 / 演示 / 免费额度内可用 |
| C. HTTP 探活 / 定时 curl | 免费 | **已失效**（2026-09-29 起程序请求不唤醒） | 不适用免费版 |
| D. 改成「后台运行」应用 | 免费 | 高（无地址 → 永不睡眠） | 仅 bot / worker，且没有 HTTP 地址 |

**多账号时的成本提醒**：Pro 按账号收费（7 EUR/账号），5 个账号就是 35 EUR/月。如果这些应用可以合并到同一个账号（免费版单账号 5 个应用，Pro 单账号 50 个应用），**合并成一个账号 + 一份 Pro** 通常比给每个账号单独付费更便宜，也比长期跑浏览器保活更可靠。只有当你必须保留多个独立账号时，才值得用本方案的多目标模式。

## 3. 工作方式

### 3.1 单个目标

```
每 20 分钟（+0~2 分钟随机抖动）
        │
        ▼
启动 headless Chrome（正常 UA，1366x900）
        │
        ▼
page.goto(应用地址)  ──► 可能是 blitz 的「唤醒中」页面
        │                        │ 页面自带刷新
        │                        ▼
        │                 轮询 DOM，直到出现应用内容
        ▼
校验：命中 EXPECT_TEXT（推荐）且不含 asleep/waking 等文案
        │
        ▼
停留 6 秒（鼠标移动 + 轻微滚动），关闭浏览器，释放内存
        │
        ▼
失败则 60 秒后重试，最多 2 次；单轮失败不会导致休眠
```

### 3.2 多账号 / 多应用

一个进程内维护目标列表，调度器按「到期时间」驱动：

```
targets.json
  ├─ alice-blog     interval 20m ──► 首次 t+0m，之后 20m + 抖动
  ├─ alice-n8n      interval 15m ──► 首次 t+6.7m，之后 15m + 抖动
  └─ bob-uptime     interval 20m ──► 首次 t+13.3m，之后 20m + 抖动

每 5 秒扫描一次到期目标
        │
        ▼
并发池（maxConcurrent，默认 2）
  ├─ worker 1: 启动独立 Chrome → 访问 → 校验 → 关闭
  └─ worker 2: 启动独立 Chrome → 访问 → 校验 → 关闭
        │
        ▼
每个目标独立计算下一次时间、独立重试、独立失败截图
```

设计要点：

- **首轮错峰**：启动后把目标按 `interval / 目标数` 铺开，避免同时打满；之后各目标按自己的间隔运行。
- **每个目标独立浏览器进程**：一个应用卡死不会拖垮其他应用；并发上限防止内存尖峰。
- **独立失败处理**：每个目标有自己的重试次数与日志字段（`target` / `account`），失败现场按 `target` 命名。
- **单实例锁**：常驻进程和 cron 扫描不会同时跑；锁文件按工作目录区分。
- **可选的后台访问密码**：只访问唤醒页也能让 blitz 应用保持唤醒；如果希望每次巡检继续进入应用后台，可在网页管理端为单个目标保存访问密码，让浏览器自动填写密码框并提交登录表单。密码加密后持久化，不会写入日志或 API 响应。

## 4. 多账号配置

复制 `config.example.json`，按需修改：

```json
{
  "defaults": {
    "intervalMin": 20,
    "jitterMin": 3,
    "expect": "",
    "timeoutSec": 60,
    "wakeWaitSec": 45,
    "settleSec": 6,
    "retries": 2,
    "retryDelaySec": 60
  },
  "maxConcurrent": 2,
  "targets": [
    { "id": "alice-blog",   "account": "alice", "url": "https://blog.alice.blitz.cloud",   "expect": "Alice" },
    { "id": "alice-n8n",    "account": "alice", "url": "https://n8n.alice.blitz.cloud",    "expect": "n8n", "intervalMin": 15 },
    { "id": "bob-uptime",   "account": "bob",   "url": "https://uptime.bob.blitz.cloud",   "expect": "Uptime Kuma" }
  ]
}
```

字段说明：

| 字段 | 作用 |
| --- | --- |
| `id` | 唯一标识，出现在日志与失败文件名中；默认取域名 |
| `account` | 仅用于日志分组，可省略 |
| `url` | 应用地址（http/https） |
| `expect` | **建议填写**应用页面独有文字，最可靠的「已唤醒」判据 |
| `intervalMin` | 该目标的访问间隔，1–28 分钟，且必须满足 `intervalMin + jitterMin <= 28` |
| `jitterMin` | 该目标的随机延迟上限，0–10 分钟 |
| `timeoutSec` / `wakeWaitSec` / `settleSec` / `retries` | 覆盖默认超时、唤醒等待、停留、重试 |
| `maxConcurrent` | 同时访问几个目标（1–5，默认 2） |

优先级：**目标级 > 命令行/环境变量 > defaults**。例如给 n8n 单独设 15 分钟，其余仍用 20 分钟。

`intervalMin + jitterMin` 必须不超过 28 分钟。这样即使取到最大抖动，下一次访问仍会发生在 blitz.cloud 的 30 分钟休眠阈值之前；配置为 29 分钟，或 20 分钟间隔加 10 分钟抖动，都会在启动时被拒绝。

### 3.3 目标后台访问密码

网页管理端的目标编辑窗口支持“后台访问密码”。配置后，巡检会先等待应用可访问，再在所有 frame 中查找第一个可见的密码输入框，按真实键盘节奏输入密码，并提交所在表单（没有提交按钮时按 Enter）。登录后再用 `expect` 校验应用后台内容，因此建议把 `expect` 设置为登录后才出现的文字。

使用边界：

- 当前只自动处理**密码框**，不处理用户名、验证码、双因素认证或第三方 OAuth；需要用户名的登录页会停在第一步并因 `expect` 不匹配而失败。
- 目标已经处于登录态、页面没有密码框时不会报错，仍按正常页面校验继续访问。
- 静态 `config.json` / `--url` 目标不支持此字段；只有 `/admin` 创建或编辑的网页目标支持。
- 编辑时密码留空表示保留原密码；勾选“清除已保存的访问密码”才会删除。不能在同一次请求中同时设置和清除。
- 密码使用 AES-256-GCM 加密，目标 ID 作为 AAD。密钥来自 `TARGET_SECRET_KEY`，或自动生成到 `TARGET_SECRET_KEY_FILE`（默认 `data/target-secrets.key`，权限 `0600`）。必须把密钥文件与 `managed-targets.json` 一起备份；密钥丢失后已保存的目标密码无法恢复，服务会拒绝启动而不是静默跳过。
- API 只返回 `loginPasswordConfigured` 布尔值，不返回明文、密文或密钥；失败现场写盘前也会清除所有 frame 中的密码框内容。

> 多目标模式下请把 `.env` 里的 `INTERVAL_MIN` / `JITTER_MIN` **留空**（安装脚本会自动清空），否则这个全局值会覆盖 JSON 里的 `defaults`。需要全局统一调整时再显式填写或传 `--interval-min`。

规模与资源参考（实测 Node.js 峰值约 70 MB，单个 Chromium 峰值私有内存约 144 MB，单次访问约 6 秒；下表为估算）：

| 目标数 | maxConcurrent | 峰值内存 | 一轮扫描耗时 |
| --- | --- | --- | --- |
| 1 | 1 | 约 200–250 MB | < 1 分钟 |
| 1–5 | 2 | 约 400–500 MB | < 1 分钟 |
| 6–20 | 2–3 | 约 600 MB–1 GB | 1–3 分钟 |
| 20–50 | 3 | 至少约 1 GB | 3–5 分钟 |

容器建议预留 768 MB–1 GB；复杂页面、登录流程、更多并发或 gVisor 环境应直接按 1 GB 以上规划。实际占用受页面复杂度、Chromium 版本、并发数和失败重试影响。

只要一轮扫描远小于 20 分钟，就不会有目标因调度延迟而休眠。

## 5. 网络代理（HTTP / HTTPS / SOCKS）

服务器必须经代理出网，或需要给不同账号使用不同出口 IP 时使用。

### 5.1 全局代理

```bash
# HTTP 代理 + Basic 认证：密码走环境变量，避免出现在进程列表
export PROXY_URL="http://proxy.example.com:8080"
export PROXY_USERNAME="alice"
export PROXY_PASSWORD="s3cret"
node keepalive.mjs --config=targets.json
```

```bash
# SOCKS5（Chromium 不支持 SOCKS 认证，代理需按 IP 放行）
node keepalive.mjs --config=targets.json --proxy=socks5://127.0.0.1:1080
```

支持的 scheme：`http://`、`https://`、`socks4://`、`socks5://`、`socks5h://`（`socks5h` 等价于 `socks5`，DNS 都在代理侧解析）。省略端口时用默认值：HTTP 80、HTTPS 443、SOCKS 1080。

### 5.2 每个目标单独配置

```json
{
  "defaults": { "proxy": "http://proxy.example.com:8080" },
  "targets": [
    { "id": "alice-blog", "url": "https://blog.alice.blitz.cloud", "expect": "Alice" },
    { "id": "bob-uptime", "url": "https://uptime.bob.blitz.cloud", "expect": "Uptime Kuma",
      "proxy": "socks5://10.0.0.5:1080" },
    { "id": "internal", "url": "https://internal.example.com", "proxy": "" }
  ]
}
```

- 目标未写 `proxy` → 继承全局代理；可以只覆盖 `proxyUsername` / `proxyPassword` / `proxyBypass`。
- `proxy: ""` → 该目标直连，即使全局配置了代理。
- 目标显式写 `proxy` 时只使用该代理自己的凭据，不会继承全局凭据，避免把 A 账号的密码发给 B 代理。

### 5.3 不走代理的地址

`PROXY_BYPASS`（或标准环境变量 `NO_PROXY`）支持逗号、分号、空格分隔，会自动转换成 Chromium 的 bypass 列表；`PROXY_BYPASS` 优先于 `NO_PROXY`：

```bash
export NO_PROXY="localhost,127.0.0.1,.internal.example.com"
```

> Chrome 默认绕过 `localhost` 与回环地址。要让本地测试目标也走代理，可传 `--proxy-bypass="<-loopback>"`（只建议测试使用）。

### 5.4 认证、DNS 与安全

| 项目 | 行为 |
| --- | --- |
| HTTP(S) 代理认证 | 支持 Basic；通过 `page.authenticate()` 提供，不写进 `--proxy-server` |
| SOCKS 认证 | **不支持**（Chromium 限制）；配置了用户名/密码会直接报配置错误，退出码 2 |
| DNS | HTTP 代理由代理解析目标域名；SOCKS5 默认远程解析（socks5h 语义） |
| CONNECT | HTTPS 目标经 HTTP 代理时使用 CONNECT，代理必须允许 CONNECT 到 443 |
| 日志脱敏 | 日志与 `/status` 只输出 `server` 和 `auth: true/false`，不输出用户名、密码 |
| 进程可见性 | `--proxy-pass` 会出现在进程列表，优先用 `PROXY_PASSWORD` |
| 失败提示 | 代理不可达 → `proxy-unreachable:ERR_PROXY_CONNECTION_FAILED`；认证被拒 → `proxy-auth-rejected`（HTTP 407，立即失败，不空等唤醒页） |

Chrome 仍可能经代理发出少量后台请求（组件更新、GCM 等），不影响保活，但会出现在代理日志里。

### 5.5 Docker

镜像无需改动，部署时加环境变量：

```
PROXY_URL=http://proxy.example.com:8080
PROXY_USERNAME=...
PROXY_PASSWORD=...
PROXY_BYPASS=localhost,127.0.0.1
```

## 6. 目录结构

```
blitz-keepalive/
├── keepalive.mjs                 # 主程序：调度、并发池、单实例锁、重试、日志、健康检查服务
├── config.example.json           # 多账号 / 多应用配置模板
├── .env.example                  # 环境变量模板
├── Dockerfile                    # 可部署到 blitz.cloud 的镜像（内置 Chromium + /healthz）
├── compose.yaml                  # 两个容器互相保活的本地示例
├── deploy/
│   ├── windows/install-task.ps1  # 注册计划任务 / Startup 启动器
│   ├── windows/uninstall-task.ps1
│   ├── linux/blitz-keepalive.service
│   ├── backup.ps1                # Windows 数据备份脚本
│   ├── backup.sh                 # Linux/macOS 数据备份脚本
│   └── backup-crypto.mjs         # AES-256-GCM 备份加解密工具
├── public/                       # 管理网页：原生 HTML / CSS / JavaScript
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── test/fake-blitz.mjs           # 本地模拟 blitz 休眠/唤醒，用于验证
├── test/fake-proxy.mjs           # 本地 HTTP / SOCKS5 代理，用于验证代理链路
├── test/targets-proxy.json       # 代理优先级测试配置
├── test/admin-smoke.mjs          # 登录、目标 CRUD、自动巡检与持久化回归
├── test/hardening.mjs            # 指标、锁、运行态、备份与严格子资源回归
├── .github/workflows/ci.yml      # Node 22/24 语法、测试与依赖审计
├── data/                         # 网页目标、管理密码与目标密码加密密钥（运行时生成）
└── logs/                         # 运行日志与失败现场（运行时生成）
```

运行时依赖只有一个：`puppeteer-core`（不下载浏览器，直接驱动系统已安装的 Chrome/Edge）。管理网页使用原生 HTML / CSS / JavaScript，不需要前端构建步骤或额外依赖。

## 7. 快速开始

### 7.1 安装依赖

```powershell
cd blitz-keepalive
npm install
```

### 7.2 先手动验证一次

单应用：

```powershell
node keepalive.mjs --url=https://你的应用.blitz.cloud --expect="页面上的独有文字" --once
```

多账号：

```powershell
copy config.example.json config.json   # 改成你的目标
node keepalive.mjs --config=config.json --once
```

- 退出码 `0` 且日志 `"ok":true` → 成功。
- 退出码 `1` → 至少一个目标失败，日志末尾的 `summary` 会列出 `failed` 数组；`logs/failures/` 下有对应目标的 HTML 与截图。
- 退出码 `2` → 配置错误（JSON 不合法、URL 非法、id 重复、间隔越界等），错误信息会指出具体字段。

### 7.3 启动前端管理网页

设置端口和访问密码即可启动管理控制台：

```powershell
node keepalive.mjs --port=8080 --admin-password="换成足够长的随机密码"
```

打开 `http://127.0.0.1:8080/admin`，登录后可以添加、编辑、删除网页目标，为单个目标配置后台访问密码，并查看下一次执行时间、最近巡检结果和进程日志。目标默认保存在 `data/managed-targets.json`；新增目标约 1 秒后会进行首次巡检。登录后点击“安全设置”可以修改管理密码，修改成功后其他旧会话会立即失效。

网页修改的管理密码以 scrypt 哈希保存到 `data/admin-auth.json`，不会保存明文。该文件存在时优先于 `ADMIN_PASSWORD`，因此重启后仍使用网页中设置的新密码；如需重新以环境变量初始化，请先删除或更换密码文件。目标后台访问密码则使用独立的 AES-256-GCM 密钥文件加密，需与目标数据一起持久化和备份。

> 监听 `PORT` 时必须配置 `ADMIN_PASSWORD`（推荐）或已存在的 `ADMIN_PASSWORD_FILE`。`STATUS_TOKEN` 只读，不能满足管理台启动认证要求。两者都未提供时进程会以配置错误退出，避免管理接口在公网默认开放。

### 7.4 Windows：注册为计划任务（登录后常驻）

单应用：

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\install-task.ps1 `
  -Url https://你的应用.blitz.cloud -Expect "页面上的独有文字"
```

多账号：

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\install-task.ps1 -Config config.json
```

- 会写入 `.env`、注册 `BlitzKeepAlive` 计划任务并立即启动。
- 以 SYSTEM 身份开机启动（无需登录）：追加 `-RunAsSystem`。
- 无管理员权限时用 `-StartupFolder`：在当前用户 Startup 目录放一个隐藏启动器，登录后自动运行。
- 查看状态与日志：

```powershell
Get-ScheduledTask -TaskName BlitzKeepAlive | Get-ScheduledTaskInfo
Get-Content .\logs\keepalive.log -Tail 20
```

- 卸载：`powershell -ExecutionPolicy Bypass -File deploy\windows\uninstall-task.ps1`

### 7.5 Linux：systemd

```bash
sudo apt install -y chromium          # 或安装 google-chrome-stable
sudo useradd -r -s /usr/sbin/nologin blitzkeep
sudo mkdir -p /opt/blitz-keepalive && sudo chown blitzkeep: /opt/blitz-keepalive
# 把本目录内容拷到 /opt/blitz-keepalive，然后
cd /opt/blitz-keepalive && npm install --omit=dev
cp .env.example .env && vi .env        # 填 BLITZ_URL 或 CONFIG_FILE
sudo cp deploy/linux/blitz-keepalive.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now blitz-keepalive
journalctl -u blitz-keepalive -f
```

若 blitz 把无头 Chrome 判成程序请求（日志一直 `not-ready` 或 dashboard 里没有 wake 记录），改用有头模式 + 虚拟显示：

```ini
# .env
HEADLESS=false
# service
ExecStart=/usr/bin/xvfb-run -a /usr/bin/node keepalive.mjs
```

### 7.6 用 cron 代替常驻进程（可选）

```cron
*/20 * * * * cd /opt/blitz-keepalive && /usr/bin/node --env-file=.env keepalive.mjs --once >> logs/cron.log 2>&1
```

`--once` 会立即访问所有目标（不分错峰），适合目标较少的情况；单实例锁会阻止重叠执行。目标多时建议用常驻模式，让调度器自己错峰。

### 7.7 多台机器 / 多个实例

如果想把不同账号分散到不同机器（降低「同一 IP 高频访问」的特征）：

- 每台机器复制一份目录，使用各自的 `config.json`；
- 不同工作目录天然使用不同的 `keepalive.lock`，互不影响；
- 同一台机器想跑两个独立实例时，显式指定 `--lock-file` 和 `--log-dir` 区分。

## 8. Docker 部署：两个账号相互保活

### 8.1 可行性与边界

技术上可行：容器里跑真实 Chromium，访问**对端账号**应用的公网地址；对端在休眠时会被这次浏览器访问唤醒（约 10 秒）。但有三条硬边界：

1. **容器必须监听端口**。blitz.cloud 只有在镜像的端口可连接后才把应用标为 Online（[文档](https://blitz.cloud/docs/deploy-docker-image/)）。本镜像内置了 `GET /healthz`，默认 `EXPOSE 8080`，不依赖浏览器状态，因此启动后立刻可被判定为在线。
2. **相互保活存在死锁窗口**。A 的容器访问 B、B 的容器访问 A，前提是至少一方醒着。如果两个应用**同时**休眠（同时部署、平台重启、双双连续失败超过 30 分钟），两边容器都停止，谁也唤醒不了谁，只能人工打开其中一个。部署完成后请立刻手动访问两个应用一次。
3. **判定方式未公开**。blitz 是否把「来自 blitz 容器 IP 的浏览器访问」算作访客，官方没有说明。首次上线后必须验证：日志出现 `"ok":true`，且 dashboard 的 Activity 里有 wake 记录；如果一直被判定为程序请求，这套拓扑就不成立。

资源现实：镜像约 0.9 GB（本地解压后，实际下载大小以 registry 为准；官方 Playwright 基础镜像 + 完整 Chromium），单次访问峰值内存约 420 MB，空闲时明显更低。免费版每账号 512 MB 预留池，可能偏紧；blitz 有 burst 上限，但没有 SLA 保证。两个账号各跑一个 Chromium 时请留意 OOM 与启动耗时。

### 8.2 构建并推送镜像

镜像必须是 **公开** 的，且为 `linux/amd64`：

```bash
docker buildx build --platform linux/amd64 \
  -t <你的DockerHub用户名>/blitz-keepalive:1.0.0 --push .
```

用固定版本标签（`1.0.0`）而不是 `latest`，避免 blitz 的夜间自动更新在你不知情时换版本。

本仓库的 Dockerfile 使用官方 Playwright 镜像并固定镜像 digest，构建阶段不访问 Alpine `apk` 软件源，因此更适合 blitz 云端构建器。容器默认设置 `CHROME_NO_SANDBOX=true` 以兼容 Docker/gVisor 的沙箱限制；进程仍以非 root 用户 `pwuser` 运行，部署时应保留 `no-new-privileges` 等容器隔离措施。

### 8.3 部署到两个账号

账号 A 的应用（例如 `keeper-a`）：

| 设置 | 值 |
| --- | --- |
| 镜像 | `<user>/blitz-keepalive:1.0.0` |
| 端口 | `8080` |
| `BLITZ_URL` | `https://app-b.bob.blitz.cloud`（**对端**应用） |
| `EXPECT_TEXT` | 对端页面独有文字（强烈建议） |
| `INTERVAL_MIN` / `JITTER_MIN` | `20` / `2`（两边错开，例如一边 18/3） |
| `ADMIN_PASSWORD` | 管理网页登录密码；使用强随机值，并通过 HTTPS 访问 |
| `ADMIN_PASSWORD_FILE` | `/app/data/admin-auth.json`；网页修改后的 scrypt 密码哈希，优先于环境变量 |
| `MANAGED_TARGETS_FILE` | `/app/data/managed-targets.json` |
| `STATUS_TOKEN` | 可选只读 API 令牌；通过请求头使用，不能登录管理台或执行写操作 |

同时把持久化卷挂载到 `/app/data`，否则容器重建后网页中添加的目标和修改后的管理密码都会丢失：

```text
/app/data -> 持久化卷
```

本地 `compose.yaml` 已为两个服务分别挂载 `./data/peer-a` 和 `./data/peer-b`。首次启动应通过 `PEER_A_ADMIN_PASSWORD` / `PEER_B_ADMIN_PASSWORD` 或 blitz 环境变量设置强密码；之后也可复用卷中已存在的 `admin-auth.json`。两者都不存在时容器会因 `PORT requires ADMIN_PASSWORD` 校验而拒绝启动。

账号 B 的应用（`keeper-b`）同样配置，`BLITZ_URL` 指向 A 的应用。

部署完成后访问 `https://keeper-a.alice.blitz.cloud/healthz`，应返回：

```json
{"status":"ok","targetCount":1,"visits":3,"failures":0,"lastVisitAt":"...","lastTarget":"app-b.bob.blitz.cloud","uptimeSec":900}
```

使用 `curl -H "X-Status-Token: <token>" https://keeper-a.alice.blitz.cloud/status` 可以查看每个目标的 `nextDue`、`lastResult`、`consecutiveFailures`，用于确认访问节奏。不要把令牌放进 URL。

### 8.4 加固建议

- **自访问**：把自身 URL 也加进目标列表（用 `CONFIG_FILE` 而不是 `BLITZ_URL`），对端故障时至少自己还能维持自己醒着。
- **外部看门狗**：另一台机器（或上一节的独立 agent）每 30 分钟打开一次任一应用，专门用于打破「双双休眠」。
- **错开节奏**：两边 `INTERVAL_MIN` / `JITTER_MIN` 不同，避免同一时刻互相访问、也降低规律性。
- **部署后手动访问**：部署/更新窗口是两个应用最可能同时休眠的时刻。

### 8.5 更稳的拓扑：后台应用（推荐）

把同一个镜像部署为账号 A 的「Runs in the background」应用（无地址、永不睡眠），让它同时访问 A、B 两个账号的业务应用；账号 B 只放业务应用。这样：

- 没有相互依赖，**不存在死锁**；
- 只用一个容器，资源占用减半；
- 代价是占用免费版唯一的后台 worker 名额，且 2 天无账号活动会被停止（需定期登录/部署/看 dashboard，或升级 Pro）。

### 8.6 本地验证两个容器互相保活

`compose.yaml` 就是两容器互访的骨架；本地可用模拟服务器验证：

```bash
docker network create keepalive-test
docker run -d --name fake-a --network keepalive-test -e BIND=0.0.0.0 \
  -v "$PWD/test:/app/test:ro" node:22-alpine node /app/test/fake-blitz.mjs 8787
docker run -d --name fake-b --network keepalive-test -e BIND=0.0.0.0 \
  -v "$PWD/test:/app/test:ro" node:22-alpine node /app/test/fake-blitz.mjs 8788
docker run -d --name ka-a --network keepalive-test -p 8091:8080 \
  -e BLITZ_URL=http://fake-b:8788/ -e "EXPECT_TEXT=Demo app is online" \
  -e INTERVAL_MIN=1 -e JITTER_MIN=0 -e SETTLE_SEC=1 blitz-keepalive:local
docker run -d --name ka-b --network keepalive-test -p 8092:8080 \
  -e BLITZ_URL=http://fake-a:8787/ -e "EXPECT_TEXT=Demo app is online" \
  -e INTERVAL_MIN=1 -e JITTER_MIN=0 -e SETTLE_SEC=1 blitz-keepalive:local
```

注意：模拟器走的是明文 HTTP，Chrome 对非安全来源不发 `Sec-Fetch-*`，所以模拟器用 `Upgrade-Insecure-Requests` 作为回退判据；真实的 `https://*.blitz.cloud` 一定带 `Sec-Fetch-Mode: navigate`。

## 9. 验证结果（本机实测）

1. **单应用唤醒路径**：模拟服务器初始 sleeping，`--once` 先拿到唤醒页，页面自刷新后命中应用内容 → `ok:true, ms:5963`，退出码 0。
2. **多目标部分失败**：3 个目标（2 个正确、1 个 `expect` 写错），`maxConcurrent=2` → 先并行成功 2 个，再处理第 3 个，`summary` 输出 `{"total":3,"ok":2,"failed":["acct-b-app2"]}`，退出码 1，失败现场按 `acct-b-app2` 命名。
3. **首轮错峰**：2 个目标、间隔 1 分钟 → 第 1 个在启动后约 6 秒访问，第 2 个约 36 秒访问（30 秒偏移），符合 `interval / 目标数`。
4. **单实例锁**：进程被强杀后残留锁文件，下一次启动能识别 PID 已死亡并自动接管；正常退出会清理。
5. **配置健壮性**：带 BOM 的 JSON（Windows 记事本 / PowerShell 5.1 生成）可正常读取；非法配置退出码 2。
6. **程序请求无效**：对模拟服务器发普通 HTTP 请求得到 `503 App is asleep`，与免费版行为一致。
7. **启动器**：`-StartupFolder` 生成的隐藏启动器可成功拉起进程（测试后已清理）。
8. **Docker 镜像**：`docker build` 成功（Alpine + Chromium，1.46 GB）；容器内 Chromium 正常启动，`/healthz` 返回 200，单次访问 `ok:true, ms:5417`。
9. **容器资源**：访问期间峰值约 420 MB，空闲回落；CPU 仅在访问的几秒内升高。
10. **相互保活**：两个 agent 容器分别访问对端模拟应用，间隔 1 分钟运行 150 秒，双方各完成 3 次成功访问（`ms` 约 1.4–5.6 秒），没有失败。
11. **HTTP 代理**：本地 HTTP 代理（`test/fake-proxy.mjs`）验证通过，代理日志确认目标请求为 `GET http://127.0.0.1:8862/`；带 Basic 认证时 `authenticated:true`。HTTPS 目标走 CONNECT，代理日志确认 CONNECT 同样携带认证。
12. **SOCKS5**：本地 SOCKS5 代理验证通过，`ok:true`；配置 SOCKS 用户名/密码时按预期以退出码 2 拒绝。
13. **认证失败**：错误密码返回 HTTP 407，日志为 `proxy-auth-rejected`，约 0.8 秒失败（不空等 45 秒唤醒页）。
14. **代理不可达**：日志为 `proxy-unreachable:ERR_PROXY_CONNECTION_FAILED`，带 `proxyError:true`。
15. **目标级代理优先级**：显式代理 → 成功；`proxy: ""` → 直连成功；未配置 → 继承全局（故意设为不可达）→ 按预期失败。
16. **脱敏**：日志中未出现代理用户名、密码或 `user:pass@` 形式。
17. **NO_PROXY**：环境变量 `NO_PROXY=127.0.0.1,localhost,::1` 被自动转换为 bypass 列表并生效。

未验证项：真实 blitz.cloud 应用（需要你的地址）；Linux/systemd 路径（当前环境为 Windows）；容器在 blitz 的 gVisor 沙箱中的实际内存与启动耗时；「容器访问是否被算作访客」这一关键判定；`https://`（TLS）代理与需要认证的 SOCKS5（Chromium 本身不支持后者）。

## 10. 日志与监控

每行一条 JSON，`target` / `account` 用于区分账号与应用：

```json
{"ts":"2026-10-17T12:50:47.598Z","level":"info","event":"visit","target":"acct-b-app1","account":"acct-b","cycle":1,"attempt":1,"ok":true,"reason":"ready","status":200,"title":"Demo app","ms":6093}
```

- `reason`：`ready` / `not-ready:<pattern>` / `expect-text-missing` / `empty-page` / 网络错误信息。
- `event`：`start` / `visit` / `scheduled` / `summary` / `shutdown`。
- 日志超过 5 MB 自动轮转为 `keepalive.log.1`。
- 建议每天扫一次 `"ok":false`，按 `target` 聚合；连续失败通常意味着页面文案变了、目标被暂停，或 Chrome 升级出问题。

### 10.1 管理网页

设置 `PORT` 启动 HTTP 服务后，在浏览器打开：

```text
http://127.0.0.1:8080/admin
```

直接访问 `http://127.0.0.1:8080/` 时，如果请求头包含 `Accept: text/html`，也会返回管理网页；脚本/健康检查请求仍会得到 JSON。

管理网页支持：

- 查看进程总体状态、目标总数、暂停数、最近成功数、连续失败数、认证失败数、累计访问、运行时间、Node.js RSS 内存、活跃浏览器和排队任务。
- 按 ID、账号或 URL 搜索目标，并按全部、正常、失败、暂停、等待筛选。
- 查看每个目标的下次执行时间、最近结果、期望文本、登录成功选择器、代理和失败次数。
- 为网页管理目标设置、替换或清除后台访问密码；页面只显示“已配置/未配置”，不会回显密码。
- 暂停或恢复单个目标。暂停原因、截止时间和下一次执行时间会写入 `runtime-state.json`，重启后继续保持；连续 3 次认证失败会自动暂停 30 分钟。
- 导入、导出网页管理目标。导入为完整替换，最多 100 个目标、请求体最大 128 KB；拒绝密码等敏感字段，同 ID 导入会保留原密码密文。
- 查看最近 40 条进程事件和访问结果。
- 对全部目标或单个目标触发一次立即巡检；请求会进入内存队列，不会修改配置文件。
- 每 10 秒自动刷新，也可手动刷新。

登录流程：

1. 使用 `ADMIN_PASSWORD` 配置初始访问密码，或通过 `ADMIN_PASSWORD_FILE` 指定已有的 scrypt 密码文件。
2. 在 `/admin` 输入密码；服务端签发绝对有效期 12 小时、默认空闲超时 60 分钟的 HttpOnly、SameSite=Strict 会话 Cookie，HTTPS 下自动加 Secure。
3. 登录后可在“安全设置”中验证当前密码并设置新密码；新密码至少 10 个字符，成功后其他旧会话全部失效。
4. 连续 5 次密码错误会锁定该客户端 5 分钟；退出登录会立即销毁当前服务端会话。

`ADMIN_PASSWORD` 或持久化密码文件是管理网页的唯一登录方式。`STATUS_TOKEN` 是只读 API 令牌，只能通过 `X-Status-Token` 或 `Authorization: Bearer` 请求头读取 `/status`、`/metrics`、`/api/overview`、`/api/logs`、`/api/targets/export` 等只读接口；它不能登录 `/admin`、不能修改密码、不能执行暂停/恢复/导入等写操作。查询参数 `?token=...` 已移除。

监听 `PORT` 时如果没有配置 `ADMIN_PASSWORD` 或已存在的 `ADMIN_PASSWORD_FILE`，进程会拒绝启动；只有 `STATUS_TOKEN` 不足以启动管理台。建议生产环境设置 `REQUIRE_HTTPS=true` 并由可信反向代理终止 TLS。`/healthz` 始终允许明文探针；只有直连地址位于 `TRUST_PROXY_CIDRS` 且 `TRUST_PROXY=true` 时，服务才会信任 `X-Forwarded-Proto` 和 `X-Forwarded-For`。

管理 API：

```text
GET    /api/session                 # 会话与认证配置
POST   /api/login                   # 使用管理密码登录
POST   /api/logout                  # 销毁当前会话
PUT    /api/password                # 修改管理密码并轮换当前会话
GET    /api/overview                # 总览、目标、最近日志
GET    /api/logs?limit=50           # 最近日志（1..200）
GET    /status                      # 只读状态（需会话或 STATUS_TOKEN）
GET    /metrics                     # Prometheus 文本指标（需会话或 STATUS_TOKEN）
GET    /api/targets/export          # 导出网页管理目标（不含密码材料）
POST   /api/run                     # 排队巡检全部目标
POST   /api/run?target=<id>         # 排队巡检单个目标
POST   /api/targets                 # 创建网页管理目标
PATCH  /api/targets/<id>            # 修改网页管理目标
DELETE /api/targets/<id>            # 删除网页管理目标
POST   /api/targets/<id>/pause      # 暂停调度
POST   /api/targets/<id>/resume     # 恢复调度
POST   /api/targets/import          # 完整替换网页管理目标
```

目标对象中的 `loginPassword` 用于设置或替换目标后台访问密码；`clearLoginPassword: true` 用于清除。响应和总览只包含 `loginPasswordConfigured`，不包含任何密码材料。

浏览器使用登录 Cookie 调用写接口；脚本可使用 `X-Status-Token: <token>` 或 `Authorization: Bearer <token>` 读取只读接口。令牌不会写入 URL，也不会被管理网页读取。

`/metrics` 使用 Prometheus 文本格式，包含进程存活、目标数、累计访问/失败、活跃浏览器、排队任务、Node.js RSS 和运行时间。未携带会话或 `STATUS_TOKEN` 时返回 `401`；采集器示例：

```text
Authorization: Bearer <STATUS_TOKEN>
```

### 10.2 备份、恢复与发布检查

网页目标、管理密码哈希、目标密码加密密钥和运行态必须一起备份。仓库提供两个不输出密码或密钥内容的脚本；归档默认使用 AES-256-GCM 加密，成功后删除明文归档：

```powershell
$env:BACKUP_PASSPHRASE = '至少 12 个字符的独立备份口令'
pwsh -NoProfile -File .\deploy\backup.ps1 -DataDir .\data -OutputDir .\backups
```

```bash
BACKUP_PASSPHRASE='至少 12 个字符的独立备份口令' ./deploy/backup.sh --data-dir ./data --output-dir ./backups
```

生产环境优先使用口令文件，避免口令进入 shell 历史或进程环境：

```powershell
pwsh -NoProfile -File .\deploy\backup.ps1 -DataDir .\data -OutputDir .\backups -PassphraseFile .\backup-passphrase.txt
```

```bash
./deploy/backup.sh --data-dir ./data --output-dir ./backups --passphrase-file ./backup-passphrase.txt
```

仅在另一个可信加密层会立即接管文件时，才使用 `-AllowPlaintext` / `--allow-plaintext` 保留明文归档。

备份包含：

- `managed-targets.json`：网页目标及加密后的目标密码。
- `target-secrets.key`：目标密码解密密钥，丢失后已保存密码无法恢复。
- `admin-auth.json`：管理密码的 scrypt 哈希。
- `runtime-state.json`：暂停状态、最近结果和下一次执行时间；文件不存在时仅警告。

加密后的归档仍应视为敏感文件。Windows 脚本会尝试限制 `.enc`（以及显式保留的 ZIP）的 ACL，Linux 脚本使用 `umask 077`、目录 `0700` 和文件 `0600`。备份口令必须与归档分开保存；口令丢失后无法恢复。

恢复步骤：停止服务，解密归档并解压，将四个文件恢复到同一数据目录并保持权限 `0600`，再启动服务：

```powershell
node deploy\backup-crypto.mjs decrypt .\backups\blitz-keepalive-backup-YYYYMMDD-HHMMSS.zip.enc
Expand-Archive -LiteralPath .\backups\blitz-keepalive-backup-YYYYMMDD-HHMMSS.zip -DestinationPath .\data -Force
```

不要把旧密钥与另一批目标文件混用。升级前先运行 `npm test`；CI 会对 Node 22/24 执行语法检查、完整冒烟测试、加固回归和高危依赖审计。

## 11. 风险与注意事项

1. **服务条款**：blitz.cloud 把「保持唤醒」作为 Pro 付费功能，用浏览器模拟访客属于绕过。账号越多、访问越规律，越容易被识别；可能被限流、要求升级或停用。生产环境请购买 Pro。
2. **判定依赖官方实现**：访客识别、唤醒页文案都可能调整。最稳的做法是给每个目标配置 `expect`；文案变化时用 `--not-ready-regex` 补充规则。
3. **无头指纹**：UA 已从 `HeadlessChrome` 改为普通 Chrome，但仍不是 100% 隐身；失败时改用有头模式 + Xvfb。
4. **资源占用**：每个浏览器实例约 150–250 MB，单次约 6 秒；跑在你自己的服务器上，不占 blitz 的 512 MB 内存池。
5. **不是高可用**：服务器宕机、断网期间应用仍会休眠；下一次真实访问会自动唤醒（约 10 秒）。
6. **免费版后台应用**：如果你不需要 HTTP 地址，直接选「Runs in the background」，它永不睡眠（免费版仅 2 天无账号活动后停止，点一次 Start 即可恢复）——这比保活更省事。
7. **OpenCode 内置浏览器**：可以手动打开页面做一次验证，但它没有定时调度能力，不能代替本方案；本方案用独立 Chrome 进程，和 OpenCode 生命周期解耦。
8. **同一 IP 多账号**：技术上完全可行，但同一出口 IP 在固定节奏下访问多个 blitz 账号，特征更明显。风险敏感时把目标拆到不同机器/网络，并加大抖动。
9. **Docker 相互保活的死锁**：两个应用同时休眠时没有容器在运行，谁也唤醒不了谁；必须有外部看门狗或人工介入。后台应用拓扑没有这个问题。
10. **gVisor 沙箱**：blitz 的每个应用跑在 gVisor 中，Chromium 可能更慢、更容易触发内存限制；本机 Docker 测试结果不能等同于 blitz 上的表现。
11. **代理凭据**：优先用 `PROXY_PASSWORD` 等环境变量，`--proxy-pass` 会出现在进程列表；SOCKS 认证不被 Chromium 支持；Chrome 仍会经代理发出少量后台请求（组件更新、GCM），代理侧会看到这些域名。
12. **暂停与运行态**：手动暂停和自动认证失败暂停会写入 `runtime-state.json`，重启后继续保持；需要长期停用时仍建议删除目标或移出配置文件，并定期备份运行态文件。
13. **HTTPS 代理信任**：`REQUIRE_HTTPS=true` 时 `/healthz` 是唯一明文健康探针；只有配置了可信代理 CIDR，服务才接受 `X-Forwarded-Proto: https`，否则反向代理后的请求也会被 426 拒绝。

## 12. 参数速查

命令行参数（也可用同名环境变量，见 `.env.example`）：

```
--config=<file>     多目标 JSON（与 --url 二选一）
--url=              单目标地址
--expect=           页面独有文字（推荐）
--interval-min=20   访问间隔（1..28，且与 jitter 之和不超过 28）
--jitter-min=2      随机抖动上限（0..10）
--max-concurrent=2  并发访问数（1..5）
--once              立即访问所有目标一次
--headless=false    有头模式
--chrome=<path>     指定 Chrome/Edge
--port=8080         启动 HTTP 服务与管理网页（Docker/blitz 部署必需）
--bind-host=127.0.0.1  管理/健康服务监听地址（容器通常用 0.0.0.0）
--admin-password=... 管理网页登录密码（设置 PORT 时必需）
--admin-password-file=data/admin-auth.json  持久化 scrypt 密码文件（优先于 --admin-password）
--managed-targets-file=data/managed-targets.json  网页目标持久化文件
--runtime-state-file=data/runtime-state.json  暂停、最近结果和下次执行时间持久化文件
--target-secret-key=...  目标密码加密密钥（32 字节 base64 或 64 位 hex；优先用环境变量）
--target-secret-key-file=data/target-secrets.key  自动生成/读取的目标密码加密密钥文件
--status-token=...  只读 API 令牌（不能登录管理台或执行写操作）
--require-https=true  强制管理台和 API 使用 HTTPS；/healthz 除外
--trust-proxy=true  信任可信代理的 X-Forwarded-* 请求头
--trust-proxy-cidrs=127.0.0.1/32  可信代理地址段（TRUST_PROXY=true 时必填）
--session-idle-timeout-min=60  管理会话空闲超时（5..720 分钟）
--target-url-allowlist=*.blitz.cloud  目标域名允许列表
--target-url-allow-private=false  是否允许私网/本机目标（默认禁止）
--target-url-strict-subresources=false  是否对所有子资源执行域名允许列表（更严格，可能影响 CDN）
--chrome-no-sandbox=false  仅在已有容器安全边界时启用
--failure-dump-max-files=100  失败现场最大保留数量
--failure-dump-max-age-days=7  失败现场最大保留天数
--proxy=...         代理地址：http(s)://、socks4://、socks5://
--proxy-user=...    代理用户名（优先用环境变量）
--proxy-pass=...    代理密码（会出现在进程列表，优先用环境变量）
--proxy-bypass=...  不走代理的地址，逗号/分号分隔
--log-dir=logs      日志目录
--lock-file=...     单实例锁路径
--timeout-sec=60    导航超时
--wake-wait-sec=45  等待唤醒上限
--settle-sec=6      就绪后停留
--retries=2         单目标重试次数
--retry-delay-sec=60 重试间隔
--not-ready-regex=  追加的「未就绪」正则
--dump-failures=false  关闭失败现场落盘
```

环境变量：`BLITZ_URL`、`CONFIG_FILE`、`EXPECT_TEXT`、`INTERVAL_MIN`、`JITTER_MIN`、`MAX_CONCURRENT`、`HEADLESS`、`CHROME_PATH`、`PORT`、`BIND_HOST`、`ADMIN_PASSWORD`、`ADMIN_PASSWORD_FILE`、`STATUS_TOKEN`、`REQUIRE_HTTPS`、`TRUST_PROXY`、`TRUST_PROXY_CIDRS`、`SESSION_IDLE_TIMEOUT_MIN`、`MANAGED_TARGETS_FILE`、`RUNTIME_STATE_FILE`、`TARGET_SECRET_KEY`、`TARGET_SECRET_KEY_FILE`、`TARGET_URL_ALLOWLIST`、`TARGET_URL_ALLOW_PRIVATE`、`TARGET_URL_STRICT_SUBRESOURCES`、`CHROME_NO_SANDBOX`、`PROXY_URL`、`PROXY_USERNAME`、`PROXY_PASSWORD`、`PROXY_BYPASS`、`NO_PROXY`、`LOG_DIR`、`TIMEOUT_SEC`、`WAKE_WAIT_SEC`、`SETTLE_SEC`、`RETRIES`、`RETRY_DELAY_SEC`、`NOT_READY_REGEX`、`USER_AGENT`、`LOCK_FILE`、`DUMP_FAILURES`、`FAILURE_DUMP_MAX_FILES`、`FAILURE_DUMP_MAX_AGE_DAYS`、`ONCE`。

备份脚本另外读取 `BACKUP_PASSPHRASE` 或 `BACKUP_PASSPHRASE_FILE`；这两个变量不会被保活进程使用。

使用 `.env`：

```bash
node --env-file=.env keepalive.mjs          # 常驻
node --env-file=.env keepalive.mjs --once   # 单次扫描
```
