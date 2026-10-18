# blitz.cloud 保活方案：用服务器上的真实浏览器定时访问

> 目标：让 blitz.cloud **免费版**应用不进入休眠（30 分钟无访客 → 缩容到 0）。
> 默认由 **/admin 管理后台**添加需要保活的目标；也保留 `--url` / `--config` 供本地验证或一次性自动化使用。
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
并发池（maxConcurrent，默认 1）
  └─ worker 1: 启动独立 Chrome → 访问 → 校验 → 关闭
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
  "maxConcurrent": 1,
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
| `maxConcurrent` | 同时访问几个目标；默认 1，Docker 生产配置固定为 1 |

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
| 1–5 | 1 | 约 300–450 MB | < 1 分钟 |
| 6–20 | 1 | 约 400–500 MB | 1–3 分钟 |
| 20–50 | 1 | 约 400–500 MB | 3–6 分钟 |
| 50–100 | 1 | 约 400–500 MB | 6–12 分钟 |

容器默认限制为 2 GB，单 Chromium 的常规峰值通常在 400–500 MB；复杂页面、登录流程或 gVisor 环境应通过 `docker stats` 复核。实际占用受页面复杂度、Chromium 版本和失败重试影响。

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
├── Dockerfile                    # 可部署到 blitz.cloud 的镜像（内置 Chromium + /healthz + /readyz）
├── compose.yaml                  # 单容器本地部署示例
├── compose.server.yaml           # Nginx + 单应用容器的生产服务器部署
├── deploy/
│   ├── server/nginx.conf.example # 宿主机 Nginx 反向代理配置模板
│   ├── server/.env.example       # 生产环境变量模板
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
node keepalive.mjs --port=8090 --admin-password="换成足够长的随机密码"
```

打开 `http://127.0.0.1:8090/admin`，登录后可以添加、编辑、删除网页目标，为单个目标配置后台访问密码，并查看下一次执行时间、最近巡检结果和进程日志。目标默认保存在 `data/managed-targets.json`；新增目标约 1 秒后会进行首次巡检。登录后点击“安全设置”可以修改管理密码，修改成功后其他旧会话会立即失效。

网页修改的管理密码以 scrypt 哈希保存到 `data/admin-auth.json`，不会保存明文。该文件存在时优先于 `ADMIN_PASSWORD`，因此重启后仍使用网页中设置的新密码；如需重新以环境变量初始化，请先删除或更换密码文件。目标后台访问密码则使用独立的 AES-256-GCM 密钥文件加密，需与目标数据一起持久化和备份。

> 监听 `PORT` 时必须配置 `ADMIN_PASSWORD`（推荐）或已存在的 `ADMIN_PASSWORD_FILE`。`STATUS_TOKEN` 只读，不能满足管理台启动认证要求。两者都未提供时进程会以配置错误退出，避免管理接口在公网默认开放。

### 7.4 Windows：注册为计划任务（登录后常驻）

推荐（目标由管理后台添加）：

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\install-task.ps1
```

高级用法（单目标/多目标直接通过命令行启动）：

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\install-task.ps1 `
  -Url https://你的应用.blitz.cloud -Expect "页面上的独有文字"

powershell -ExecutionPolicy Bypass -File deploy\windows\install-task.ps1 -Config config.json
```

- 默认启动管理后台 `http://127.0.0.1:8090/admin`，首次登录后添加目标；可用 `-Port` 修改端口。
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
cp .env.example .env && vi .env        # 设置 PORT=8090、ADMIN_PASSWORD；目标稍后在 /admin 添加
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

## 8. 在自己的服务器上部署（推荐：复用宿主机 Nginx）

### 8.1 生产拓扑与取舍

生产环境只运行一个应用容器，复用服务器上已有的 Nginx：

```text
Internet
   │  80 / 443
   ▼
┌──────────────────────────┐
│ 宿主机 Nginx             │  TLS、证书、反向代理、安全响应头
└────────────┬─────────────┘
             │ http://127.0.0.1:8090
             ▼
┌──────────────────────────┐
│ keepalive 容器           │  Node + Chromium
└──────────────────────────┘
             │
             ├── ./data：目标、密码哈希、加密密钥、运行态
             └── ./logs：运行日志和失败现场
```

- Nginx 继续使用宿主机的 `80/443`，不需要额外启动第二个反向代理容器。
- 应用只把 `8090` 发布到宿主机回环地址 `127.0.0.1`，公网无法绕过 Nginx 直连应用。
- 现有 Nginx 可以继续承载其他站点；为保活后台增加一个独立的 `server_name` 虚拟主机即可。
- 代价是证书申请和续期由 Nginx/Certbot 维护；如果服务器已有证书体系，这通常比再引入一套代理更简单。
- 不要把应用端口写成 `8090:8090`，也不要让其他反向代理占用同一个 `80/443` 端口。

资源建议：

| `MAX_CONCURRENT` | 建议内存 | 说明 |
| --- | ---: | --- |
| `1` | 2 GB | 默认生产配置，只运行一个 Chromium |
| `2` | 4 GB | 仅明确需要提高吞吐时使用 |
| `3` 及以上 | 8 GB+ | 每个 Chromium 实例都会增加内存尖峰 |

应用镜像约 3.76 GB，另需为数据、日志和 Docker 构建缓存预留空间；生产机至少准备 5 GB 可用磁盘，建议 10 GB。空闲时应用通常只占数百 MB，单次访问峰值约 420 MB；Nginx 的内存占用通常远低于 100 MB。Chromium 还会占用共享内存；当前默认配置为 2 GB 内存上限和 `512mb` 共享内存。

### 8.2 前置条件

1. 一台 Linux x86_64 服务器，已安装 Docker Engine 和 Docker Compose v2。
2. 服务器已安装并运行 Nginx `>= 1.25.1`（示例使用 `http2 on;`），且当前配置通过 `sudo nginx -t`。
3. 一个域名，例如 `keepalive.example.com`，A/AAAA 记录指向服务器公网 IP。
4. 防火墙和云安全组放行 `80/tcp`、`443/tcp`；证书续期通常也需要 `80/tcp`。
5. 如果 Nginx 已为其他域名提供服务，不要覆盖原有配置；新增 `server_name` 虚拟主机即可。
6. 不要同时运行其他占用 `80/443` 的反向代理。Nginx 可以与其他站点共存，但同一个 IP 端口只能有一个监听进程。

以下步骤假设 Nginx 直接安装在宿主机。如果 Nginx 本身运行在容器中，应让 Nginx 与应用加入同一个 Docker 网络，把 `proxy_pass` 改为应用服务名，并重新确认代理来源 CIDR。

### 8.3 准备持久化目录和配置

在仓库根目录执行：

```bash
sudo mkdir -p data logs backups
sudo chown -R 1001:1001 data logs
sudo chmod 700 data logs

cp deploy/server/.env.example deploy/server/.env
chmod 600 deploy/server/.env
```

编辑 `deploy/server/.env`，至少修改：

```dotenv
KEEPALIVE_HTTP_PORT=8090
ADMIN_PASSWORD=使用密码管理器生成的长随机密码
```

`KEEPALIVE_HTTP_PORT` 是宿主机回环映射端口；如果修改它，必须同步修改 Nginx 的 `proxy_pass` 地址。`ADMIN_PASSWORD` 只在首次启动且 `data/admin-auth.json` 不存在时用于初始化。登录 `/admin` 后可以在“安全设置”中修改密码；修改后以持久化的 scrypt 哈希文件为准。不要提交 `deploy/server/.env`，也不要把它复制进镜像。

默认生产配置只运行一个 Chromium，并限制为 2 GB 内存和 512 MB 共享内存：

```dotenv
KEEPALIVE_MEM_LIMIT=2g
KEEPALIVE_SHM_SIZE=512mb
MAX_CONCURRENT=1
```

`compose.server.yaml` 会将生产容器的 `MAX_CONCURRENT` 固定为 `1`，避免已有 `.env` 意外恢复为多浏览器并发。需要提高吞吐时，应先根据 `docker stats` 和 `/metrics` 实测结果调整资源上限，再显式修改 Compose 配置。

应用容器固定以 UID/GID `1001:1001` 运行，所以 `data` 和 `logs` 必须可写。若服务器上的 UID/GID 规则不同，请调整 Dockerfile 或挂载目录的所有者，不能简单改成 `chmod 777`。

生产环境保留以下代理设置：

```dotenv
REQUIRE_HTTPS=true
TRUST_PROXY=true
TRUST_PROXY_CIDRS=127.0.0.1/32,172.31.0.1/32
```

`TRUST_PROXY_CIDRS` 必须与 Docker 实际看到的代理来源一致。`compose.server.yaml` 使用固定网关 `172.31.0.1`，同时保留 `127.0.0.1` 以兼容 Docker Desktop/userland-proxy。若修改了 Compose 网络子网，必须同步修改此值。

### 8.4 配置 Nginx

仓库提供了完整示例：`deploy/server/nginx.conf.example`。将其复制到 Nginx 的配置目录，并替换域名和证书路径：

```bash
sudo cp deploy/server/nginx.conf.example /etc/nginx/conf.d/keepalive.conf
sudo editor /etc/nginx/conf.d/keepalive.conf
```

至少修改：

```nginx
server_name keepalive.example.com;

ssl_certificate     /etc/letsencrypt/live/keepalive.example.com/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/keepalive.example.com/privkey.pem;
```

示例配置包含：

- `80` 到 `443` 的跳转；
- TLS 1.2/1.3 和 HSTS；
- 覆盖客户端伪造的 `X-Forwarded-*` 头；
- 将请求转发到 `127.0.0.1:8090`；
- `nosniff`、`X-Frame-Options: DENY` 等安全响应头；
- 对 `/api/login` 做每 IP `10r/m`、`burst=5` 的 Nginx 限流；
- 默认只允许宿主机访问 `/readyz`，避免公开目标 ID 和运行状态。

如果证书还不存在，可以使用 Certbot（以 Debian/Ubuntu 为例）：

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d keepalive.example.com
```

Certbot 可能会修改 Nginx 配置；申请成功后再次检查证书路径和 `nginx -t`。如果已有其他 ACME 客户端或证书，直接使用对应证书路径即可。

每次修改 Nginx 配置后执行：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

#### 可选：用 fail2ban 封禁反复失败来源

Nginx 的 `limit_req` 负责限速，fail2ban 负责在多次 `401/429` 后临时封禁来源 IP。Debian/Ubuntu 可按以下方式安装示例规则：

```bash
sudo apt install fail2ban
sudo install -Dm644 deploy/server/fail2ban/filter.d/blitz-keepalive.conf \
  /etc/fail2ban/filter.d/blitz-keepalive.conf
sudo install -Dm644 deploy/server/fail2ban/jail.local.example \
  /etc/fail2ban/jail.d/blitz-keepalive.local
sudo fail2ban-client -t
sudo systemctl restart fail2ban
sudo fail2ban-client status blitz-keepalive
```

示例规则读取 `/var/log/nginx/blitz-keepalive.access.log`，10 分钟内失败 5 次封禁 1 小时。若修改了 Nginx 的 `access_log` 路径，必须同步修改 jail 配置；启用前先确认日志中确实记录 `POST /api/login` 的 `401/429` 响应。

#### 可选：再增加一层访问控制

应用自身的登录密码不能被替代。需要更强边界时，可选择：

- **Nginx Basic Auth**：`sudo apt install apache2-utils`，创建 `/etc/nginx/.htpasswd`，在 `location = /api/login` 和 `location /` 中加入 `auth_basic "Blitz Keepalive";` 与 `auth_basic_user_file /etc/nginx/.htpasswd;`。这是第二层保护，不要把唯一密码只放在 Basic Auth。
- **Cloudflare Access**：把源站限制为只接受 Cloudflare 回源，使用 Tunnel 或锁定 Cloudflare IP 段，再配置 Access 策略；不要无条件信任公网客户端传来的 `X-Forwarded-*`。
- **IP 白名单**：在防火墙或 Nginx 的 `allow`/`deny` 中只允许固定办公 IP 或 VPN 网段。动态 IP 场景不建议长期使用。

无论采用哪种方案，`/healthz` 和 `/readyz` 只用于探针，不应把它们作为登录页或公开管理入口。

### 8.5 启动

生产环境优先拉取 CI 发布的不可变镜像，不在服务器上构建：

```bash
docker compose --env-file deploy/server/.env -f compose.server.yaml pull keepalive
docker compose --env-file deploy/server/.env -f compose.server.yaml up -d
```

本地开发或首次验证镜像时才可以临时使用：

```bash
docker compose --env-file deploy/server/.env -f compose.server.yaml up -d --build
```

检查状态和日志：

```bash
docker compose --env-file deploy/server/.env -f compose.server.yaml ps
docker compose --env-file deploy/server/.env -f compose.server.yaml logs --tail=100 keepalive
```

本地和公网健康检查：

```bash
curl -fsS http://127.0.0.1:8090/healthz
curl -fsS http://127.0.0.1:8090/readyz
curl -fsS https://keepalive.example.com/healthz
```

`/healthz` 是存活探针，进程能响应就返回 `200`；`/readyz` 是业务就绪探针，只有所有未暂停目标都处于保活窗口内才返回 `200`，否则返回 `503` 并在响应中给出目标 ID 和原因。示例 Nginx 配置默认只允许宿主机访问 `/readyz`，外部监控需要显式放行监控来源。

`/healthz` 应返回类似：

```json
{"status":"ok","targetCount":0,"visits":0,"failures":0,"lastVisitAt":null,"lastTarget":null,"uptimeSec":30}
```

如果 `/readyz` 返回 `503`，先查看管理网页的目标状态、最近日志和 `/metrics`，不要只看容器是否 running。然后打开 `https://keepalive.example.com/admin`，使用管理员密码登录，在后台添加需要保活的地址。目标地址不应再通过环境变量配置。

### 8.6 网络与安全边界

- 只有宿主机 Nginx 发布 `80/443`；应用只监听 `127.0.0.1:8090`。
- Compose 使用固定私有网络 `blitz-keepalive-private`，应用地址为 `172.31.0.2`，网关为 `172.31.0.1`。
- Nginx 覆盖 `X-Real-IP`、`X-Forwarded-For` 和 `X-Forwarded-Proto`；应用只信任 `TRUST_PROXY_CIDRS` 中的来源，避免客户端伪造 HTTPS 和客户端 IP。
- `REQUIRE_HTTPS=true` 已启用；`/healthz` 与 `/readyz` 都在 HTTPS 强制前处理，示例 Nginx 默认只允许本机访问 `/readyz`。
- 应用容器启用了 `no-new-privileges` 和 `cap_drop: ALL`；不要为了“方便调试”关闭这些限制。
- 应用日志使用 Docker `json-file`，限制为 `10 MB × 5`。Nginx 访问日志和错误日志由宿主机 Nginx 配置管理。
- 如果 Nginx 前面还有 CDN，必须先正确配置 Nginx 的 `real_ip` 和可信代理，再把对应地址加入应用的 `TRUST_PROXY_CIDRS`；不要盲目信任整个公网。

检查实际 Docker 网络网关：

```bash
docker network inspect blitz-keepalive-private \
  --format '{{(index .IPAM.Config 0).Gateway}}'
```

如果修改了 `compose.server.yaml` 中的 subnet 或 gateway，必须同时更新 `TRUST_PROXY_CIDRS`，不能只改其中一个。

### 8.7 日常运维、升级与回滚

查看状态、日志和重启：

```bash
docker compose --env-file deploy/server/.env -f compose.server.yaml ps
docker compose --env-file deploy/server/.env -f compose.server.yaml logs -f keepalive
docker compose --env-file deploy/server/.env -f compose.server.yaml restart keepalive
```

CI 在 `main` 分支和 `v*` 标签上发布 `linux/amd64` 镜像。生产环境使用完整的提交 SHA 作为标签，不使用不可回滚的 `latest`：

```dotenv
KEEPALIVE_IMAGE_TAG=替换为 CI 输出的 40 位提交 SHA
```

升级流程：

```bash
# 仅在 compose 文件或部署脚本也有变化时需要
git pull --ff-only

docker compose --env-file deploy/server/.env -f compose.server.yaml pull keepalive
docker compose --env-file deploy/server/.env -f compose.server.yaml up -d
docker compose --env-file deploy/server/.env -f compose.server.yaml ps
curl -fsS http://127.0.0.1:8090/readyz
```

记录当前镜像摘要，便于审计和回滚：

```bash
docker image inspect ghcr.io/wangming884/blitz-keepalive:${KEEPALIVE_IMAGE_TAG} \
  --format '{{index .RepoDigests 0}}'
```

回滚时把 `KEEPALIVE_IMAGE_TAG` 改回上一个已验证的提交 SHA，再执行：

```bash
docker compose --env-file deploy/server/.env -f compose.server.yaml pull keepalive
docker compose --env-file deploy/server/.env -f compose.server.yaml up -d
```

不要用 `docker compose down -v` 做日常升级或回滚，它会删除 Compose 管理的资源。绑定目录中的 `data/` 和 `logs/` 应继续保留。

### 8.8 备份、恢复与恢复演练

网页目标、管理密码哈希、目标密码加密密钥和运行态必须一起备份。应用目录由 UID `1001` 拥有，普通部署用户可能无法读取，因此生产环境用 `sudo bash` 执行脚本，不依赖文件可执行位。

首次部署先创建专用目录和口令文件。备份口令必须与加密归档分开保存，不能放进仓库、`.env` 或应用容器：

```bash
sudo install -d -m 700 /etc/blitz-keepalive /var/backups/blitz-keepalive
sudo install -m 600 /dev/null /etc/blitz-keepalive/backup-passphrase
sudoedit /etc/blitz-keepalive/backup-passphrase
```

从仓库根目录创建加密备份：

```bash
sudo bash ./deploy/backup.sh \
  --data-dir ./data \
  --output-dir /var/backups/blitz-keepalive \
  --passphrase-file /etc/blitz-keepalive/backup-passphrase
```

脚本成功后会删除明文归档，并输出 `.enc` 文件。恢复前先停止应用容器，再把加密归档解密到临时路径：

```bash
docker compose --env-file deploy/server/.env -f compose.server.yaml stop keepalive
sudo node deploy/backup-crypto.mjs decrypt \
  /var/backups/blitz-keepalive/blitz-keepalive-backup-YYYYMMDD-HHMMSS.tar.gz.enc \
  --passphrase-file /etc/blitz-keepalive/backup-passphrase \
  --output /tmp/blitz-keepalive-restore.tar.gz
sudo tar -xzf /tmp/blitz-keepalive-restore.tar.gz -C ./data
sudo rm -f /tmp/blitz-keepalive-restore.tar.gz
sudo chown -R 1001:1001 data
sudo chmod 700 data
docker compose --env-file deploy/server/.env -f compose.server.yaml start keepalive
```

恢复演练只解密并校验最新归档，不会写入线上 `data/`：

```bash
sudo bash ./deploy/server/restore-drill.sh \
  --backup-dir /var/backups/blitz-keepalive \
  --passphrase-file /etc/blitz-keepalive/backup-passphrase
```

建议用 systemd timer 每天自动备份。示例 unit 假设项目位于 `/opt/blitz-keepalive`；如果实际路径不同，必须同时修改 service 中的路径：

```bash
sudo install -m 644 deploy/server/systemd/blitz-keepalive-backup.service /etc/systemd/system/
sudo install -m 644 deploy/server/systemd/blitz-keepalive-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now blitz-keepalive-backup.timer
sudo systemctl start blitz-keepalive-backup.service
```

Nginx 证书由 Certbot 或现有证书体系管理，不在应用数据备份范围内。建议定期执行：

```bash
sudo certbot renew --dry-run
```

### 8.9 部署到 blitz.cloud（可选）

如果只是把本镜像部署到 blitz.cloud，不需要 `compose.server.yaml`，也不需要服务器上的 Nginx。直接使用仓库的 `Dockerfile`，让平台负责构建和 HTTPS：

1. 使用当前提交构建，不要使用旧提交；入口文件必须被复制到 `/app/keepalive.mjs`。
2. 平台启动命令留空，使用 Dockerfile 的 `CMD ["node", "/app/keepalive.mjs"]`。
3. 配置 `ADMIN_PASSWORD`，并挂载 `/app/data` 持久化卷；建议同时持久化 `/app/logs`。否则网页添加的目标、修改后的密码和审计日志会在重建后丢失。
4. 平台端口使用 `8090`，平台存活检查使用 `/healthz`。`/readyz` 用于业务就绪告警；如果平台会把探针公开，不要直接暴露 `/readyz`，应改为受控监控访问。
5. 不需要配置 `BLITZ_URL`；目标地址由管理员在 `/admin` 添加。

如果平台终止 TLS 并转发到容器，只有确认代理来源 CIDR 后，才设置 `REQUIRE_HTTPS=true`、`TRUST_PROXY=true` 和 `TRUST_PROXY_CIDRS`。不确定代理地址时不要盲目信任整个网段，否则客户端可以伪造转发头。

之前的“两个 blitz 账号互相保活”拓扑不再作为推荐部署方式：它存在双方同时休眠的死锁窗口，也容易把部署问题误判为目标地址问题。多账号场景应优先让一个后台实例管理多个目标；如果必须拆成多个实例，每个实例都应有独立的外部唤醒手段。

### 8.10 常见部署故障

| 现象 | 检查项 |
| --- | --- |
| Nginx 配置检查失败 | 执行 `sudo nginx -t`；检查重复的 `server_name`、监听端口和证书路径 |
| 公网访问返回 `502 Bad Gateway` | 应用是否健康：`docker compose ... ps`；本机 `curl http://127.0.0.1:8090/healthz`；查看 `keepalive` 日志 |
| 页面返回 `426 Upgrade Required` | `TRUST_PROXY`、`TRUST_PROXY_CIDRS` 是否与 Docker 实际网关一致；Nginx 是否发送 `X-Forwarded-Proto: https` |
| Nginx 端口被占用 | 检查是否有其他反向代理绑定同一个 `80/443`；停止不用的服务或容器 |
| 证书申请或续期失败 | DNS 是否指向本机；`80/443` 是否被防火墙、云安全组或 CDN 拦截；执行 `certbot renew --dry-run` |
| 容器启动后立即退出 | 查看 `docker compose ... logs keepalive`；首次启动通常是没有设置 `ADMIN_PASSWORD` |
| `Permission denied` 写入 `/app/data` | `data/`、`logs/` 是否属于 UID/GID `1001:1001` |
| 浏览器访问频繁 OOM | 降低 `MAX_CONCURRENT`，并把 `KEEPALIVE_MEM_LIMIT` 调整到与主机内存匹配 |
| `Cannot find module '/app/keepalive.mjs'` | 部署的是旧镜像或覆盖了启动命令；重新构建当前提交并清空启动命令 |

## 9. 验证结果（本机实测）

1. **单应用唤醒路径**：模拟服务器初始 sleeping，`--once` 先拿到唤醒页，页面自刷新后命中应用内容 → `ok:true, ms:5963`，退出码 0。
2. **多目标部分失败**：3 个目标（2 个正确、1 个 `expect` 写错），`maxConcurrent=2` → 先并行成功 2 个，再处理第 3 个，`summary` 输出 `{"total":3,"ok":2,"failed":["acct-b-app2"]}`，退出码 1，失败现场按 `acct-b-app2` 命名。
3. **首轮错峰**：2 个目标、间隔 1 分钟 → 第 1 个在启动后约 6 秒访问，第 2 个约 36 秒访问（30 秒偏移），符合 `interval / 目标数`。
4. **单实例锁**：进程被强杀后残留锁文件，下一次启动能识别 PID 已死亡并自动接管；正常退出会清理。
5. **配置健壮性**：带 BOM 的 JSON（Windows 记事本 / PowerShell 5.1 生成）可正常读取；非法配置退出码 2。
6. **程序请求无效**：对模拟服务器发普通 HTTP 请求得到 `503 App is asleep`，与免费版行为一致。
7. **启动器**：`-StartupFolder` 生成的隐藏启动器可成功拉起进程（测试后已清理）。
8. **Docker 镜像**：`docker build` 成功（Playwright 基础镜像 + Chromium，镜像约 3.76 GB）；容器内 Chromium 正常启动，`/healthz` 返回 200，单次访问 `ok:true, ms:5417`。在生产安全限制下（`cap_drop: ALL`、`no-new-privileges`、4 GB 内存、512 PIDs），受限容器仍能完成模拟站点巡检：`ok:true, ms:3261`、容器 `healthy`、目标文件持久化成功。
9. **容器资源**：访问期间峰值约 420 MB，空闲回落；CPU 仅在访问的几秒内升高。
10. **相互保活**：两个 agent 容器分别访问对端模拟应用，间隔 1 分钟运行 150 秒，双方各完成 3 次成功访问（`ms` 约 1.4–5.6 秒），没有失败。
11. **HTTP 代理**：本地 HTTP 代理（`test/fake-proxy.mjs`）验证通过，代理日志确认目标请求为 `GET http://127.0.0.1:8862/`；带 Basic 认证时 `authenticated:true`。HTTPS 目标走 CONNECT，代理日志确认 CONNECT 同样携带认证。
12. **SOCKS5**：本地 SOCKS5 代理验证通过，`ok:true`；配置 SOCKS 用户名/密码时按预期以退出码 2 拒绝。
13. **认证失败**：错误密码返回 HTTP 407，日志为 `proxy-auth-rejected`，约 0.8 秒失败（不空等 45 秒唤醒页）。
14. **代理不可达**：日志为 `proxy-unreachable:ERR_PROXY_CONNECTION_FAILED`，带 `proxyError:true`。
15. **目标级代理优先级**：显式代理 → 成功；`proxy: ""` → 直连成功；未配置 → 继承全局（故意设为不可达）→ 按预期失败。
16. **脱敏**：日志中未出现代理用户名、密码或 `user:pass@` 形式。
17. **NO_PROXY**：环境变量 `NO_PROXY=127.0.0.1,localhost,::1` 被自动转换为 bypass 列表并生效。
18. **Nginx 生产链路**：临时启动应用与 Nginx 容器，直连 `/admin` 返回 `426`，经 Nginx 的 `/healthz` 和 `/admin` 均返回 `200`，登录响应包含 `Secure` Cookie；配置通过 `nginx -t`。

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
http://127.0.0.1:8090/admin
```

直接访问 `http://127.0.0.1:8090/` 时，如果请求头包含 `Accept: text/html`，也会返回管理网页；脚本/健康检查请求仍会得到 JSON。

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

监听 `PORT` 时如果没有配置 `ADMIN_PASSWORD` 或已存在的 `ADMIN_PASSWORD_FILE`，进程会拒绝启动；只有 `STATUS_TOKEN` 不足以启动管理台。建议生产环境设置 `REQUIRE_HTTPS=true` 并由可信反向代理终止 TLS。`/healthz` 与 `/readyz` 在应用层允许明文探针，示例 Nginx 默认只允许本机访问 `/readyz`；只有直连地址位于 `TRUST_PROXY_CIDRS` 且 `TRUST_PROXY=true` 时，服务才会信任 `X-Forwarded-Proto` 和 `X-Forwarded-For`。

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

`/metrics` 使用 Prometheus 文本格式，包含进程存活、`blitz_keepalive_ready`、目标数、累计访问/失败、活跃浏览器、排队任务、Node.js RSS 和运行时间。目标级指标包括最近成功时间、连续失败数、下次执行时间、暂停状态和调度超时状态；目标级指标带有目标 ID 标签，必须限制 `/metrics` 的访问范围。未携带会话或 `STATUS_TOKEN` 时返回 `401`；采集器示例：

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
BACKUP_PASSPHRASE='至少 12 个字符的独立备份口令' bash ./deploy/backup.sh --data-dir ./data --output-dir ./backups
```

生产环境优先使用口令文件，避免口令进入 shell 历史或进程环境：

```powershell
pwsh -NoProfile -File .\deploy\backup.ps1 -DataDir .\data -OutputDir .\backups -PassphraseFile .\backup-passphrase.txt
```

```bash
bash ./deploy/backup.sh --data-dir ./data --output-dir ./backups --passphrase-file ./backup-passphrase.txt
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

不要把旧密钥与另一批目标文件混用。升级前先运行 `npm test`；CI 会对 Node 22/24 执行语法检查、完整冒烟测试、加固回归和高危依赖审计，并校验生产 Compose 与 Nginx 配置。

## 11. 风险与注意事项

1. **服务条款**：blitz.cloud 把「保持唤醒」作为 Pro 付费功能，用浏览器模拟访客属于绕过。账号越多、访问越规律，越容易被识别；可能被限流、要求升级或停用。生产环境请购买 Pro。
2. **判定依赖官方实现**：访客识别、唤醒页文案都可能调整。最稳的做法是给每个目标配置 `expect`；文案变化时用 `--not-ready-regex` 补充规则。
3. **无头指纹**：UA 已从 `HeadlessChrome` 改为普通 Chrome，但仍不是 100% 隐身；失败时改用有头模式 + Xvfb。
4. **资源占用**：每个浏览器实例约 150–250 MB，单次约 6 秒；跑在你自己的服务器上，不占 blitz 的 512 MB 内存池。
5. **不是高可用**：服务器宕机、断网期间应用仍会休眠；下一次真实访问会自动唤醒（约 10 秒）。
6. **免费版后台应用**：如果你不需要 HTTP 地址，直接选「Runs in the background」，它永不睡眠（免费版仅 2 天无账号活动后停止，点一次 Start 即可恢复）——这比保活更省事。
7. **OpenCode 内置浏览器**：可以手动打开页面做一次验证，但它没有定时调度能力，不能代替本方案；本方案用独立 Chrome 进程，和 OpenCode 生命周期解耦。
8. **同一 IP 多账号**：技术上完全可行，但同一出口 IP 在固定节奏下访问多个 blitz 账号，特征更明显。风险敏感时把目标拆到不同机器/网络，并加大抖动。
9. **多副本调度**：同一个数据目录只应运行一个应用容器；不要为了“高可用”启动多个会同时写入 `managed-targets.json` 的副本。需要横向扩展时，应把调度器拆成独立服务并增加分布式锁。
10. **gVisor 沙箱**：blitz 的每个应用跑在 gVisor 中，Chromium 可能更慢、更容易触发内存限制；本机 Docker 测试结果不能等同于 blitz 上的表现。
11. **代理凭据**：优先用 `PROXY_PASSWORD` 等环境变量，`--proxy-pass` 会出现在进程列表；SOCKS 认证不被 Chromium 支持；Chrome 仍会经代理发出少量后台请求（组件更新、GCM），代理侧会看到这些域名。
12. **暂停与运行态**：手动暂停和自动认证失败暂停会写入 `runtime-state.json`，重启后继续保持；需要长期停用时仍建议删除目标或移出配置文件，并定期备份运行态文件。
13. **HTTPS 代理信任**：`REQUIRE_HTTPS=true` 时 `/healthz` 与 `/readyz` 在应用层允许明文探针，示例 Nginx 默认只允许本机访问 `/readyz`；只有配置了可信代理 CIDR，服务才接受 `X-Forwarded-Proto: https`，否则反向代理后的请求也会被 426 拒绝。

## 12. 参数速查

命令行参数（目标地址只通过 `--url` / `--config` 或 `/admin` 提供；其他参数可使用同名环境变量，见 `.env.example`）：

```
--config=<file>     多目标 JSON（与 --url 二选一）
--url=              单目标地址
--expect=           页面独有文字（推荐）
--interval-min=20   访问间隔（1..28，且与 jitter 之和不超过 28）
--jitter-min=2      随机抖动上限（0..10）
--max-concurrent=1  并发访问数（默认 1；生产 Compose 固定 1）
--once              立即访问所有目标一次
--headless=false    有头模式
--chrome=<path>     指定 Chrome/Edge
--port=8090         启动 HTTP 服务与管理网页（Docker/blitz 部署必需）
--bind-host=127.0.0.1  管理/健康服务监听地址（容器通常用 0.0.0.0）
--admin-password=... 管理网页登录密码（设置 PORT 时必需）
--admin-password-file=data/admin-auth.json  持久化 scrypt 密码文件（优先于 --admin-password）
--managed-targets-file=data/managed-targets.json  网页目标持久化文件
--runtime-state-file=data/runtime-state.json  暂停、最近结果和下次执行时间持久化文件
--target-secret-key=...  目标密码加密密钥（32 字节 base64 或 64 位 hex；优先用环境变量）
--target-secret-key-file=data/target-secrets.key  自动生成/读取的目标密码加密密钥文件
--status-token=...  只读 API 令牌（不能登录管理台或执行写操作）
--require-https=true  强制管理台和 API 使用 HTTPS；/healthz 与 /readyz 除外
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

环境变量：`EXPECT_TEXT`、`INTERVAL_MIN`、`JITTER_MIN`、`MAX_CONCURRENT`、`HEADLESS`、`CHROME_PATH`、`PORT`、`BIND_HOST`、`ADMIN_PASSWORD`、`ADMIN_PASSWORD_FILE`、`STATUS_TOKEN`、`REQUIRE_HTTPS`、`TRUST_PROXY`、`TRUST_PROXY_CIDRS`、`SESSION_IDLE_TIMEOUT_MIN`、`MANAGED_TARGETS_FILE`、`RUNTIME_STATE_FILE`、`TARGET_SECRET_KEY`、`TARGET_SECRET_KEY_FILE`、`TARGET_URL_ALLOWLIST`、`TARGET_URL_ALLOW_PRIVATE`、`TARGET_URL_STRICT_SUBRESOURCES`、`CHROME_NO_SANDBOX`、`PROXY_URL`、`PROXY_USERNAME`、`PROXY_PASSWORD`、`PROXY_BYPASS`、`NO_PROXY`、`LOG_DIR`、`TIMEOUT_SEC`、`WAKE_WAIT_SEC`、`SETTLE_SEC`、`RETRIES`、`RETRY_DELAY_SEC`、`NOT_READY_REGEX`、`USER_AGENT`、`LOCK_FILE`、`DUMP_FAILURES`、`FAILURE_DUMP_MAX_FILES`、`FAILURE_DUMP_MAX_AGE_DAYS`、`ONCE`。

备份脚本另外读取 `BACKUP_PASSPHRASE` 或 `BACKUP_PASSPHRASE_FILE`；这两个变量不会被保活进程使用。

使用 `.env`：

```bash
node --env-file=.env keepalive.mjs          # 常驻
node --env-file=.env keepalive.mjs --once   # 单次扫描
```
