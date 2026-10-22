# 游泳馆管理系统部署与运维手册（1Panel）

适用版本：v0.5（Node.js 22.13+、内置 `node:sqlite`、无构建前端）。
本文覆盖：全新部署、域名与 HTTPS、首次初始化、微信小程序、短信、备份恢复、版本升级、日常运维与故障排查。

> 文档约定
> - 示例域名统一为 `pool.example.com`，示例目录统一为 `/opt/pool-management-system`，请替换成你自己的值。
> - 1Panel 不同版本的菜单名称可能略有差异（如「运行环境」在部分版本位于「应用商店」下），以页面实际入口为准。
> - 所有命令都在**服务器 1Panel 终端**执行，不是在 Windows 本机执行。

## 目录

1. [部署架构](#一部署架构)
2. [准备清单](#二准备清单)
3. [安装 1Panel](#三安装-1panel)
4. [上传项目代码](#四上传项目代码)
5. [创建 Node.js 运行环境](#五创建-nodejs-运行环境)
6. [环境变量与初始密码](#六环境变量与初始密码)
7. [启动与验证](#七启动与验证)
8. [域名、反向代理与 HTTPS](#八域名反向代理与-https)
9. [首次登录与系统初始化](#九首次登录与系统初始化)
10. [微信小程序配置](#十微信小程序配置)
11. [短信通知配置](#十短信通知配置)
12. [备份与恢复](#十二备份与恢复)
13. [版本升级（保留数据库和密钥）](#十三版本升级保留数据库和密钥)
14. [日常运维](#十四日常运维)
15. [安全加固](#十五安全加固)
16. [常见问题](#十六常见问题)
17. [上线检查清单](#十七上线检查清单)
18. [附录：命令速查](#附录命令速查)

---

## 一、部署架构

```text
浏览器 / 员工微信小程序
        │  HTTPS 443
        ▼
1Panel 网站（OpenResty/Nginx 反向代理）
        │  http://127.0.0.1:3000
        ▼
1Panel「Node.js 运行环境」容器
  node server.js  →  内置 http 服务 + 静态前端
        │
        ▼
SQLite 单文件数据库  /opt/pool-management-system/data/pool.db
（WAL 模式，同目录还有 pool.db-wal / pool.db-shm）
```

关键点：

- 只有一个 Node 进程、一个 SQLite 文件，**不要同时运行两个实例写同一个数据库**。
- `3000` 只给反向代理访问，**不要对公网放行**。
- 数据库、微信/短信密钥、员工账号都在 `data/pool.db` 里：升级只换代码，必须保留 `data/`。
- 前端是 `public/` 下的静态文件，不需要 npm build。

目录结构（部署后）：

```text
/opt/pool-management-system/
├── server.js              # 启动入口
├── package.json
├── src/                   # 后端
├── public/                # Web 前端（index.html / app.js / styles.css）
├── miniprogram/           # 微信小程序源码（不参与服务器运行）
├── scripts/               # verify-settings.cjs 等运维工具
├── test/                  # 回归测试
└── data/                  # 运行时生成，必须持久化
    ├── pool.db
    ├── pool.db-wal
    ├── pool.db-shm
    └── initial-passwords.txt   # 仅首次建库时生成
```

## 二、准备清单

| 项目 | 要求 |
| --- | --- |
| 服务器 | Ubuntu 22.04/24.04，1 核 2G 起步；磁盘按会员量预留 |
| 1Panel | 已安装并可登录，建议最新稳定版 |
| 域名 | 已备案（国内服务器），A 记录指向服务器公网 IP |
| Node.js | **22.13 或更高**（22.5–22.12 的 `node:sqlite` 需要实验开关，不要用） |
| 端口 | 80、443 对公网开放；3000 只在本机/容器网络内 |
| 初始密码 | 四个账号各准备一个至少 8 位的密码（也可让系统随机生成） |
| 可选 | 微信小程序 AppID/AppSecret、腾讯云或阿里云短信配置 |

防火墙建议：

- 放行：`80`、`443`、1Panel 管理端口、`22`（最好限制来源 IP）。
- 不放行：`3000`。
- 云厂商安全组与 1Panel「主机 → 防火墙」两处都要检查。

## 三、安装 1Panel

SSH 登录服务器后执行官方安装脚本：

```bash
curl -sSL https://resource.fit2cloud.com/1panel/package/quick_start.sh -o quick_start.sh
bash quick_start.sh
```

安装完成后：

1. 浏览器打开 1Panel 地址，登录并立即修改管理员密码。
2. 进入「主机 → 防火墙」，放行 `80`、`443`。
3. 进入「应用商店」，安装 **OpenResty**（或 Nginx）。
4. 不需要在宿主机安装 Node.js，也不需要 PM2；Node 由「运行环境」提供。

## 四、上传项目代码

目标目录固定为：

```text
/opt/pool-management-system
```

### 方式 A：1Panel 文件管理上传 ZIP（推荐首次部署）

1. 打开「主机 → 文件」，进入 `/opt`。
2. 上传项目 ZIP 并解压，确认解压后目录名是 `pool-management-system`。
3. 进入目录确认能看到 `server.js`、`package.json`、`src/`、`public/`。

### 方式 B：服务器终端 Git 拉取

```bash
cd /opt
git clone <你的仓库地址> pool-management-system
```

如果服务器上已有旧版本，见[第十三节](#十三版本升级保留数据库和密钥)，不要直接删目录重来。

### 不要上传或不要删除的内容

- 不要上传本机的 `node_modules/`（服务器上重新安装）。
- 不要上传本机的 `data/`（会覆盖线上数据库）。
- 服务器上的 `data/` 是正式数据，升级时也不能删。

上传完成后设置目录权限（容器需要能写 `data/`）：

```bash
cd /opt/pool-management-system
mkdir -p data
chmod 700 data
```

## 五、创建 Node.js 运行环境

进入 1Panel：

```text
应用商店 / 网站 → 运行环境 → Node.js → 创建运行环境
```

按下表填写（字段名以你的 1Panel 版本为准）：

| 字段 | 填写值 |
| --- | --- |
| 名称 | `pool-management-system` |
| 应用 | Node.js |
| Node 版本 | **22.13+**（推荐 22 LTS 最新版） |
| 源码目录 | `/opt/pool-management-system` |
| 启动命令 | `npm start` |
| 应用端口 | `3000` |
| 外部映射端口 | `3000` |
| 包管理器 | npm |
| 容器名称 | `pool-management-system` |
| 镜像源 | 默认即可 |

说明：

- 如果启动命令下拉框没有 `npm start`，选择「自定义启动命令」填 `node server.js`。
- `应用端口` 是容器内 Node 监听的端口；`外部映射端口` 是宿主机访问容器的端口，反向代理用 `127.0.0.1:3000`。
- 如果页面有「端口外部访问」开关，可以打开以便 1Panel 反代访问；但云防火墙仍然不要放行 3000。
- 源码目录应挂载进容器（1Panel 默认会挂载）。如果代码被打包进镜像内部，改服务器目录不会生效，必须按原方式重建镜像。

### 安装依赖（必做）

在运行环境的「终端」里进入 `/opt/pool-management-system` 执行：

```bash
npm ci --omit=dev
```

确认 `node_modules/exceljs` 存在后再启动。升级代码后也要重新执行一次。

## 六、环境变量与初始密码

1Panel 运行环境如果有「环境变量」入口，建议添加：

| 变量 | 值 | 说明 |
| --- | --- | --- |
| `NODE_ENV` | `production` | 可选 |
| `HOST` | `0.0.0.0` | **必须**，否则容器外访问不到 |
| `PORT` | `3000` | 与运行环境端口一致 |
| `TZ` | `Asia/Shanghai` | **强烈建议**，否则跨日统计偏移 8 小时 |
| `TRUST_PROXY` | `1` | 经 1Panel/OpenResty 反代时设置，见第八节 |
| `PMS_INITIAL_ADMIN_PASSWORD` | 你的超管密码 | 仅首次建库生效 |
| `PMS_INITIAL_BOSS_PASSWORD` | 你的老板密码 | 仅首次建库生效 |
| `PMS_INITIAL_FRONTDESK_PASSWORD` | 你的前台密码 | 仅首次建库生效 |
| `PMS_INITIAL_FINANCE_PASSWORD` | 你的财务密码 | 仅首次建库生效 |
| `PMS_DB_PATH` | 可选，自定义数据库路径 | 默认 `data/pool.db`，一般不需要 |

如果页面没有环境变量区域，项目内置默认值 `HOST=0.0.0.0`、`PORT=3000`，仍可启动；但 `TZ` 和 `TRUST_PROXY` 建议通过 1Panel 的容器配置补上。

初始密码规则：

- 四个密码每个至少 8 位，建议互不相同、随机生成。
- **只在数据库第一次创建员工账号时生效**；已有数据库再改环境变量不会改密码。
- 不填密码时，系统生成随机初始密码并写入 `data/initial-passwords.txt`（权限 600）。
- 登录后立即到「员工权限」修改四个账号密码，然后删除该文件：

```bash
cd /opt/pool-management-system
rm -f data/initial-passwords.txt
```

- 初始化演示会员只在显式设置 `PMS_SEED_DEMO=1` 时写入；生产环境不要设置。
- 不要把 `initial-passwords.txt` 或含密码的启动日志发到聊天工具、工单或截图里。

## 七、启动与验证

保存运行环境，等待状态变为「运行中」，然后：

```bash
# 宿主机本机探测（应返回登录页 HTML）
curl -I http://127.0.0.1:3000

# 查看容器日志
docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
docker logs --tail 100 pool-management-system
```

正常日志应包含：

```text
服务已启动：http://localhost:3000
数据库文件：/opt/pool-management-system/data/pool.db
```

常见启动失败：

| 现象 | 原因与处理 |
| --- | --- |
| `当前 Node.js 不支持 node:sqlite` | Node 低于 22.13；重建运行环境选 22.13+ |
| `EADDRINUSE` | 3000 被占用；换端口或停掉占用进程 |
| 启动即退出、提示旧版数据库 | 检测到未迁移旧库；先备份并按升级流程处理，不要删库 |
| 页面 502 | 容器没运行、端口不对或反代地址不是 `127.0.0.1:3000` |
| 页面能开但登录 500 | 看容器日志中的 `[请求]`/`[事务]` 堆栈；多为数据库不可写 |

## 八、域名、反向代理与 HTTPS

### 8.1 DNS

在域名服务商添加 A 记录：

```text
主机记录：pool
记录值：服务器公网 IP
```

等待解析生效：

```bash
ping -c 2 pool.example.com
```

### 8.2 创建反向代理

1Panel：

```text
网站 → 网站 → 创建网站 → 反向代理
```

填写：

- 主域名：`pool.example.com`
- 代理地址：`http://127.0.0.1:3000`
- 开启 HTTPS，申请 Let's Encrypt 证书
- 开启 HTTP 自动跳转 HTTPS

### 8.3 反向代理必改参数

在网站「配置」/「自定义配置」中加入：

```nginx
client_max_body_size 6m;
proxy_read_timeout 300s;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Real-IP $remote_addr;
```

原因：

- 会员导入允许 3MB 文件，base64 后约 4MB；不改 `client_max_body_size` 会被 1MB 默认值拦成 413。
- 5000 行导入可能超过 60 秒；不改 `proxy_read_timeout` 会 504。
- 不转发 `X-Forwarded-For`，所有请求在系统里都是代理 IP，登录失败次数会按“代理 IP + 账号”累计，可能把账号对所有人锁定；操作日志的来源 IP 也会全部相同。

同时在运行环境设置：

```text
TRUST_PROXY=1
```

未设置时，系统只在直连方是内网/回环地址时自动信任代理头，公网直连不信任，避免伪造请求头绕过限流。

### 8.4 验证

```bash
curl -I https://pool.example.com
```

应返回 `200` 或 `302`，证书有效。浏览器打开 `https://pool.example.com` 能看到登录页。以后员工只使用这个 HTTPS 域名，不要继续用 `IP:3000`。

## 九、首次登录与系统初始化

1. 用超管账号登录（`admin` 或你设置的账号）。
2. 「员工权限」：修改四个账号密码；不需要的账号直接停用。
3. 「系统设置」：
   - 门店名称、月卡起算方式（自然月/购买日起算）、储值默认扣费；
   - 品牌图标/背景图（可选）；
   - 需要微信登录时填写小程序 AppID/AppSecret；
   - 备案号（可选）。
4. 「卡项管理」：核对次卡/月卡/年卡/储值卡的售价、次数、有效期、入场扣费、冻结/转卡/延期开关。
5. 建一个测试会员，完整走一遍：
   - 开卡 → 收银流水 → 入场核销 → 交班（必须清点现金）→ 退款申请 → 审批 → 日结 → 报表；
   - 确认金额、余额、次数、班次现金和报表一致。
6. 确认无误后作废测试卡/会员，或重开日结后清理测试数据。

数据库位置：

```text
/opt/pool-management-system/data/pool.db
```

不要手工改数据库，不要只复制 `pool.db` 而漏掉 `-wal`/`-shm`。

## 十、微信小程序配置

### 10.1 改 AppID

用微信开发者工具打开 `miniprogram/`，把 `project.config.json` 的 `appid` 改成你自己的小程序 AppID。仓库里的 `wxf02dde2b0ec496c6` 是示例 AppID，不改会预览/上传失败或发到错误的小程序。

### 10.2 改后端地址

`miniprogram/config.js`：

```js
module.exports = {
  BASE_URL: 'https://pool.example.com'
};
```

必须满足：

- HTTPS、已备案域名；
- 不能带端口、不能带路径；
- 不能是 `127.0.0.1` 或服务器 IP。

### 10.3 配置合法域名

微信公众平台 →「开发管理 → 开发设置 → 服务器域名」：

```text
request 合法域名：https://pool.example.com
downloadFile 合法域名：https://pool.example.com
```

登录页验证码图片是从后端 `/api/auth/captcha-image` 加载的网络图片；部分基础库把 `<image>` 的网络请求按 downloadFile 域名校验。若真机验证码不显示，先检查这一项。

### 10.4 发布

1. 微信开发者工具中预览、真机调试（可临时勾选“不校验合法域名”，正式版必须配置）。
2. 上传 → 微信公众平台提交审核 → 发布。
3. 后端更新不会自动更新小程序，前后端要分别发布。
4. 小程序版本更新后，员工需重新打开小程序；旧版本可能仍显示旧文案。

## 十一、短信通知配置

只有超管能进入「短信通知」页面。支持腾讯云和阿里云，两套配置独立保存。

腾讯云：开通短信 → 创建应用记录 SdkAppId → 申请签名 → 创建账户变动模板 → 模板变量依次为“会员姓名、业务类型、变动说明” → 创建最小权限 SecretId/SecretKey → 后台填写并测试。

阿里云：开通短信 → 申请签名 → 创建模板（变量 `name/type/detail`）→ 创建 RAM 用户 AccessKey → 后台填写并测试。

详细步骤见：

- [腾讯云短信配置指南](腾讯云短信配置指南.md)
- [阿里云短信配置指南](阿里云短信配置指南.md)

注意：

- 短信发送失败**不会回滚**收银、退款、核销主交易，只记录日志；排查时看容器日志和云厂商控制台。
- 开启短信后，开卡、续费、充值、退款会发送通知；**入场核销同一会员每天只发首条**，避免高峰期费用失控。
- 短信密钥不会回显到前端；输入框留空表示“不修改”，不要为了验证而点清空。

## 十二、备份与恢复

### 12.1 为什么不能只复制 pool.db

SQLite 使用 WAL 模式，最近的写入可能还在 `pool.db-wal` 里。只复制 `pool.db` 会丢数据。正确做法：

- **停容器后**复制整个 `data/` 目录（含 `-wal`、`-shm`）；或
- 用 `sqlite3 .backup` / `VACUUM INTO` 生成一致性快照。

### 12.2 安装 sqlite3（一次性）

```bash
apt-get update && apt-get install -y sqlite3
sqlite3 --version
```

### 12.3 在线备份（推荐）

```bash
BACKUP_DIR=/opt/pool-backups
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

STAMP=$(date +%Y%m%d_%H%M%S)
sqlite3 /opt/pool-management-system/data/pool.db \
  ".backup '$BACKUP_DIR/pool_$STAMP.db'"

chmod 600 "$BACKUP_DIR/pool_$STAMP.db"
sqlite3 "$BACKUP_DIR/pool_$STAMP.db" 'PRAGMA integrity_check;'
```

最后一条应输出 `ok`。

### 12.4 1Panel 计划任务自动备份

1Panel →「计划任务」→「创建计划任务」→ 类型选「Shell 脚本」，执行周期每天一次（例如 `0 2 * * *`），脚本：

```bash
#!/bin/bash
set -e
BACKUP_DIR=/opt/pool-backups
DB=/opt/pool-management-system/data/pool.db
mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d_%H%M%S)
sqlite3 "$DB" ".backup '$BACKUP_DIR/pool_$STAMP.db'"
sqlite3 "$BACKUP_DIR/pool_$STAMP.db" 'PRAGMA integrity_check;' | grep -q ok
chmod 600 "$BACKUP_DIR/pool_$STAMP.db"
# 只保留最近 30 份
ls -1t "$BACKUP_DIR"/pool_*.db | tail -n +31 | xargs -r rm -f
```

建议：

- 备份目录 `700`、备份文件 `600`；
- 每周至少同步一份到异地对象存储；
- 每季度做一次恢复演练；
- 备份包含密钥和会员信息，不要上传 GitHub、不要放网页目录、不要发聊天工具。

### 12.5 恢复

1. 1Panel 停止 Node.js 运行环境（必须停写）。
2. 再备份一次当前 `data/`（哪怕它有问题）。
3. 用备份文件替换 `data/pool.db`，并**删除**旧的 `pool.db-wal`、`pool.db-shm`：

```bash
cd /opt/pool-management-system/data
rm -f pool.db-wal pool.db-shm
cp /opt/pool-backups/pool_YYYYMMDD_HHMMSS.db pool.db
chmod 600 pool.db
```

4. 启动运行环境，看日志。
5. 登录抽查会员、订单、报表；必要时执行 `PRAGMA integrity_check`。

## 十三、版本升级（保留数据库和密钥）

**原则：只换代码，不换数据库；先备份，再动手；不要 `git clean`，不要删 `data/`。**

### 13.1 升级前记录

```bash
APP_DIR=/opt/pool-management-system
docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
```

找到项目容器名（示例 `pool-management-system`），记录挂载和数据库路径：

```bash
APP_CONTAINER=pool-management-system
docker inspect --format '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}' "$APP_CONTAINER"
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$APP_CONTAINER" | grep -E '^(PMS_DB_PATH|TZ|TRUST_PROXY|HOST|PORT)='
```

没有 `PMS_DB_PATH` 且没有独立数据库挂载时，使用默认：

```bash
DB_HOST_DIR=/opt/pool-management-system/data
DB_FILE=pool.db
test -f "$DB_HOST_DIR/$DB_FILE" && echo '已找到原数据库'
```

**没有显示“已找到原数据库”时停止，不要启动程序生成新空库。**

### 13.2 停止业务

在 1Panel 停止运行环境（或 `docker stop "$APP_CONTAINER"`）。通知员工暂停收银、核销、退款审批。

### 13.3 完整备份

```bash
BACKUP_ROOT=/opt/pool-backups/upgrade-$(date +%Y%m%d-%H%M%S)
mkdir -p "$BACKUP_ROOT"
chmod 700 /opt/pool-backups "$BACKUP_ROOT"

# 源码（不含 node_modules 和 data）
tar -czf "$BACKUP_ROOT/source.tar.gz" \
  --exclude='node_modules' --exclude='data' \
  -C /opt pool-management-system

# 完整数据库目录（含 -wal/-shm）
cp -a "$DB_HOST_DIR" "$BACKUP_ROOT/database"

# 额外资源目录（存在才复制）
[ -d "$APP_DIR/public/assets" ] && cp -a "$APP_DIR/public/assets" "$BACKUP_ROOT/public-assets"

echo "备份目录：$BACKUP_ROOT"
```

记录 `BACKUP_ROOT` 完整路径，终端断开后不要把变量当成还在。

### 13.4 替换源码

方式 A：1Panel 文件管理上传新版 ZIP，解压覆盖到 `/opt/pool-management-system`，**保留 `data/`**。

方式 B：Git（需要先把本版本推送到你的仓库）：

```bash
cd "$APP_DIR"
git remote -v
git fetch origin main
git reset --hard origin/main
git log -1 --oneline
git status --short
```

- 不要执行 `git clean`。
- 确认仓库没有跟踪 `data/`：`git ls-tree -r --name-only origin/main -- data` 应无输出。
- 如有自定义 `public/assets/`，从备份补回。

### 13.5 安装依赖并测试

在运行环境终端（Node 22.13+）：

```bash
cd /opt/pool-management-system
npm ci --omit=dev
npm test
```

容器已停止、无法进入时，用临时 Node 容器：

```bash
docker run --rm \
  --mount "type=bind,src=/opt/pool-management-system,dst=/app" \
  --workdir /app \
  node:22-bookworm-slim \
  sh -c 'npm ci --omit=dev && npm test'
```

以 `pass 132 / fail 0`（或当前版本的实际用例数）为准；失败则停止，不启动业务。

### 13.6 启动并核对配置

启动运行环境，确认日志无报错。然后用只读工具对比备份库与当前库的业务配置（不打印密钥值）：

```bash
cd /opt/pool-management-system
node scripts/verify-settings.cjs "$BACKUP_ROOT/database/pool.db" data/pool.db
```

应输出“核对通过”。工具只显示数量和异常配置键，不显示密钥；允许新版增加配置项。

### 13.7 业务验收

- 登录（超管/老板/前台/财务各一次），确认密码未变；
- 会员查询、开卡、续费、充值；
- 核销（含多人、储值卡）；
- 退款申请与审批；
- 交班（必须填写实点现金）、日结、报表；
- 小程序登录/绑定/收银/核销；
- 短信测试（超管）。

### 13.8 回滚

1. 停止运行环境。
2. 把当前目录移到故障备份位置（不要直接删）。
3. 解压 `source.tar.gz`，用 `database/` 覆盖 `data/`，删除 `pool.db-wal`/`-shm`。
4. 启动，确认登录和业务数据回到备份时刻。

升级后产生的新业务不会自动合并到旧库；回滚等于回到备份时刻。

### 13.9 本版本行为变更（升级前必读）

| 变更 | 影响 |
| --- | --- |
| 交班必须填写实点现金 | 旧版小程序不更新会收到 400“请清点现金并填写实点金额” |
| 储值卡有余额不能直接作废 | 需先退款或转卡 |
| 收银“实收金额”改为只读 | 抹零/减免请填“优惠金额” |
| 核销有未确认请求时先重试 | 改输入后不能直接给其他会员核销，避免扣错/重复扣 |
| 新增 `TRUST_PROXY` | 反代部署必须设置并转发 `X-Forwarded-For`，否则限流和日志 IP 不准 |
| 小程序需改 appid 与合法域名 | 首次发布必做 |
| 旧日志清理 | 旧版启动日志可能含明文初始密码，升级后删除并确认密码已改 |

## 十四、日常运维

### 14.1 查看状态与日志

- 1Panel「运行环境」看状态、CPU/内存、重启次数。
- 容器日志：`docker logs --tail 200 -f pool-management-system`。
- 应用只记录启动信息、未捕获异常和审计失败；业务 400 不写错误日志。
- 反向代理日志在 1Panel 网站「日志」里。

### 14.2 时间与时区

```bash
date
docker exec pool-management-system date
```

两处都应是 `CST`/`Asia/Shanghai`。不一致会导致日结、交班、月卡到期偏移。

### 14.3 单实例

同一 `pool.db` 只能有一个 Node 实例写入。不要在 PM2 里开多进程，也不要同时保留两个运行环境指向同一目录。备份工具并发写时，系统已设置 5 秒 `busy_timeout`。

### 14.4 账号与权限

- 离职员工立即在「员工权限」停用，旧会话会失效。
- 老板账号至少保留两个，避免唯一老板忘记密码。
- 超管只用于配置短信/微信等敏感项，日常用老板/前台。
- 定期检查「操作日志」，关注退款、作废、改价、重开日结。

### 14.5 数据量

- 列表分页默认 100 条，最大 1000；Web/小程序自动补页有上限，数据多时用筛选。
- CSV 单次导出上限 5 万行，超出请缩小日期范围。
- 操作日志保留 90 天，服务每 6 小时清理一次过期日志和会话。

## 十五、安全加固

| 项目 | 做法 |
| --- | --- |
| 端口 | 只暴露 80/443；3000 不对公网；1Panel 端口限制来源 IP |
| SSH | 密钥登录，禁用密码（可选），限制来源 |
| HTTPS | 强制跳转，证书自动续期 |
| 初始密码 | 首登改密，删除 `initial-passwords.txt`，删除含旧密码的日志 |
| 备份 | 目录 700、文件 600，异地加密存储 |
| 单实例 | 只运行一个 Node 容器 |
| 代理头 | `TRUST_PROXY=1` + `X-Forwarded-For`，否则限流按代理 IP 计算 |
| 数据库 | 不放在网页目录，不通过静态服务暴露 |
| 日志 | 不记录密码/密钥；旧日志清理 |

补充：登录连续失败 5 次会锁定该 IP+账号 10 分钟。如果所有人共用代理 IP 且没有配置 `TRUST_PROXY`，一个人输错就可能锁住账号；按第八节配置后按真实 IP 计算。

## 十六、常见问题

### 页面打不开 / 502

- 运行环境是否「运行中」；
- 启动命令是否为 `npm start` / `node server.js`；
- `HOST=0.0.0.0`、端口 3000；
- 反代地址是否为 `http://127.0.0.1:3000`；
- 容器日志是否有 `node:sqlite`、端口占用、数据库不可写。

### 提示 node:sqlite 不存在

Node 低于 22.13。删除运行环境重建，选择 22.13+；不要用 22.5–22.12。

### 上传会员文件 413 / 5000 行导入 504

按 8.3 增加 `client_max_body_size 6m;` 与 `proxy_read_timeout 300s;`，重启 OpenResty。

### 小程序请求失败 / 验证码不显示

- `BASE_URL` 是否为 HTTPS 域名、无端口无路径；
- request 与 downloadFile 合法域名是否都配置；
- 证书是否有效；
- 真机是否在“开发版/体验版/正式版”对应环境。

### 登录提示“尝试次数过多”

等待 10 分钟；确认是否配置了 `TRUST_PROXY` 与 `X-Forwarded-For`；不要在共享出口下反复试错。

### SQLITE_BUSY

常见于同时跑了两个实例、备份工具长时间持锁、或手工用 sqlite3 写入。停掉多余实例；备份用 `.backup`；单实例运行。

### 备份恢复后数据变少

多半是只复制了 `pool.db`，漏了 `-wal`。恢复时先停容器，替换 `pool.db` 后删除旧 `-wal`/`-shm`。

### 升级后页面样式/文案还是旧的

浏览器缓存：强制刷新（Ctrl+F5）；小程序需重新上传发布，员工重新进入。

### 忘记密码

用另一个超管在「员工权限」重置。没有可用超管时，先备份数据库，不要删库。

## 十七、上线检查清单

**基础**

- [ ] 服务器时间/时区为 `Asia/Shanghai`
- [ ] 项目位于 `/opt/pool-management-system`
- [ ] Node.js 22.13+ 运行环境创建成功
- [ ] `npm ci --omit=dev` 已执行
- [ ] 启动命令 `npm start`，状态「运行中」
- [ ] `HOST=0.0.0.0`、端口 3000
- [ ] `curl -I http://127.0.0.1:3000` 正常

**域名与安全**

- [ ] 域名 A 记录指向服务器
- [ ] 反向代理到 `127.0.0.1:3000`
- [ ] HTTPS 证书有效、HTTP 自动跳转
- [ ] `client_max_body_size 6m`、`proxy_read_timeout 300s`
- [ ] `X-Forwarded-For` / `X-Real-IP` 已转发，`TRUST_PROXY=1`
- [ ] 3000 未对公网开放
- [ ] 1Panel 管理端口已限制来源

**业务**

- [ ] 四个账号密码已修改，`initial-passwords.txt` 已删除
- [ ] 员工/角色/状态核对
- [ ] 卡项价格、次数、有效期、扣费核对
- [ ] 开卡/续费/充值/核销/退款/交班/日结/报表全流程测试
- [ ] 交班已实际清点现金
- [ ] 测试数据已清理

**备份**

- [ ] 已做一次完整备份并 `integrity_check`
- [ ] 1Panel 计划任务每天自动备份
- [ ] 至少一份异地保存
- [ ] 做过一次恢复演练

**小程序/短信（如使用）**

- [ ] `project.config.json` appid 已改
- [ ] `config.js` BASE_URL 已改
- [ ] request + downloadFile 合法域名已配
- [ ] 真机登录/绑定/收银/核销通过
- [ ] 短信签名/模板已审核，测试短信收到

## 附录：命令速查

```bash
# 进入项目
cd /opt/pool-management-system

# 安装依赖
npm ci --omit=dev

# 本地探测
curl -I http://127.0.0.1:3000

# 容器
docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
docker logs --tail 200 -f pool-management-system
docker inspect --format '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}' pool-management-system

# 数据库
sqlite3 data/pool.db 'PRAGMA integrity_check;'
sqlite3 data/pool.db '.tables'
sqlite3 data/pool.db 'SELECT COUNT(*) FROM members;'

# 备份
sqlite3 data/pool.db ".backup '/opt/pool-backups/pool_$(date +%Y%m%d_%H%M%S).db'"

# 配置核对（只读，不打印密钥）
node scripts/verify-settings.cjs /opt/pool-backups/pool_before.db data/pool.db

# 测试
npm test
```

### 不使用 1Panel 的替代方案（仅限明确需要时）

- 宿主机安装 Node.js 22.13+；
- `HOST=127.0.0.1 PORT=3000 pm2 start server.js --name pool`；
- OpenResty/Nginx 反代到 `127.0.0.1:3000`；
- 同样设置 `TZ=Asia/Shanghai`、`TRUST_PROXY=1`，同样保留 `data/`。

不要把 PM2 方案和 1Panel 容器方案混用，否则会出现端口、`HOST` 和数据库写入冲突。
