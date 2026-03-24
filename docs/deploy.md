# Open-XiaoAI 安全部署指南

本文档说明如何将 Open-XiaoAI 安全部署到公有云，Client 运行在小爱音箱，Server 运行在云主机。

## 前置条件

- 一台公网云主机（本文以阿里云 ECS 为例，需已安装 Docker）
- 小爱音箱已获取 root 权限
- 本地开发机已 clone 本仓库

## 1. 生成证书

在本地开发机执行，只需做一次：

```bash
mkdir -p certs && cd certs

# 1.1 生成 CA
openssl genrsa -out ca.key 2048
openssl req -new -x509 -key ca.key -out ca.crt -days 3650 -subj "/CN=OpenXiaoAI CA"

# 1.2 生成 Server 证书（替换 <SERVER_IP> 为你的云主机公网 IP）
openssl genrsa -out server.key 2048
openssl req -new -key server.key -out server.csr -subj "/CN=open-xiaoai-server"
echo "subjectAltName = IP:<SERVER_IP>, IP:127.0.0.1" > server_ext.cnf
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out server.crt -days 3650 -extfile server_ext.cnf
openssl pkcs12 -export -out server.p12 -inkey server.key -in server.crt \
  -certfile ca.crt -passout pass:

# 1.3 生成 Client 证书
openssl genrsa -out client.key 2048
openssl req -new -key client.key -out client.csr -subj "/CN=open-xiaoai-client"
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out client.crt -days 3650
openssl pkcs12 -export -out client.p12 -inkey client.key -in client.crt \
  -certfile ca.crt -passout pass:

# 1.4 清理临时文件
rm -f *.csr *.srl server_ext.cnf
cd ..
```

生成后 `certs/` 目录应包含：
```
ca.crt  ca.key          — CA 证书和私钥（妥善保管 ca.key）
server.crt  server.key  server.p12  — Server 证书
client.crt  client.key  client.p12  — Client 证书
```

## 2. 部署 Server（云主机）

以 migpt 为例，使用 Docker 部署。

### 2.1 本地构建镜像

```bash
cd /path/to/open-xiaoai

# 构建镜像
docker build --network host \
  -f examples/migpt/Dockerfile.deploy \
  -t open-xiaoai-migpt:latest .

# 导出镜像
docker save open-xiaoai-migpt:latest | gzip > /tmp/open-xiaoai-migpt.tar.gz
```

### 2.2 上传到云主机

```bash
# 上传镜像（替换 <HOST> 为你的 ssh 别名或 user@ip）
scp /tmp/open-xiaoai-migpt.tar.gz <HOST>:~/migpt-migpt.tar.gz

# 创建运行目录，上传证书和配置
ssh <HOST> "mkdir -p ~/migpt/certs"
scp certs/server.p12 certs/ca.crt <HOST>:~/migpt/certs/
scp examples/migpt/config.ts <HOST>:~/migpt/config.ts
```

### 2.3 云端加载镜像

```bash
ssh <HOST> "docker load < ~/migpt-migpt.tar.gz && rm -f ~/migpt-migpt.tar.gz"
```

### 2.4 修改配置

在云主机上编辑 `~/migpt/config.ts`，填入你的 LLM API 配置：

```bash
ssh <HOST> "vi ~/migpt/config.ts"
```

需要修改的字段：
```typescript
openai: {
  baseURL: "https://api.deepseek.com/v1",  // 你的 LLM API 地址
  apiKey: "sk-xxx",                          // 你的 API 密钥
  model: "deepseek-chat",                    // 模型名称
},
```

配置修改后需要重启容器才能生效（见 2.7 节）。

### 2.5 启动 Server

```bash
ssh <HOST> "cd ~/migpt && docker run -d \
  --name migpt \
  --network host \
  --restart unless-stopped \
  -v \$(pwd)/config.ts:/app/config.ts \
  -v \$(pwd)/certs:/app/certs \
  open-xiaoai-migpt:latest"
```

### 2.6 查看日志

```bash
# 查看实时日志
ssh <HOST> "docker logs -f --tail 50 migpt"

# 查看最近日志
ssh <HOST> "docker logs --tail 20 migpt"
```

启动成功应显示：
```
✅ 已启动: wss (mTLS) "0.0.0.0:4399"
✅ 服务已启动...
```

### 2.7 停止 / 重启 / 删除

```bash
# 停止
ssh <HOST> "docker stop migpt"

# 重启（修改 config.ts 后执行）
ssh <HOST> "docker restart migpt"

# 删除容器
ssh <HOST> "docker rm -f migpt"
```

### 2.8 更新镜像

代码修改后，在本地重新构建并上传：

```bash
# 本地重新构建
cd /path/to/open-xiaoai
docker build --network host \
  -f examples/migpt/Dockerfile.deploy \
  -t open-xiaoai-migpt:latest .
docker save open-xiaoai-migpt:latest | gzip > /tmp/open-xiaoai-migpt.tar.gz

# 上传并替换
scp /tmp/open-xiaoai-migpt.tar.gz <HOST>:~/migpt-migpt.tar.gz
ssh <HOST> "docker load < ~/migpt-migpt.tar.gz"

# 重建容器
ssh <HOST> "docker rm -f migpt"
ssh <HOST> "cd ~/migpt && docker run -d \
  --name migpt \
  --network host \
  --restart unless-stopped \
  -v \$(pwd)/config.ts:/app/config.ts \
  -v \$(pwd)/certs:/app/certs \
  open-xiaoai-migpt:latest"
```

### 2.9 安全组配置

在阿里云控制台：

1. ECS 实例详情 → 安全组 → 点击安全组 ID
2. 入方向规则 → 添加/修改 4399 端口规则
3. 授权对象设为你的出口 IP（查询方式：`curl ifconfig.me`）
   - 固定 IP：`x.x.x.x/32`
   - 动态 IP：`x.x.x.0/24`
4. 如果音箱在不同网络，需要额外添加音箱的出口 IP

## 3. 部署 Client（小爱音箱）

### 3.1 上传证书到音箱

```bash
# 通过 adb 或 ssh 连接音箱后
mkdir -p /data/open-xiaoai/certs
adb push certs/client.p12 /data/open-xiaoai/certs/
adb push certs/ca.crt /data/open-xiaoai/certs/
```

### 3.2 配置 Server 地址

```bash
# 在音箱上执行（替换 <SERVER_IP>）
echo "wss://<SERVER_IP>:4399" > /data/open-xiaoai/server.txt
```

### 3.3 编译 Client

在本地开发机使用 runtime 容器交叉编译：

```bash
cd /path/to/open-xiaoai
docker run --rm --network host \
  -v $(pwd):/app -w /app/packages/client-rust \
  -e OPENSSL_INCLUDE_DIR=/usr/include \
  -e OPENSSL_LIB_DIR=/usr/lib/arm-linux-gnueabihf \
  -e OPENSSL_STATIC=1 \
  idootop/open-xiaoai-runtime:lx06 \
  cargo build --release --target armv7-unknown-linux-gnueabihf
```

上传到音箱：

```bash
adb push target/armv7-unknown-linux-gnueabihf/release/client /data/open-xiaoai/client
adb shell chmod +x /data/open-xiaoai/client
```

### 3.4 启动 Client

```bash
/data/open-xiaoai/client wss://<SERVER_IP>:4399
```

成功连接后显示：
```
✅ 已启动
✅ 已连接: "wss://<SERVER_IP>:4399"
```

### 3.5 开机自启

将 `packages/client-rust/boot.sh` 复制到 `/data/init.sh`，音箱开机时会自动执行该脚本：

```bash
cp /data/open-xiaoai/boot.sh /data/init.sh
chmod +x /data/init.sh
reboot
```

`boot.sh` 会自动读取 `/data/open-xiaoai/server.txt` 中的 Server 地址，kill 旧进程后在后台启动 Client。

## 4. 验证部署

### 4.1 连接验证

Server 日志应显示：
```
✅ 已连接（已认证）: <音箱IP>
```

### 4.2 安全验证

无证书或假证书的连接会被 Server 在 TLS 层直接拒绝，不会进入 WebSocket 层。

### 4.3 功能验证

Server 端调用 RPC 测试：
- `get_version` — 返回 Client 版本号
- `run_shell "mphelper mute_stat"` — 返回静音状态
- `run_shell "echo hello"` — 被白名单拦截，返回错误

## 5. 局域网模式（无需证书）

不部署证书文件即可，双端自动降级为 `ws://` 无加密模式：

```bash
echo "ws://192.168.x.x:4399" > /data/open-xiaoai/server.txt
```

## 6. 证书管理

### 更换证书

重新执行第 1 节生成新证书，替换 Server 和 Client 上的文件，重启双端。

### 吊销某个 Client

目前无 CRL 机制。如需吊销，重新生成 CA 和所有证书，替换部署。

### 证书有效期

默认 3650 天（10 年）。到期前需重新签发。

## 7. 文件清单

| 位置 | 文件 | 说明 |
|------|------|------|
| 云主机 `~/migpt/certs/` | `server.p12`, `ca.crt` | Server 证书 + CA（验证 Client） |
| 云主机 `~/migpt/` | `config.ts` | LLM API 配置 |
| 音箱 `/data/open-xiaoai/certs/` | `client.p12`, `ca.crt` | Client 证书 + CA（验证 Server） |
| 音箱 `/data/open-xiaoai/` | `server.txt` | Server 地址 |
| 音箱 `/data/open-xiaoai/` | `client` | Client 二进制 |
| 本地保管 | `ca.key` | CA 私钥，签发新证书用，**不要上传到任何服务器** |

## 8. 常用运维命令速查

```bash
# 启动
docker run -d --name migpt --network host --restart unless-stopped \
  -v $(pwd)/config.ts:/app/config.ts \
  -v $(pwd)/certs:/app/certs \
  open-xiaoai-migpt:latest

# 停止
docker stop migpt

# 重启（改完 config.ts 后）
docker restart migpt

# 查看日志
docker logs --tail 50 migpt

# 实时日志
docker logs -f migpt

# 删除容器
docker rm -f migpt

# 查看容器状态
docker ps -a | grep migpt
```
