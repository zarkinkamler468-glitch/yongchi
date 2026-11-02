# 生产部署指南（推荐方案）

> 适用代码：`main` 分支当前版本（Node.js 22.13+、内置 `node:sqlite`、无前端构建步骤）。
>
> **这份文档替代旧的 1Panel「Node.js 运行环境」部署方式。** 旧方式把宿主机路径 `/opt/pool-management-system` 和容器内路径 `/app` 混在一起，依赖也装在容器里，容易出现“宿主机没有 npm”“终端进错容器”“只拷了 `.db` 丢 WAL”等问题。新方案用 Docker Compose 构建固定镜像，宿主机不需要安装 Node/npm，部署和回滚都可重复。

## 一、结论：推荐技术栈

| 项目 | 推荐选择 |
| --- | --- |
| 服务器系统 | **Ubuntu 24.04 LTS x86_64**（22.04 LTS 也可） |
| 服务器规格 | 最低 2 核 2G / 40GB SSD；建议 2 核 4G |
| 容器 | Docker Engine 27+、Docker Compose v2 |
| Node 运行时 | **node:22.17.0-bookworm-slim**（镜像内固定，宿主机不装 Node） |
| 应用 | 本仓库，`node server.js`，端口 3000（仅容器内） |
| 反向代理/HTTPS | **Caddy 2.8**（自动 Let's Encrypt） |
| 数据库 | SQLite，单文件 + WAL，挂载 `./data` |
| 面板 | **1Panel v2 可选**，仅用于 Docker、防火墙、备份；**不要再用 1Panel 的 Node.js 运行环境** |
| 进程数 | **只能 1 个应用实例**（SQLite 单写者） |

### 为什么不推荐继续用 1Panel Node 运行环境

- 1Panel 把源码挂载到容器内的 **`/app`**，不是宿主机的 `/opt/pool-management-system`；旧文档只写了后者，容易在宿主机执行 `npm`。
- 宿主机没有 Node/npm 是正常的，但 `npm ci` 必须在容器内执行；版本、依赖和容器重建之间的关系不直观。
- 代码、依赖和运行环境耦合在面板里，换机器/回滚/审计不如 Compose 清晰。
- 这不是说 1Panel 不能用：**1Panel 继续用来管理 Docker、防火墙、计划备份、监控即可**，只是不要再用它的 Node 运行环境来跑这个项目。

### 两种生产架构，二选一

**架构 A（首选，最简单）**

```text
公网 80/443 -> Caddy（自动 HTTPS） -> app:3000（Docker 内网） -> ./data/pool.db
```

**架构 B（已有 1Panel 网站/OpenResty）**

```text
公网 80/443 -> 1Panel OpenResty -> 127.0.0.1:3000 -> app -> ./data/pool.db
```

> 重要：**80/443 只能有一个主人**。Caddy 和 1Panel OpenResty 不要同时抢端口。二选一，见第十节。

---

## 二、服务器与系统初始化

### 2.1 选择服务器

- 系统：**Ubuntu 24.04 LTS**（腾讯云/阿里云轻量或 CVM 均可）。
- 配置：2 核 2G 起步；会员/流水较多或同时在线多，建议 2 核 4G。
- 磁盘：40GB SSD 起步；数据库很小，但备份和日志需要空间。
- 地域：中国大陆服务器绑定域名需要 **ICP 备案**；没有备案就用香港/海外节点，或先用 IP + 内网测试。
- 安全组/云防火墙只放行：**22（SSH）、80、443、1Panel 面板端口**；**不要放行 3000**。

### 2.2 首次登录与系统加固

用 SSH 密钥登录，不建议长期使用 root 密码。以下命令在服务器执行：

```bash
# 时区
sudo timedatectl set-timezone Asia/Shanghai

# 更新
sudo apt update && sudo apt upgrade -y

# 常用工具
sudo apt install -y curl ca-certificates git ufw fail2ban sqlite3

# 防火墙：只开 SSH、HTTP、HTTPS；1Panel 端口按需替换
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
# sudo ufw allow 41016/tcp   # 1Panel 面板端口，建议只对固定 IP 开放
sudo ufw --force enable
```

SSH 加固（确认密钥能登录后再改）：

```bash
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh
```

> 改 SSH 配置前先另开一个会话验证，避免把自己锁在门外。

### 2.3 安装 Docker 和 Compose

如果服务器已经装了 1Panel，通常已有 Docker，先检查：

```bash
docker --version
docker compose version
```

没有 Docker 时：

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable --now docker
docker compose version
```

不要用 `apt install nodejs npm` 来跑本项目；Node 在镜像里。

### 2.4 1Panel（可选）

1Panel 只作为服务器管理面板使用：

- 安装后立即设置 **安全入口、强密码、2FA**。
- 面板端口只对固定 IP 开放，不要直接暴露给全网。
- 用 1Panel 的 **防火墙、文件、计划任务、容器列表、备份**。
- **不要创建 Node.js 运行环境**；应用用本仓库的 `compose.yaml`。
- 如果 1Panel 的 OpenResty 已经占用 80/443，按第十节选择架构 B，不要同时启动 Caddy。

> 1Panel 的具体安装命令以官方文档为准；不同版本菜单名略有差异。安装 1Panel 时不要再手动装一遍 Docker。

---

## 三、代码目录与权限

```bash
sudo mkdir -p /opt/pool-management-system
sudo chown -R "$USER":"$USER" /opt/pool-management-system
cd /opt/pool-management-system

git clone https://github.com/zarkinkamler468-glitch/yongchi.git .
# 或者：把仓库压缩包解压到此目录

# 固定到要上线的提交/标签，不要直接跑未知分支
git log -1 --oneline
```

目录应该包含：

```text
/opt/pool-management-system
├── Dockerfile
├── compose.yaml
├── deploy/
│   ├── Caddyfile
│   └── .env.example
├── src/
├── public/
├── server.js
├── package.json
└── data/          # 持久化数据，不能提交 Git
```

创建数据目录并设置容器内 `node` 用户（uid 1000）可写：

```bash
sudo install -d -o 1000 -g 1000 /opt/pool-management-system/data
```

如果是从旧部署迁移，先把旧数据拷贝进来，再统一改权限：

```bash
# 旧容器必须已停止，不能两个实例同时写同一个库
sudo cp -a /旧部署/data/pool.db* /opt/pool-management-system/data/
sudo chown -R 1000:1000 /opt/pool-management-system/data
```

> 必须同时保留 `pool.db`、`pool.db-wal`、`pool.db-shm`。只拷 `.db` 会得到空库。

---

## 四、环境变量与密钥

```bash
cd /opt/pool-management-system
cp deploy/.env.example .env
chmod 600 .env
```

编辑 `.env`：

```dotenv
DOMAIN=pool.example.com

PMS_INITIAL_ADMIN_PASSWORD=换成长随机密码
PMS_INITIAL_BOSS_PASSWORD=换成长随机密码
PMS_INITIAL_FRONTDESK_PASSWORD=换成长随机密码
PMS_INITIAL_FINANCE_PASSWORD=换成长随机密码
```

说明：

| 变量 | 作用 |
| --- | --- |
| `DOMAIN` | 你的正式域名，必须已解析到服务器，Caddy 用它申请证书 |
| `PMS_INITIAL_*_PASSWORD` | **仅首次建库生效**；至少 8 位，四个账号不要相同 |
| `TRUST_PROXY` | 已在 `compose.yaml` 固定为 `1`；因为 app 不发布端口，只有 Caddy 能访问 |
| `PMS_DB_PATH` | 已在镜像/Compose 固定为 `/app/data/pool.db` |

`.env` 不要提交 Git，不要发群。数据库里的微信 Secret、短信 AccessKey 也不要写进仓库。

> `PMS_INITIAL_*` 在数据库已存在后不会改密码；首次登录后请在系统里修改密码，并删除可能生成的 `data/initial-passwords.txt`。

---

## 五、构建与启动

```bash
cd /opt/pool-management-system

# 构建镜像（依赖在镜像内安装，宿主机不需要 npm）
docker compose build --pull

# 启动 app + Caddy
docker compose up -d

# 状态
docker compose ps

# 应用日志
docker compose logs -f --tail=100 app

# Caddy 证书/代理日志
docker compose logs -f --tail=100 caddy
```

启动后检查：

```bash
curl -fsS https://你的域名/api/public-config
```

浏览器打开：

```text
https://你的域名
```

Caddy 会自动申请 Let's Encrypt 证书；首次签发需要 80/443 可达、域名解析正确。

### 首次登录要做的事

1. 用 `.env` 里的超管密码登录。
2. 立即修改四个账号密码。
3. 配置门店名称、默认入场费、月卡起算方式。
4. 配置卡项（次卡/月卡/年卡/储值卡）。
5. 需要微信登录时填小程序 AppID/AppSecret；需要短信时填阿里云/腾讯云配置。
6. 上传 Logo/登录背景（可选）。
7. 删除 `data/initial-passwords.txt`（如果存在）。
8. 确认操作日志里记录的是员工真实 IP，而不是代理容器 IP。

---

## 六、验证清单

```bash
# 容器健康
docker compose ps

# 应用健康接口
curl -fsS https://你的域名/api/public-config

# 3000 不应监听在公网
sudo ss -ltnp | grep ':3000' || echo '3000 未公网监听'

# HTTP 应跳转 HTTPS
curl -I http://你的域名

# 数据库文件应存在，且 data 下有 WAL/SHM
ls -lah data/
```

人工检查：

- [ ] HTTPS 证书有效，HTTP 自动跳 HTTPS。
- [ ] 四个初始账号都能登录，密码已改。
- [ ] 会员、会员卡、订单、核销数据与迁移前一致。
- [ ] 新建一笔测试订单、核销、退款，流水和班次正确。
- [ ] 操作日志来源 IP 是真实客户端 IP。
- [ ] 会员卡搜索/分页正常。
- [ ] 小程序能访问 `https://你的域名`（request 合法域名、downloadFile 合法域名）。
- [ ] 服务器重启后容器自动恢复。
- [ ] 备份任务已执行，备份文件可打开。

---

## 七、备份与恢复

SQLite 是单文件 + WAL，**不能只拷 `pool.db`**。

### 7.1 在线备份（推荐，每天）

安装 `sqlite3` 后，使用 SQLite 的在线备份 API：

```bash
cd /opt/pool-management-system
mkdir -p backups

sqlite3 data/pool.db ".backup 'backups/pool-$(date +%F-%H%M).db'"
gzip -9 "backups/pool-$(date +%F-%H%M).db"
```

`.backup` 会生成一致性快照，包含已提交的 WAL 内容。建议每天 03:00 执行，保留 30 天：

```bash
# crontab -e
0 3 * * * cd /opt/pool-management-system && mkdir -p backups && sqlite3 data/pool.db ".backup 'backups/pool-$(date +\%F-\%H\%M).db'" && gzip -9 backups/pool-*.db && find backups -name 'pool-*.db.gz' -mtime +30 -delete
```

### 7.2 冷备份（升级前必做）

```bash
cd /opt/pool-management-system
docker compose stop app
tar czf "backups/data-$(date +%F-%H%M).tar.gz" data
docker compose start app
```

冷备份会短暂停止写入，但最稳妥；升级/迁移前使用。

### 7.3 异地保存

- 用 1Panel 计划任务/rclone/对象存储把 `backups/` 同步到另一台机器或 OSS/COS。
- 备份文件加密，至少保留 7 天日备 + 4 周周备。
- **每季度做一次恢复演练**，不要只看“备份文件存在”。

### 7.4 恢复

```bash
cd /opt/pool-management-system
docker compose stop app

# 先保留现场
mv data "data.before-restore-$(date +%F-%H%M)"

# 解压/复制备份到 data（必须包含 pool.db、pool.db-wal、pool.db-shm 或 .backup 单文件）
mkdir -p data
tar xzf backups/data-YYYY-MM-DD-HHMM.tar.gz
sudo chown -R 1000:1000 data

docker compose start app
docker compose logs --tail=100 app
```

如果是 `.backup` 单文件，放到 `data/pool.db`，并确保没有旧 WAL/SHM 残留。

---

## 八、升级与回滚

### 8.1 升级

```bash
cd /opt/pool-management-system

# 1) 先备份（冷备份或在线备份）
docker compose stop app
tar czf "backups/data-before-upgrade-$(date +%F-%H%M).tar.gz" data
docker compose start app

# 2) 更新代码到指定提交/标签
git fetch --tags
git checkout <要上线的 commit 或 tag>
git log -1 --oneline

# 3) 重新构建并启动
docker compose build --pull
docker compose up -d

# 4) 验证
docker compose ps
docker compose logs --tail=100 app
curl -fsS https://你的域名/api/public-config
```

数据库迁移在启动时自动执行；升级前**必须**有备份。

### 8.2 回滚

```bash
cd /opt/pool-management-system
git checkout <上一个稳定 commit/tag>
docker compose build --pull
docker compose up -d
```

如果数据库已被新版本迁移，回滚代码不一定能回滚数据；优先用升级前备份恢复：

```bash
docker compose stop app
mv data "data.failed-$(date +%F-%H%M)"
tar xzf backups/data-before-upgrade-*.tar.gz
sudo chown -R 1000:1000 data
docker compose start app
```

---

## 九、安全加固

- **SSH**：只用密钥，禁用密码登录；云防火墙只放行可信 IP。
- **面板**：1Panel 使用 HTTPS、安全入口、2FA、强密码；面板端口不要对全网开放。
- **端口**：3000 不对公网开放；只开 22/80/443/面板端口。
- **TLS**：Caddy 自动续期；HSTS 已配置；不要把 HTTP 直接暴露给业务。
- **密钥**：`.env` 权限 600；微信 Secret、短信 AccessKey 只存服务器/系统设置；泄露立即轮换。
- **账号**：四个初始账号密码必须改；离职员工及时停用；不要共用账号。
- **备份**：离线/异地加密保存；备份文件含会员手机号和密钥，按敏感数据管理。
- **单实例**：不要 `docker compose up --scale app=2`；不要同时保留旧 1Panel Node 运行环境写同一个 `data/`。
- **日志**：Docker 日志已限制 10MB × 5；定期检查磁盘。
- **依赖**：定期 `npm audit`/更新镜像；升级前跑测试。
- **审计**：定期看操作日志；管理员账号越少越好。

---

## 十、如果必须使用 1Panel

1Panel 可以继续用，但**不要用它的 Node.js 运行环境**部署本项目。推荐用 1Panel 的「容器/编排」运行本仓库的 `compose.yaml`，或者用 1Panel 的终端执行 `docker compose up -d --build`。

### 10.1 先解决 80/443 冲突

检查谁占用了 80/443：

```bash
sudo ss -ltnp | grep -E ':80|:443'
docker ps --format 'table {{.Names}}\t{{.Ports}}'
```

二选一：

**方案 A：Caddy 负责 HTTPS（推荐新部署）**

- 停用/删除 1Panel 里不用的网站和 OpenResty 占用（确认没有其他业务）。
- 启动本仓库 compose 的 `caddy`，由它绑定 80/443。
- 1Panel 只做容器/防火墙/备份。

**方案 B：继续用 1Panel OpenResty**

- 不要启动 compose 里的 `caddy`（删除或注释该服务）。
- 把 app 端口只发布到本机：

```yaml
    ports:
      - "127.0.0.1:3000:3000"
```

- 在 1Panel 网站里新建反向代理，目标 `http://127.0.0.1:3000`，开启 HTTPS。
- 代理配置至少包含：

```nginx
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_read_timeout 300s;
client_max_body_size 6m;
```

- `TRUST_PROXY` 改为 app 实际看到的代理源 IP。Docker 发布端口时通常是 `172.17.0.1`；如果 1Panel 的 OpenResty 是 host 网络，也可能是 `127.0.0.1`。部署后看操作日志的真实 IP 再调整，不要盲目写 `1`。
- **仍然只能有一个 app 实例写 `data/`。**

### 10.2 从旧的 1Panel Node 运行环境迁移

```bash
# 1) 停止旧运行环境/容器，确保它不再写 data
docker stop pool-management-system

# 2) 备份旧数据
sudo cp -a /opt/pool-management-system/data /opt/pool-data-backup-$(date +%F-%H%M)

# 3) 在新目录部署 compose
cd /opt/pool-management-system
# 确保 data/ 里有 pool.db、pool.db-wal、pool.db-shm
sudo chown -R 1000:1000 data

# 4) 启动新栈
docker compose up -d --build

# 5) 确认旧容器不会自动启动（1Panel 里停用/删除旧运行环境）
docker ps --format 'table {{.Names}}\t{{.Status}}'
```

不要在旧容器和新 compose 之间来回切换写同一个数据库。

---

## 十一、常见故障

| 现象 | 原因/处理 |
| --- | --- |
| `当前 Node.js 不支持 node:sqlite` | Node < 22.13；使用本仓库 Dockerfile 的 22.17 镜像，不要在宿主机装旧 Node |
| `EADDRINUSE` / 3000 被占用 | 旧容器还在跑；`docker ps` 查 `pool-management-system`，停掉旧实例，只保留一个 |
| 502 Bad Gateway | app 不健康；`docker compose logs app`、`docker compose ps`，检查 data 权限 |
| 登录页正常但接口 500 | 看 app 日志；常见是 `data` 目录不可写或数据库损坏 |
| 数据库打开是空库 | 只拷了 `pool.db`，缺 `-wal/-shm`；用完整 `data/` 或 `.backup` 恢复 |
| `SQLITE_BUSY` | 多个实例/备份工具长时间锁；确保单实例，备份用 `.backup` |
| 操作日志 IP 都是代理 IP | `TRUST_PROXY` 配置不对；按实际代理源 IP 调整，或改用 Caddy 方案 |
| Caddy 证书失败 | 域名未解析、80/443 被占用、云防火墙未放行、域名未备案（大陆） |
| 微信小程序请求失败 | 小程序后台 request/downloadFile 合法域名未填 `https://你的域名` |
| 登录提示验证码频繁 | 代理配置导致共用 IP；检查 `TRUST_PROXY`，不要多人共用同一出口 |
| 磁盘满 | 检查 `data/pool.db-wal`、Docker 日志、备份；限制日志并清理旧备份 |

---

## 十二、上线前最终检查

- [ ] Ubuntu 24.04 LTS，系统已更新，时区正确。
- [ ] 云防火墙只开 22/80/443/面板端口，3000 不公网开放。
- [ ] SSH 密钥登录，密码登录关闭。
- [ ] Docker/Compose 正常，`docker compose version` 可用。
- [ ] `.env` 权限 600，四个初始密码为随机强密码。
- [ ] `data/` 属主为 1000:1000，包含完整数据库文件。
- [ ] `docker compose build --pull` 成功。
- [ ] `docker compose up -d` 后 app healthy，Caddy 证书成功。
- [ ] 首次登录、改密码、配置门店/卡项。
- [ ] 测试开卡、核销、收银、退款、班次、日结。
- [ ] 操作日志显示真实客户端 IP。
- [ ] 备份任务已跑通，并做过一次恢复演练。
- [ ] 旧 1Panel Node 运行环境已停止/删除，不会与新实例抢数据库。
- [ ] 微信/短信/支付等外部配置已按实际启用情况验证。

---

## 附：最简命令清单

```bash
# 首次
cd /opt/pool-management-system
cp deploy/.env.example .env
chmod 600 .env
# 编辑 .env 的域名和四个密码
sudo install -d -o 1000 -g 1000 data
docker compose build --pull
docker compose up -d
docker compose ps
docker compose logs -f --tail=100 app

# 日常
docker compose ps
docker compose logs --tail=100 app

# 升级
git fetch --tags
git checkout <tag>
docker compose build --pull
docker compose up -d

# 备份
sqlite3 data/pool.db ".backup 'backups/pool-$(date +%F-%H%M).db'"
```
