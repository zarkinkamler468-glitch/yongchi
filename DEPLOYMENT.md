# 游泳馆管理系统部署文档

本文适用于 Ubuntu 22.04 LTS 云服务器、1Panel 面板、Node.js 22.5+、PM2 和 OpenResty/Nginx。项目使用 Node.js 内置 HTTP 服务和 SQLite，生产运行不依赖 MySQL，也不需要执行 `npm install`。

## 一、上线前准备

### 1. 服务器建议

| 项目 | 建议 |
| --- | --- |
| 系统 | Ubuntu 22.04 LTS 64 位 |
| CPU | 1 核起步，2 核更稳 |
| 内存 | 2 GB 起步 |
| 磁盘 | 20 GB 起步，按备份保留量增加 |
| 域名 | 已备案域名，例如 `pool.example.com` |
| HTTPS | 必须配置；微信小程序真机和正式版要求 HTTPS |
| Node.js | 22.5.0 或更高版本 |

### 2. 需要提前准备

- 云服务器公网 IP 和域名
- 1Panel 管理员账号
- 微信小程序 AppID、AppSecret（如启用微信登录）
- 腾讯云短信密钥、SdkAppId、签名和模板 ID（如启用短信）
- 四个员工账号的初始密码，建议通过环境变量配置

## 二、安装和加固 1Panel

SSH 登录服务器。建议使用 SSH 密钥登录，并修改面板管理员密码。

官方安装方式（以 1Panel 官方文档当前命令为准）：

```bash
curl -sSL https://resource.fit2cloud.com/1panel/package/quick_start.sh -o quick_start.sh
bash quick_start.sh
```

安装后登录 1Panel：

1. 修改面板管理员密码。
2. 开启面板安全入口或 IP 白名单。
3. 防火墙只放行 `22`、`80`、`443` 和 1Panel 管理端口。
4. 不要对公网放行应用端口 `3000`，应用只监听本机。
5. 在应用商店安装 OpenResty 或 Nginx。

## 三、安装 Node.js 22

推荐在 1Panel 的运行环境中安装 Node.js 22。也可使用 nvm：

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 22
nvm alias default 22
node -v
```

输出必须是 `v22.5.0` 或更高版本。项目使用内置 `node:sqlite`，Node 版本过低会启动失败。

## 四、上传代码

建议目录：

```bash
mkdir -p /opt/pool-management-system
```

可使用 1Panel 文件管理、scp 或 Git 上传：

```bash
cd /opt
git clone https://github.com/zarkinkamler468-glitch/yongchi.git pool-management-system
```

确认包含：

```text
/opt/pool-management-system/server.js
/opt/pool-management-system/package.json
/opt/pool-management-system/src/
/opt/pool-management-system/public/
/opt/pool-management-system/miniprogram/
```

`data/` 是运行时数据库目录。升级代码时必须保留生产环境的 `data/`，不要用测试目录覆盖。

## 五、生产环境变量

默认端口为 3000，数据库位置为：

```text
/opt/pool-management-system/data/pool.db
```

建议配置：

- `NODE_ENV=production`
- `HOST=127.0.0.1`
- `PORT=3000`
- `PMS_INITIAL_ADMIN_PASSWORD`
- `PMS_INITIAL_BOSS_PASSWORD`
- `PMS_INITIAL_FRONTDESK_PASSWORD`
- `PMS_INITIAL_FINANCE_PASSWORD`

初始密码至少 8 位。只有数据库首次创建账号时生效，已有账号不会被自动覆盖。

创建 PM2 配置：

```bash
cd /opt/pool-management-system
touch ecosystem.config.cjs
chmod 600 ecosystem.config.cjs
```

内容示例：

```js
module.exports = {
  apps: [{
    name: 'pool-management-system',
    script: './server.js',
    cwd: '/opt/pool-management-system',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: '3000',
      PMS_INITIAL_ADMIN_PASSWORD: '替换为至少8位随机密码',
      PMS_INITIAL_BOSS_PASSWORD: '替换为至少8位随机密码',
      PMS_INITIAL_FRONTDESK_PASSWORD: '替换为至少8位随机密码',
      PMS_INITIAL_FINANCE_PASSWORD: '替换为至少8位随机密码'
    }
  }]
};
```

不要把包含真实密码的配置文件提交到 Git。

## 六、首次启动和 PM2 守护

前台验证：

```bash
cd /opt/pool-management-system
node server.js
```

看到服务启动后，用浏览器访问 `http://服务器IP:3000`，确认登录页正常，然后按 `Ctrl+C` 停止。

生产启动：

```bash
npm install -g pm2
cd /opt/pool-management-system
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

复制并执行 `pm2 startup` 输出的命令，然后：

```bash
pm2 save
pm2 status
pm2 logs pool-management-system --lines 100
```

首次随机密码会出现在启动日志中。登录后立即在「员工权限」重置。

## 七、1Panel 域名和 HTTPS

### 1. DNS

添加 A 记录：

```text
主机记录：pool
记录值：云服务器公网 IP
```

### 2. 反向代理

1Panel →「网站」→「创建网站」→「反向代理」：

- 域名：`pool.example.com`
- 代理地址：`http://127.0.0.1:3000`
- 申请 Let's Encrypt 证书
- 开启 HTTP 自动跳转 HTTPS

等价配置：

```nginx
server {
    listen 80;
    server_name pool.example.com;
    return 301 https://$host$request_uri;
}
server {
    listen 443 ssl http2;
    server_name pool.example.com;
    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

验证：

```bash
curl -I https://pool.example.com
```

不要对公网暴露 3000 端口。

## 八、首次系统配置

1. 「员工权限」：修改初始密码，停用不用的账号。
2. 「系统设置」：设置门店名称、月卡规则、储值默认扣费、品牌图标和背景图。
3. 微信登录：只由超管填写 AppID 和 AppSecret。
4. 「卡项管理」：核对次卡、月卡、年卡、储值卡价格和权益。
5. 建立测试会员，验证收银、退款、核销和交班。
6. 删除或作废测试业务数据后正式使用。

数据库文件为 `data/pool.db`，不要手工修改。

## 九、微信小程序

修改 `miniprogram/config.js`：

```js
module.exports = {
  BASE_URL: 'https://pool.example.com'
};
```

微信公众平台「开发管理 → 开发设置 → 服务器域名」添加：

```text
request 合法域名：https://pool.example.com
```

正式版必须使用 HTTPS 域名，不能使用 localhost、IP、端口或本机地址。

开发者工具：

1. 导入 `miniprogram/`。
2. 填写正确 AppID。
3. 开发阶段可临时勾选不校验合法域名，真机和正式版不能依赖该选项。
4. 逐项测试登录、会员、收银、核销、交班、流水和退款。
5. 上传、提交审核并发布。

## 十、腾讯云短信

后台「短信通知配置」只有超管可访问。腾讯云侧需要：

1. 开通短信服务并创建短信应用，记录 SdkAppId。
2. 创建并审核短信签名。
3. 创建账户变动短信模板，变量顺序为：会员姓名、业务类型、变动说明。
4. 创建最小权限 SecretId/SecretKey，不使用主账号密钥。
5. 在后台填写并保存配置。
6. 用测试手机号发送测试短信。

短信发送失败不会回滚收银、核销或退款主交易；应通过 PM2 日志和腾讯云控制台排查签名、模板、余额和地域限制。

## 十一、备份和恢复

推荐 SQLite 在线备份：

```bash
mkdir -p /opt/pool-management-system/backup
sqlite3 /opt/pool-management-system/data/pool.db \
  ".backup '/opt/pool-management-system/backup/pool_$(date +%Y%m%d_%H%M%S).db'"
```

建议每天备份、保留 30 份，并至少每周同步一份到异地对象存储：

```bash
chmod 700 /opt/pool-management-system/backup
chmod 600 /opt/pool-management-system/backup/*.db
```

恢复前停止服务：

```bash
pm2 stop pool-management-system
cp /opt/pool-management-system/backup/pool_YYYYMMDD_HHMMSS.db /opt/pool-management-system/data/pool.db
rm -f /opt/pool-management-system/data/pool.db-wal /opt/pool-management-system/data/pool.db-shm
pm2 start pool-management-system
```

恢复前必须确认备份时间，避免覆盖最新业务。

## 十二、升级流程

1. 通知员工暂停收银和核销。
2. 备份 `data/pool.db`。
3. 上传新代码，保留 `data/` 和 PM2 配置。
4. 运行测试：

```bash
cd /opt/pool-management-system
npm test
```

5. 重启：

```bash
pm2 restart pool-management-system --update-env
pm2 logs pool-management-system --lines 100
```

6. 抽查登录、会员、收银流水和报表。

数据库迁移由服务启动时幂等执行，但升级前仍必须备份。

## 十三、常用命令

```bash
pm2 status
pm2 restart pool-management-system
pm2 stop pool-management-system
pm2 logs pool-management-system --lines 200
pm2 monit
curl -I https://pool.example.com
ss -lntp | grep -E ':80|:443|:3000'
df -h
free -h
```

## 十四、故障排查

### 页面打不开

1. `pm2 status` 查看进程。
2. `pm2 logs pool-management-system` 查看错误。
3. `curl http://127.0.0.1:3000` 检查应用。
4. 检查反向代理是否指向 `127.0.0.1:3000`。
5. 检查 DNS、云防火墙和 1Panel 防火墙。

### node:sqlite 不存在

确认 `node -v` 为 22.5+，并确认 PM2 使用的是同一个 Node 环境。

### 小程序请求失败

检查 `config.js`、微信 request 合法域名、HTTPS 证书和 PM2 日志。正式版本不能使用 `127.0.0.1`。

### 登录失败

确认账号 active。连续错误登录会触发同 IP + 账号的临时锁定，等待约 10 分钟后重试。新安装时查看 PM2 日志中的随机初始密码。

### 数据异常

立即暂停收银，保存当前 `data/pool.db` 和 PM2 日志，再从最近备份恢复。不要直接手工修改金额、次数或余额。

## 十五、上线检查清单

- [ ] Ubuntu 22.04、Node.js 22.5+ 已确认
- [ ] 域名已解析，HTTPS 证书有效
- [ ] 3000 端口未对公网开放
- [ ] PM2 已开机自启
- [ ] 初始员工密码已修改
- [ ] 微信 AppID/AppSecret 已配置（如需要）
- [ ] 小程序 request 合法域名已配置
- [ ] 卡项价格和权益已核对
- [ ] 收银、退款、核销、交班、日结、报表已测试
- [ ] 腾讯云短信已测试（如需要）
- [ ] SQLite 自动备份已创建
- [ ] 至少一份备份已异地保存
