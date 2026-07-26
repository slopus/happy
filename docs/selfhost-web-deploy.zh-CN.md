# 自托管 Paws Web App

> 本文面向希望在自己的服务器上部署 Paws 网页端的人，覆盖构建、Caddy 托管、API/WebSocket 同源反代、可信 HTTPS、更新与回滚。

[English](selfhost-web-deploy.md)

## 一、部署结果与架构

完成后，浏览器只需要访问一个 HTTPS 地址：

```text
浏览器
  │
  │ https://paws.example.com
  ▼
Caddy
  ├─ /v1/*、/v2/*、/v3/*、/v4/*、/files/*、/health
  │      └─ 反向代理到 Paws Server（默认 127.0.0.1:3005）
  └─ 其余路径
         └─ 托管 packages/happy-app/dist
```

推荐让 Web App 与 Paws Server 使用同一个 origin（协议、主机、端口完全相同）。这样登录、附件下载和 WebSocket 不需要额外配置 CORS。

## 二、前置条件

构建机需要：

- Git
- Node.js 20 或更高版本
- pnpm 10.11.0（仓库的 `packageManager` 已固定版本）
- 能访问 Paws 源码

服务器需要：

- Linux 服务器
- Caddy 2
- SSH 登录权限
- 已运行的 Paws Server，本文假设它监听 `127.0.0.1:3005`
- 一个域名，或一个固定公网 IPv4/IPv6 地址
- 公网放行 80 和 443 端口

如果还没有部署后端，先阅读：

- [后端部署说明](deployment.md)
- [内网自托管说明](selfhost-intranet-deploy.md)

> [!IMPORTANT]
> Web App 只是客户端界面，不能替代 Paws Server。页面能打开不等于消息、机器在线状态和附件链路可用。

## 三、选择 HTTPS 方案

### 3.1 有域名：推荐方案

使用域名时，Caddy 可以自动申请并续期公开可信证书。这是最简单、兼容性最好的正式部署方案。

准备一条 DNS 记录：

```text
paws.example.com -> 你的服务器公网 IP
```

等待 DNS 生效后继续配置 Caddy。

### 3.2 只有公网 IP

Let’s Encrypt 已支持公开可信的 IPv4/IPv6 证书，但 IP 地址证书必须使用 `shortlived` profile，有效期约 160 小时，因此自动续期不是可选项。

限制：

- 必须是可以从公网验证的 IP。
- 只能使用 `http-01` 或 `tls-alpn-01` 验证，不能使用 `dns-01`。
- 80 或 443 端口必须能从公网访问。
- IP 发生变化后必须重新签发证书。
- ACME 客户端必须支持 short-lived profile 和 IP 地址证书。

官方资料：

- [Let’s Encrypt：IP 地址证书正式开放](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability.html)
- [Certbot：申请 IP 地址证书](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)

### 3.3 自签名证书

自签名证书可以加密通信，但浏览器和普通客户端默认不信任它。它只适合：

- 本地开发
- 隔离内网
- 临时测试
- 已通过私有 CA、MDM 或证书固定显式分发信任的环境

公网正式服务应优先使用域名证书或 Let’s Encrypt 公网 IP 证书。

## 四、手工构建 Web App

### 4.1 获取代码并安装依赖

```bash
git clone https://github.com/wangjs-jacky/happy.git
cd happy
corepack enable
pnpm install --frozen-lockfile
```

检查点：

```bash
node --version
pnpm --version
git status --short
```

### 4.2 设置公开访问地址

构建时必须写入用户最终访问的 Paws Server origin。

域名示例：

```bash
export PAWS_WEB_ORIGIN="https://paws.example.com"
```

公网 IP 示例：

```bash
export PAWS_WEB_ORIGIN="https://203.0.113.10"
```

如果使用非标准端口，端口也必须包含在地址中：

```bash
export PAWS_WEB_ORIGIN="https://203.0.113.10:8443"
```

> [!WARNING]
> `http://host:3005` 与 `https://host` 是两个不同的 origin。Web App、CLI 和移动端应指向同一个对外入口，避免登录状态、附件地址和 WebSocket 连接不一致。

### 4.3 类型检查并导出

```bash
pnpm --filter happy-app typecheck

CI=1 \
APP_ENV=production \
EXPO_PUBLIC_HAPPY_SERVER_URL="$PAWS_WEB_ORIGIN" \
pnpm --filter happy-app export:web
```

产物目录：

```text
packages/happy-app/dist/
```

检查点：

```bash
test -f packages/happy-app/dist/index.html
find packages/happy-app/dist -maxdepth 2 -type f | head
```

本地临时预览：

```bash
pnpm dlx serve packages/happy-app/dist
```

## 五、首次上传到服务器

以下示例使用：

```text
SSH 主机：deploy@paws.example.com
发布根目录：/var/www/paws-web
当前版本：/var/www/paws-web/current
```

先在服务器准备目录：

```bash
ssh deploy@paws.example.com \
  'sudo install -d -o "$USER" -g "$USER" /var/www/paws-web &&
   install -d /var/www/paws-web/current'
```

发布根目录必须允许 SSH 用户创建和重命名其内部目录；部署脚本只操作
`/var/www/paws-web/` 内部，不需要把整个 `/var/www` 改成可写。

上传构建产物：

```bash
tar -C packages/happy-app/dist -czf /tmp/paws-web.tar.gz .
scp /tmp/paws-web.tar.gz deploy@paws.example.com:/tmp/
ssh deploy@paws.example.com \
  'tar -xzf /tmp/paws-web.tar.gz -C /var/www/paws-web/current &&
   rm /tmp/paws-web.tar.gz'
```

检查点：

```bash
ssh deploy@paws.example.com \
  'test -f /var/www/paws-web/current/index.html && echo "Web files ready"'
```

## 六、配置 Caddy

### 6.1 域名 + 自动 HTTPS

编辑服务器上的 `/etc/caddy/Caddyfile`：

```caddyfile
paws.example.com {
    encode zstd gzip

    @backend path /v1/* /v2/* /v3/* /v4/* /files/* /health
    reverse_proxy @backend 127.0.0.1:3005

    root * /var/www/paws-web/current
    try_files {path} /index.html
    file_server
}
```

这里的 `try_files {path} /index.html` 很重要：Paws Web 使用前端路由，直接访问 `/session/...` 时也必须返回 `index.html`。

校验并重载：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy 会自动完成域名证书申请和续期。

### 6.2 公网 IP + Let’s Encrypt

以下示例使用 Certbot 5.4 或更高版本。先让 Caddy 在 80 端口提供 ACME challenge：

```caddyfile
http://203.0.113.10 {
    handle /.well-known/acme-challenge/* {
        root * /var/www/letsencrypt
        file_server
    }

    respond "HTTPS certificate bootstrap" 200
}
```

准备目录并加载配置：

```bash
sudo install -d -m 755 /var/www/letsencrypt
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

先使用 staging 测试，避免触发生产签发限制：

```bash
sudo certbot certonly \
  --staging \
  --preferred-profile shortlived \
  --webroot \
  --webroot-path /var/www/letsencrypt \
  --ip-address 203.0.113.10
```

测试成功后，去掉 `--staging` 申请正式证书：

```bash
sudo certbot certonly \
  --preferred-profile shortlived \
  --webroot \
  --webroot-path /var/www/letsencrypt \
  --ip-address 203.0.113.10
```

Certbot 的私钥目录通常只有 root 能读取。把证书复制到 Caddy 专用目录：

```bash
sudo install -d -m 750 -o root -g caddy /etc/caddy/certs
sudo install -m 640 -o root -g caddy \
  /etc/letsencrypt/live/203.0.113.10/fullchain.pem \
  /etc/caddy/certs/paws-ip-fullchain.pem
sudo install -m 640 -o root -g caddy \
  /etc/letsencrypt/live/203.0.113.10/privkey.pem \
  /etc/caddy/certs/paws-ip-privkey.pem
```

然后配置 HTTPS：

```caddyfile
http://203.0.113.10 {
    handle /.well-known/acme-challenge/* {
        root * /var/www/letsencrypt
        file_server
    }

    redir https://203.0.113.10{uri} permanent
}

https://203.0.113.10 {
    tls /etc/caddy/certs/paws-ip-fullchain.pem /etc/caddy/certs/paws-ip-privkey.pem
    encode zstd gzip

    @backend path /v1/* /v2/* /v3/* /v4/* /files/* /health
    reverse_proxy @backend 127.0.0.1:3005

    root * /var/www/paws-web/current
    try_files {path} /index.html
    file_server
}
```

重新加载：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

确保 Certbot timer 已启用，并让续期成功后重载 Caddy：

```bash
sudo systemctl enable --now certbot.timer
sudo install -d /etc/letsencrypt/renewal-hooks/deploy
sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-caddy.sh >/dev/null <<'EOF'
#!/usr/bin/env sh
set -eu
install -m 640 -o root -g caddy \
  /etc/letsencrypt/live/203.0.113.10/fullchain.pem \
  /etc/caddy/certs/paws-ip-fullchain.pem
install -m 640 -o root -g caddy \
  /etc/letsencrypt/live/203.0.113.10/privkey.pem \
  /etc/caddy/certs/paws-ip-privkey.pem
systemctl reload caddy
EOF
sudo chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-caddy.sh
sudo certbot renew --dry-run
```

> [!IMPORTANT]
> IP 地址证书只有约六天有效期。必须确认 timer 和 deploy hook 实际工作，不能依赖人工记忆续期。
> 如果发行版没有提供 `certbot.timer`，请按该发行版的 Certbot 安装说明配置等效的定时续期任务。

## 七、验证完整链路

### 7.1 验证 HTTPS 与页面

```bash
curl --fail --show-error --silent \
  --output /dev/null \
  --write-out 'HTTP=%{http_code} TLS=%{ssl_verify_result}\n' \
  "$PAWS_WEB_ORIGIN/"
```

期望：

```text
HTTP=200 TLS=0
```

### 7.2 验证后端反代

```bash
curl --fail "$PAWS_WEB_ORIGIN/health"
```

应返回 Paws Server 健康信息，而不是 `index.html`。

### 7.3 验证前端路由

```bash
curl --fail --silent "$PAWS_WEB_ORIGIN/session/test-route" \
  | grep -q '<title>Paws</title>'
```

### 7.4 验证 WebSocket

打开 Web App，登录后检查：

1. 页面能显示机器和会话。
2. 机器在线状态会更新。
3. 打开会话后消息能够实时到达。
4. 浏览器开发者工具中 `/v1/updates` 没有持续失败。

## 八、后续更新与原子回滚

不要直接覆盖正在提供服务的目录。推荐：

```text
/var/www/paws-web/current                   当前版本
/var/www/paws-web/current.next-<release>    待发布版本
/var/www/paws-web/current.backup-<release>  上一版本
```

手工更新流程：

```bash
# 本地
tar -C packages/happy-app/dist -czf /tmp/paws-web-release.tar.gz .
shasum -a 256 /tmp/paws-web-release.tar.gz
scp /tmp/paws-web-release.tar.gz deploy@paws.example.com:/tmp/

# 服务器
mkdir /var/www/paws-web/current.next-<release>
tar -xzf /tmp/paws-web-release.tar.gz \
  -C /var/www/paws-web/current.next-<release>
test -f /var/www/paws-web/current.next-<release>/index.html

mv /var/www/paws-web/current /var/www/paws-web/current.backup-<release>
mv /var/www/paws-web/current.next-<release> /var/www/paws-web/current
```

回滚：

```bash
mv /var/www/paws-web/current /var/www/paws-web/current.failed-<release>
mv /var/www/paws-web/current.backup-<release> /var/www/paws-web/current
```

目录切换不需要重启 Caddy。

仓库还提供了相同安全模型的辅助脚本，详见下一节。

## 九、使用部署脚本

脚本会执行：

1. 生产构建。
2. 创建压缩包。
3. 计算 SHA256。
4. 上传到服务器。
5. 在 staging 目录解压并校验。
6. 原子切换目录。
7. 保留上一版备份。

使用方法：

```bash
PAWS_WEB_ORIGIN="https://paws.example.com" \
PAWS_DEPLOY_HOST="deploy@paws.example.com" \
PAWS_DEPLOY_PATH="/var/www/paws-web/current" \
pnpm web:deploy
```

可选变量：

```text
PAWS_DEPLOY_PORT     SSH 端口，默认 22
PAWS_SKIP_BUILD=1    使用已经存在的 dist，不重新构建
```

脚本不会：

- 安装 Caddy。
- 修改服务器防火墙。
- 修改 Caddyfile。
- 删除历史备份。
- 上传到对象存储或 CDN。

## 十、对象存储/CDN（可选）

单机部署稳定后，可以把以下大文件路径迁移到对象存储或 CDN：

```text
/_expo/*
/assets/*
/*.wasm
/favicon*.ico
/metadata.json
```

原则：

1. `index.html` 保持短缓存或不缓存。
2. 带内容哈希的 JS、字体和图片可设置长期缓存。
3. 先上传新静态资源，再切换新的 `index.html`。
4. 旧哈希资源不要立即删除，否则仍打开旧页面的用户会加载失败。
5. CDN 方案只改变静态资源路径，不改变 `/v1/updates` WebSocket 与 API 的同源入口。

## 十一、常见问题

### 页面能打开，但登录或机器列表失败

通常是 `EXPO_PUBLIC_HAPPY_SERVER_URL` 构建值不正确，或者 Caddy 没有代理 `/v1/*`、`/v2/*`、`/v3/*`。

重新构建前检查：

```bash
echo "$PAWS_WEB_ORIGIN"
```

### 刷新 `/session/...` 返回 404

Caddy 缺少：

```caddyfile
try_files {path} /index.html
```

### WebSocket 连接失败

确认 `/v1/updates` 命中了 `reverse_proxy`，没有被前端静态站的 fallback 捕获。

### 浏览器提示证书不安全

检查：

```bash
openssl s_client -connect paws.example.com:443 -servername paws.example.com </dev/null 2>/dev/null \
  | openssl x509 -noout -issuer -dates -ext subjectAltName
```

常见原因：

- 仍在使用自签名证书。
- 证书 SAN 不包含正在访问的域名或 IP。
- IP short-lived 证书自动续期失败。
- 浏览器标签页仍保留旧 TLS 连接，关闭后重新打开即可复查。

### 构建成功但上线仍是旧页面

检查线上 `index.html` 引用的入口脚本哈希，并确认没有把 `index.html` 设置成长缓存。

## 十二、检查清单

- [ ] Paws Server 的 `/health` 正常。
- [ ] `PAWS_WEB_ORIGIN` 是用户最终访问的完整 HTTPS origin。
- [ ] `packages/happy-app/dist/index.html` 已生成。
- [ ] Caddy 已代理 `/v1/*`、`/v2/*`、`/v3/*`、`/v4/*`、`/files/*` 和 `/health`。
- [ ] Caddy 为其他路径提供 SPA fallback。
- [ ] 浏览器不需要忽略证书错误。
- [ ] `curl` 显示 `HTTP=200 TLS=0`。
- [ ] IP 地址证书的自动续期和 Caddy reload hook 已验证。
- [ ] 更新使用 staging + 校验 + 原子切换。
- [ ] 上一版本备份仍可用于回滚。

## 总结

最稳妥的 Paws Web 自托管方案是：

1. 先运行 Paws Server。
2. 使用域名和 Caddy 自动 HTTPS。
3. 以最终公开 origin 构建 Web App。
4. 由同一个 Caddy 同源代理 API/WebSocket 并托管静态文件。
5. 使用 staging、SHA256、原子切换和备份完成更新。
6. 只有在没有域名时，才使用必须自动续期的 Let’s Encrypt 公网 IP 短期证书。
