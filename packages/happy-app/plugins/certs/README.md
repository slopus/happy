# 自签证书目录

本目录存放**自托管 Paws Server 的自签名 TLS 证书**，供 [`../withSelfHostedServerTrust.js`](../withSelfHostedServerTrust.js) 插件在 Android 构建（`prebuild`）时写入信任锚（`network_security_config`）。

## 为什么需要它

只有当部署者明确选择**自签名证书**时，才需要额外配置本目录。Android 默认只信任系统 CA，会拒绝自签名证书并导致 App「连接服务器失败」；插件通过加入专用信任锚解决这个问题。

公网正式服务应优先使用以下公开可信方案：

- 域名 + Caddy 自动 HTTPS
- 固定公网 IP + Let's Encrypt 短期 IP 地址证书

这两种证书都由系统信任，不需要依赖本插件。完整部署方法见
[`../../../../docs/selfhost-web-deploy.zh-CN.md`](../../../../docs/selfhost-web-deploy.zh-CN.md)。

> 该证书是**叶子证书（公钥）、非私钥**，只能验证它自己 SAN 内的主机，不能为其它域名 MITM，不削弱对其它网站的安全。

## 需要放置的文件

| 文件名 | 说明 |
|--------|------|
| `selfhosted_server.pem` | 服务器的叶子证书，内容以 `-----BEGIN CERTIFICATE-----` 开头 |

> ⚠️ **该 pem 被 `.gitignore`（`*.pem`）忽略、不入库**——避免把服务器地址公开到仓库。
> 因此**每台需要构建 Android 包的机器，都要手动把证书放到这里**，否则 `pnpm prebuild` 会因找不到证书而失败。

## 如何获取证书

从运行中的自部署服务器拉取证书（替换为你的 `HOST:PORT`）：

```bash
openssl s_client -connect <HOST>:<PORT> -servername <HOST> </dev/null 2>/dev/null \
  | openssl x509 > selfhosted_server.pem
```

放好后路径应为：

```
packages/happy-app/plugins/certs/selfhosted_server.pem
```

## 局限

若服务器重新生成了不同的自签证书（如清空 Caddy 数据目录），需更新此 pem 并重新打包 APK。
