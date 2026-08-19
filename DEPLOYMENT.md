# 部署文档（峡谷管理系统 v0.5）

本系统为 **Node.js（零依赖）+ SQLite + 单文件数据库** 的轻量后端，前端静态文件由同一进程托管，部署极其简单。本文以「**Ubuntu 22.04 LTS + 1Panel + PM2**」为主方案，末尾给出宝塔替代方案。

---

## 1. 服务器要求

| 项 | 要求 |
| --- | --- |
| 操作系统 | Ubuntu 22.04 LTS（推荐）/ 24.04 LTS / Debian 12 |
| 内存 | 1GB 起步（2GB 更稳） |
| 磁盘 | 10GB 起步（日志每天量很小，90 天自动清理） |
| 运行时 | **Node.js ≥ 22.5**（使用内置 `node:sqlite`，无需 `npm install`、无需 MySQL） |
| 面板 | 1Panel（推荐）或 宝塔 |

> 说明：项目**零 npm 依赖**，没有 `node_modules`，无需执行 `npm install`。部署 = 上传代码 + 用 PM2 跑 `server.js`。

---

## 2. 安装 1Panel（Ubuntu 22.04）

```bash
# 以 root 执行官方一键脚本（安装过程会提示选端口、创建管理员账号）
curl -sSL https://resource.fit2cloud.com/1panel/package/quick_start.sh -o quick_start.sh && bash quick_start.sh
```

装完会得到面板地址（如 `http://服务器IP:端口`）、用户名密码。登录后在「应用商店」装 **OpenResty/Nginx**（若未默认装）。

### 安装 Node 22

1Panel 面板 →「网站」→「运行环境 / Node.js」创建运行时，或直接：
```bash
# 通过 nvm 或 1Panel 的 Node 管理装 22.x
nvm install 22
node -v   # 确认 >= 22.5
```

---

## 3. 上传代码

```bash
mkdir -p /opt/pool && cd /opt/pool
# 上传项目（排除 data 目录与 .git）。用 1Panel 的「文件」上传或 scp：
# scp -r pool-management-system/* user@服务器:/opt/pool/
```

目录结构：
```
/opt/pool/
├── server.js
├── package.json
├── src/
├── public/
└── miniprogram/   # 小程序源码（不需部署到服务器，仅本地用）
```

---

## 4. 本地先验证

```bash
cd /opt/pool
node server.js
# 看到「服务已启动：http://localhost:3000」即成功
```

浏览器访问 `http://服务器IP:3000`，用 `boss / admin123` 登录验证。**验证完 Ctrl+C 停掉**，改用 PM2 守护。

---

## 5. PM2 进程守护 + 开机自启

```bash
npm i -g pm2
cd /opt/pool
pm2 start server.js --name pool --cwd /opt/pool
pm2 save
pm2 startup      # 按提示复制并执行输出的命令，实现开机自启
```

常用命令：`pm2 status` / `pm2 logs pool` / `pm2 restart pool`。

---

## 6. 反向代理 + HTTPS（1Panel）

1Panel →「网站」→「创建网站」→「反向代理」：
- 域名：填写你的域名（需先解析到服务器 IP）
- 代理地址：`http://127.0.0.1:3000`
- 勾选「开启 HTTPS」→ 一键申请 Let's Encrypt 证书

生成等价 Nginx 配置（供参考）：
```nginx
server {
    listen 80;
    server_name pool.example.com;
    return 301 https://$host$request_uri;
}
server {
    listen 443 ssl;
    server_name pool.example.com;
    ssl_certificate     /path/fullchain.pem;
    ssl_certificate_key /path/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

> 安全要点：**只在防火墙放行 80/443，不要直接暴露 3000 端口**。

---

## 7. 数据库备份

整个数据就是一个文件：`/opt/pool/data/pool.db`（及 `-wal`/`-shm` 临时文件）。

**备份脚本示例**（`backup.sh`）：
```bash
#!/bin/bash
cd /opt/pool
ts=$(date +%Y%m%d_%H%M%S)
sqlite3 data/pool.db ".backup 'backup/pool_$ts.db'" 2>/dev/null || cp data/pool.db backup/pool_$ts.db
# 只保留最近 30 份
ls -t backup/pool_*.db | tail -n +31 | xargs -r rm -f
```

1Panel「计划任务」→ 添加 Shell 脚本定时执行（如每天 03:00）。建议同时把备份同步到对象存储/异地。

---

## 8. 上线安全清单（务必逐项做）

- [ ] **立即修改默认密码**：`boss/admin123`、`frontdesk/front123`、`finance/finance123`。
- [ ] 启用 HTTPS（已在上方）。
- [ ] 登录爆破已内置防护（同 IP+账号连续错 5 次锁定 10 分钟），无需额外配置。
- [ ] 操作日志已最小化，且**每 90 天自动清理**，控制存储占用。
- [ ] 若要启用**员工微信登录**：在「系统设置」填入微信小程序 `AppID / AppSecret`（见下文小程序章节）。
- [ ] 定期备份 `data/pool.db`。
- [ ] 不要用 root 跑服务（1Panel 默认普通用户即可）。

---

## 9. 微信小程序发布

### 9.1 后端配置
1. 在系统「系统设置」填入微信小程序 **AppID 与 AppSecret**（用于 `jscode2session` 换取 openid，实现员工微信登录绑定）。
2. 后端域名必须为 **HTTPS 已备案域名**。

### 9.2 小程序配置
1. 微信开发者工具导入 `miniprogram/` 目录，`project.config.json` 里的 `appid` 换成你的 AppID。
2. 改 `miniprogram/config.js` 的 `BASE_URL` 为 `https://你的域名`。
3. 小程序后台「开发管理 → 开发设置 → 服务器域名」把该域名加入 **request 合法域名**。
4. 上传代码 → 提交审核 → 发布。

### 9.3 员工微信登录流程
- 员工首次：小程序点「微信登录」→ 未绑定时弹出账号密码 → 验证通过后**绑定该员工微信**。
- 之后：点「微信登录」直接免密进入。
- 员工在「我的」可解绑微信。

---

## 10. 宝塔替代方案

1. 安装宝塔：`curl -sSO https://download.bt.cn/install/install_panel.sh && bash install_panel.sh`。
2. 软件商店装「Node.js 版本管理器」（选 22.x）与「Nginx」。
3. 建站 → Node 项目，运行目录 `/opt/pool`，启动文件 `server.js`，用 PM2 管理。
4. 反向代理与 SSL：网站 → 反向代理 → `127.0.0.1:3000` + 申请 SSL。

其余（备份、防火墙、改密码）同 1Panel 方案。

---

## 11. 升级 / 回滚

- **升级**：备份 `data/pool.db` → 上传新代码覆盖（保留 `data/`）→ `pm2 restart pool`。
- **回滚**：还原旧代码 + 还原备份的 `data/pool.db` → `pm2 restart pool`。
- 数据库结构变化时，服务启动会自动执行幂等迁移（`ensureColumn`），一般无需手工操作。

---

## 12. 常见问题

| 问题 | 处理 |
| --- | --- |
| 端口被占用 | `$env:PORT=3001; node server.js` 换端口，或 `pm2 delete` 旧进程 |
| 登录提示「未登录或已过期」 | 令牌 7 天有效，重新登录即可 |
| 微信登录报「未配置 appid/secret」 | 在系统设置填入小程序 AppID/Secret |
| 数据丢失 | 确认 `data/pool.db` 未被覆盖；从备份还原 |
| 小程序真机连不上 | 确认手机与服务器网络互通、域名已 HTTPS、已加 request 合法域名 |
