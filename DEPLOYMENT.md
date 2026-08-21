# 游泳馆管理系统部署文档（Ubuntu 22.04 + 1Panel 容器方案）

本文只讲一条主流程：使用 1Panel「Node.js 运行环境」创建容器部署。不要同时按照 PM2 宿主机方案操作，否则会出现端口、HOST 和启动方式冲突。

项目特点：

- Node.js 内置 HTTP 服务
- SQLite 单文件数据库
- 无第三方 npm 依赖，不需要执行 `npm install`
- 后台端口默认为 3000
- 生产环境必须通过 HTTPS 域名访问

## 1. 准备工作

准备以下内容：

- Ubuntu 22.04 LTS 云服务器
- 已安装并能登录的 1Panel
- 已解析到服务器 IP 的域名，例如 `pool.example.com`
- 微信小程序 AppID、AppSecret（如需要）
- 腾讯云短信配置（如需要）
- 四个员工账号的初始密码，每个至少 8 位

服务器防火墙放行：

- `80)：HTTP
- `443`：HTTPS
- 1Panel 管理端口
- `22`：SSH（建议限制来源 IP）

不要把 `3000` 对公网开放。1Panel 容器需要映射 3000，但云防火墙和系统防火墙不要放行公网访问。

## 2. 安装 1Panel

SSH 登录服务器，执行官方安装命令：

```bash
curl -sSL https://resource.fit2cloud.com/1panel/package/quick_start.sh -o quick_start.sh
bash quick_start.sh
```

安装完成后登录 1Panel：

1. 修改 1Panel 管理员密码。
2. 在「主机 → 防火墙」放行 80 和 443。
3. 在「应用商店」安装 OpenResty 或 Nginx。
4. 不需要单独安装 Node.js，也不需要单独安装 PM2；Node.js 由 1Panel 运行环境提供。

## 3. 上传项目代码

### 方式 A：使用 1Panel 文件管理

1. 打开「主机 → 文件」。
2. 进入 `/opt`。
3. 上传项目 ZIP。
4. 解压为：

```text
/opt/pool-management-system
```

### 方式 B：使用 1Panel 终端从 GitHub 下载

```bash
cd /opt
git clone https://github.com/zarkinkamler468-glitch/yongchi.git pool-management-system
```

确认源码目录正确：

```bash
ls /opt/pool-management-system
```

应该能看到：

```text
server.js
package.json
src
public
miniprogram
```

注意：以后升级代码时保留：

```text
/opt/pool-management-system/data
```

这个目录中的 `pool.db` 是正式业务数据库。

## 4. 在 1Panel 创建 Node.js 运行环境

进入：

```网站 → 运行环境 → Node.js → 创建运行环境
```

按下面填写：

| 页面字段 | 填写值 |
| --- | --- |
| 名称 | `pool-management-system` |
| 应用 | Node.js |
| Node 版本 | 22.x（推荐 LTS；22.5+ 均可） |
| 源码目录 | `/opt/pool-management-system` |
| 启动命令 | `npm start` |
| 应用端口 | `3000` |
| 外部映射端口 | `3000` |
| 包管理器 | npm |
| 容器名称 | `pool-management-system` |
| 镜像源 | 默认即可 |

如果启动命令下拉框没有 `npm start`，打开「自定义启动命令」，填写：

```text
node server.js
```

### 端口说明

- 应用端口 3000：容器内部 Node.js 服务端口。
- 外部映射端口 3000：服务器本机访问容器的端口。
- 后面 OpenResty/Nginx 代理到 `http://127.0.0.1:3000`。
- 3000 不应被云防火墙放行给公网。

如果页面有「端口外部访问」开关，创建容器时可以打开以便 1Panel 反向代理访问，但仍然不要在云防火墙放行 3000。

## 5. 环境变量（可选）

有些 1Panel 版本的 Node.js 创建页面没有环境变量区域，也不影响本项目启动。项目已经内置以下默认值：

- \`HOST=0.0.0.0\`（适合容器）
- \`PORT=3000\`
- \`NODE_ENV\` 不影响启动

因此，如果你的页面没有环境变量选项，直接跳过本节，继续创建运行环境即可。

如果你的 1Panel 版本提供环境变量入口，可以添加：

| 变量名 | 值 |
| --- | --- |
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` |
| `PORT` | `3000` |
| `TZ` | `Asia/Shanghai` |
| `PMS_INITIAL_ADMIN_PASSWORD` | 你设置的超管密码 |
| `PMS_INITIAL_BOSS_PASSWORD` | 你设置的老板密码 |
| `PMS_INITIAL_FRONTDESK_PASSWORD` | 你设置的前台密码 |
| `PMS_INITIAL_FINANCE_PASSWORD` | 你设置的财务密码 |

容器里必须使用：

```text
HOST=0.0.0.0
```

同时建议明确设置 `TZ=Asia/Shanghai`，确保日结、交班和报表使用中国标准时间；如果容器默认使用 UTC，跨日统计会偏移 8 小时。

不要填 `127.0.0.1`，否则 Node.js 只监听容器内部回环地址，外部映射可能无法访问。

初始密码说明：

- 每个密码至少 8 位，建议使用不同的随机密码。
- 只在数据库第一次创建员工账号时生效。
- 数据库已经初始化后，再改环境变量不会自动修改已有账号密码。
- 登录后台后，可在「员工权限」中重置已有账号密码。
- 如果不填写初始密码，系统会生成随机密码。创建完成后，在 1Panel 运行环境的「日志」中搜索“初始账号”即可看到随机密码；登录后到「员工权限」修改。

## 6. 启动并验证容器

保存并创建运行环境，等待状态显示「运行中」。

在 1Panel 运行环境日志中确认没有报错。然后在服务器终端测试：

```bash
curl http://127.0.0.1:3000
```

如果返回登录页 HTML，说明 Node.js 容器正常。

也可以临时访问：

```text
http://服务器IP:3000
```

如果访问不到，检查：

1. 运行环境状态是否为运行中。
2. 源码目录是否真的包含 `server.js` 和 `package.json`。
3. 启动命令是否为 `npm start` 或 `node server.js`。
4. 应用端口和外部映射端口是否都是 3000。
5. 1Panel 容器日志是否提示端口占用或 Node 版本错误。

## 7. 配置域名和 HTTPS

### 7.1 DNS

在域名服务商添加 A 记录：

```text
主机记录：pool
记录值：服务器公网 IP
```

### 7.2 1Panel 反向代理

进入：

```网站 → 网站 → 创建网站 → 反向代理
```

填写：

- 主域名：`pool.example.com`
- 代理地址：`http://127.0.0.1:3000`
- 开启 HTTPS
- 申请 Let's Encrypt 证书
- 开启 HTTP 自动跳转 HTTPS

验证：

```bash
curl -I https://pool.example.com
```

浏览器访问：

```text
https://pool.example.com
```

以后员工只能通过这个 HTTPS 域名访问，不要继续使用 IP:3000。

## 8. 首次登录和系统配置

首次登录后按顺序操作：

1. 使用超管账号登录。
2. 进入「员工权限」，修改所有初始密码。
3. 进入「系统设置」，设置门店名称、月卡规则、储值默认扣费、品牌图标和背景图。
4. 需要微信登录时，在系统设置填写 AppID 和 AppSecret。
5. 进入「卡项管理」，核对次卡、月卡、年卡、储值卡价格和权益。
6. 创建测试会员，测试收银、退款、核销、交班和报表。
7. 确认无误后删除或作废测试业务数据。

正式数据库位置：

```text
/opt/pool-management-system/data/pool.db
```

不要手工修改数据库文件，不要删除 `pool.db`。

## 9. 微信小程序配置

修改本地项目中的 `miniprogram/config.js`：

```js
module.exports = {
  BASE_URL: 'https://pool.example.com'
};
```

微信公众平台进入「开发管理 → 开发设置 → 服务器域名」，添加：

```text
request 合法域名：https://pool.example.com
```

正式版不能使用：

- `http://127.0.0.1:3000`
- `http://服务器IP:3000`
- 未备案域名
- 带端口或路径的域名

开发者工具中可以临时关闭合法域名校验，但真机和正式版必须配置合法 HTTPS 域名。

## 10. 腾讯云短信配置

只有超管可以访问后台短信配置页面。

腾讯云侧操作：

1. 开通短信服务。
2. 创建短信应用并记录 SdkAppId。
3. 创建并审核短信签名。
4. 创建账户变动短信模板。
5. 模板变量顺序必须是：会员姓名、业务类型、变动说明。
6. 创建最小权限 SecretId/SecretKey。
7. 在后台「短信通知配置」填写并保存。
8. 使用测试手机号发送测试短信。

短信发送失败不会回滚收银、退款或核销主交易，应查看 1Panel 容器日志和腾讯云控制台。

## 11. 数据库备份

数据库是一个 SQLite 文件。推荐每天备份。

如果服务器安装了 sqlite3：

```bash
mkdir -p /opt/pool-management-system/backup
sqlite3 /opt/pool-management-system/data/pool.db \
  ".backup '/opt/pool-management-system/backup/pool_$(date +%Y%m%d_%H%M%S).db'"
```

建议：

- 保留最近 30 份。
- 每周至少同步一份到异地对象存储。
- 备份目录权限设为 700。
- 备份文件权限设为 600。

恢复前先在 1Panel 停止 Node.js 运行环境，然后替换：

```text
/opt/pool-management-system/data/pool.db
```

恢复后删除同目录下的 `pool.db-wal` 和 `pool.db-shm`，再启动运行环境。

## 12. 升级流程

1. 通知员工暂停收银和核销。
2. 备份 `data/pool.db`。
3. 上传新代码，保留 `data/`。
4. 在本地或服务器执行：

```bash
npm test
```

5. 在 1Panel 点击运行环境「重启」或「重新部署」。
6. 查看容器日志。
7. 抽查登录、会员、收银流水和报表。

不要在生产服务器执行：

```bash
rm -rf data
```

## 13. 常见问题

### 页面打不开

- 确认 Node.js 运行环境为「运行中」。
- 查看容器日志。
- 确认源码目录是 `/opt/pool-management-system`。
- 确认启动命令是 `npm start`。
- 确认 `HOST=0.0.0.0`。
- 确认应用端口和映射端口都是 3000。
- 确认反向代理地址为 `http://127.0.0.1:3000`。

### 提示 node:sqlite 不存在

Node 版本低于 22.5。删除当前运行环境，重新选择 Node.js 22.x 创建。

### 小程序请求失败

检查 `miniprogram/config.js`、微信 request 合法域名、HTTPS 证书和后端容器日志。

### 忘记密码

使用其他超管账号进入「员工权限」重置。如果没有可用超管账号，不要直接删除数据库，应先备份后联系维护人员处理。

## 14. 上线检查清单

- [ ] Ubuntu 22.04 和 1Panel 正常
- [ ] 项目位于 `/opt/pool-management-system`
- [ ] Node.js 22.x 运行环境创建成功
- [ ] 启动命令为 `npm start`
- [ ] 应用端口和映射端口均为 3000
- [ ] `HOST=0.0.0.0`
- [ ] 初始密码已配置并登录后修改
- [ ] 3000 未对公网开放
- [ ] 域名反向代理到 `127.0.0.1:3000`
- [ ] HTTPS 证书有效
- [ ] 微信小程序合法域名已配置（如需要）
- [ ] 卡项、收银、退款、核销、交班、日结和报表已测试
- [ ] 数据库自动备份已配置
- [ ] 至少一份备份已异地保存

## 15. 备用方案：不用 1Panel 容器，直接 PM2

只有在你明确不使用 1Panel Node.js 运行环境时，才采用此方案：

- 宿主机安装 Node.js 22。
- `HOST=127.0.0.1`。
- 使用 PM2 启动 `server.js`。
- OpenResty/Nginx 代理到 `127.0.0.1:3000`。

不要把本节和前面的 1Panel 容器方案混用。
