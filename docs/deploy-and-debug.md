# Open-XiaoAI 部署与调试指南

## 前置条件

- 公网云主机（已安装 Docker）
- 小爱音箱已获取 root 权限
- 本地已 clone 本仓库
- 开发环境镜像：`idootop/open-xiaoai-runtime:lx06`（含 ARMv7 交叉编译工具链 + Node.js）

## 1. 生成证书（仅首次）

在本地执行：

```bash
mkdir -p certs && cd certs

# CA
openssl genrsa -out ca.key 2048
openssl req -new -x509 -key ca.key -out ca.crt -days 3650 -subj "/CN=OpenXiaoAI CA"

# Server 证书（替换 <SERVER_IP>）
openssl genrsa -out server.key 2048
openssl req -new -key server.key -out server.csr -subj "/CN=open-xiaoai-server"
echo "subjectAltName = IP:<SERVER_IP>, IP:127.0.0.1" > server_ext.cnf
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out server.crt -days 3650 -extfile server_ext.cnf
openssl pkcs12 -export -out server.p12 -inkey server.key -in server.crt \
  -certfile ca.crt -passout pass:

# Client 证书
openssl genrsa -out client.key 2048
openssl req -new -key client.key -out client.csr -subj "/CN=open-xiaoai-client"
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out client.crt -days 3650
openssl pkcs12 -export -out client.p12 -inkey client.key -in client.crt \
  -certfile ca.crt -passout pass:

# 清理
rm -f *.csr *.srl server_ext.cnf
cd ..
```

生成文件：

| 文件 | 用途 |
|------|------|
| `ca.crt` / `ca.key` | CA 证书和私钥（`ca.key` 不要上传到任何服务器） |
| `server.p12` | Server 端证书，部署到云主机 |
| `client.p12` | Client 端证书，部署到音箱 |

## 2. Server 端

### 2.1 构建镜像

```bash
cd /path/to/open-xiaoai
docker build --network host \
  -f examples/migpt/Dockerfile.deploy \
  -t open-xiaoai-migpt:latest .
```

### 2.2 本地测试镜像

```bash
docker run -d --name migpt-test --network host \
  -v $(pwd)/examples/migpt/config.ts:/app/config.ts \
  open-xiaoai-migpt:latest

docker logs -f migpt-test
docker rm -f migpt-test
```

### 2.3 本地开发运行（交互式调试）

```bash
docker run -it --network host \
  -v $(pwd):/app -w /app/examples/migpt \
  idootop/open-xiaoai-runtime:lx06 bash

# 容器内
corepack enable && pnpm install
pnpm build   # 编译 Rust neon 模块
pnpm start   # 启动 Server
```

### 2.4 部署到云主机

```bash
# 导出镜像
docker save open-xiaoai-migpt:latest | gzip > /tmp/open-xiaoai-migpt.tar.gz

# 上传（替换 <HOST> 为 ssh 别名或 user@ip）
scp /tmp/open-xiaoai-migpt.tar.gz <HOST>:~/migpt/open-xiaoai.tar.gz
ssh -o ConnectTimeout=10 <HOST> "mkdir -p ~/migpt/certs"
scp certs/server.p12 certs/ca.crt <HOST>:~/migpt/certs/
scp examples/migpt/config.ts <HOST>:~/migpt/config.ts

# 加载镜像
ssh -o ConnectTimeout=10 <HOST> "docker load < ~/migpt/open-xiaoai.tar.gz"
```

### 2.5 修改配置

```bash
ssh -o ConnectTimeout=10 <HOST> "vi ~/migpt/config.ts"
```

需修改 `openai` 字段中的 `baseURL`、`apiKey`、`model`。

### 2.6 启动 Server

```bash
ssh -o ConnectTimeout=10 <HOST> "cd ~/migpt && docker run -d \
  --name migpt \
  --network host \
  --restart unless-stopped \
  -v \$(pwd)/config.ts:/app/config.ts \
  -v \$(pwd)/certs:/app/certs \
  -v \$(pwd)/data:/app/data \
  open-xiaoai-migpt:latest"
```

启动成功日志：
```
✅ 已启动: wss (mTLS) "0.0.0.0:4399"
✅ 服务已启动...
```

### 2.7 运维命令

```bash
ssh -o ConnectTimeout=10 <HOST> "docker logs --tail 50 migpt"       # 查看日志
ssh -o ConnectTimeout=10 <HOST> "docker logs -f migpt"              # 实时日志
ssh -o ConnectTimeout=10 <HOST> "docker restart migpt"              # 重启
ssh -o ConnectTimeout=10 <HOST> "docker stop migpt"                 # 停止
ssh -o ConnectTimeout=10 <HOST> "docker rm -f migpt"                # 删除
ssh -o ConnectTimeout=10 <HOST> "docker exec -it migpt bash"        # 进入容器
ssh -o ConnectTimeout=10 <HOST> "docker image prune -f"             # 清理旧镜像
```

### 2.8 一键更新流程

```bash
# 本地构建 → 上传 → 远端重建
docker build --network host -f examples/migpt/Dockerfile.deploy -t open-xiaoai-migpt:latest .
docker save open-xiaoai-migpt:latest | gzip > /tmp/open-xiaoai-migpt.tar.gz
scp /tmp/open-xiaoai-migpt.tar.gz <HOST>:~/migpt/open-xiaoai.tar.gz
ssh -o ConnectTimeout=10 <HOST> "docker load < ~/migpt/open-xiaoai.tar.gz && \
  docker rm -f migpt && \
  cd ~/migpt && docker run -d \
    --name migpt --network host --restart unless-stopped \
    -v \$(pwd)/config.ts:/app/config.ts \
    -v \$(pwd)/certs:/app/certs \
    -v \$(pwd)/data:/app/data \
    open-xiaoai-migpt:latest"
```

### 2.9 仅更新配置（无需重新编译镜像）

> **提示**：`config.ts` 是通过 `-v` 挂载到容器内的，修改后只需重启容器即可生效，不需要重新构建和上传镜像。

```bash
scp examples/migpt/config.ts <HOST>:~/migpt/config.ts
ssh -o ConnectTimeout=10 <HOST> "docker restart migpt"
```

### 2.10 安全组配置

在云控制台为 4399 端口添加入方向规则，授权对象设为你的出口 IP：
- 固定 IP：`x.x.x.x/32`
- 动态 IP：`x.x.x.0/24`
- 音箱在不同网络时需额外添加音箱出口 IP

## 3. Client 端

### 3.1 交叉编译（ARMv7）

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

本地 x86 调试编译：

```bash
docker run --rm --network host \
  -v $(pwd):/app -w /app/packages/client-rust \
  idootop/open-xiaoai-runtime:lx06 \
  cargo build --release
```

### 3.2 部署到音箱

```bash
# 上传二进制
adb push target/armv7-unknown-linux-gnueabihf/release/client /data/open-xiaoai/client
adb shell chmod +x /data/open-xiaoai/client

# 上传证书
adb shell mkdir -p /data/open-xiaoai/certs
adb push certs/client.p12 /data/open-xiaoai/certs/
adb push certs/ca.crt /data/open-xiaoai/certs/

# 配置 Server 地址（替换 <SERVER_IP>）
adb shell "echo 'wss://<SERVER_IP>:4399' > /data/open-xiaoai/server.txt"
```

### 3.3 运行

```bash
# SSH 连接音箱（必须加超时）
ssh -o ConnectTimeout=10 -o HostKeyAlgorithms=+ssh-rsa root@<音箱IP>

# 前台运行
/data/open-xiaoai/client wss://<SERVER_IP>:4399

# 后台运行
/data/open-xiaoai/client wss://<SERVER_IP>:4399 &

# 查看进程
ps | grep client

# 停止
kill -9 $(ps | grep "open-xiaoai/client" | grep -v grep | awk '{print $1}')
```

### 3.4 开机自启

```bash
cp /data/open-xiaoai/boot.sh /data/init.sh
chmod +x /data/init.sh
reboot
```

## 4. 局域网模式（无需证书）

不部署证书文件，双端自动降级为 `ws://` 无加密模式：

```bash
echo "ws://192.168.x.x:4399" > /data/open-xiaoai/server.txt
```

## 5. 验证部署

- Server 日志显示 `✅ 已连接（已认证）: <音箱IP>`
- 无证书或假证书的连接在 TLS 层直接拒绝
- RPC 测试：`get_version` 返回版本号，`run_shell "mphelper mute_stat"` 返回静音状态

## 6. 证书管理

- 更换证书：重新执行第 1 节，替换双端文件并重启
- 吊销 Client：无 CRL 机制，需重新生成 CA 和所有证书
- 有效期：默认 3650 天（10 年）

## 7. 常见问题

| 问题 | 排查方法 |
|------|----------|
| Server 启动失败 | `docker logs migpt` 查看错误 |
| LLM 404 | 检查 `config.ts` 中 `model` 名称 |
| Client 连不上 Server | 检查安全组 4399 端口、`server.txt` 地址 |
| TLS 握手失败 | 确认 `ca.crt` 和 `.p12` 双端一致 |
| 容器反复重启 | `docker logs migpt` + `docker events` |
| 音箱无响应 | SSH 到音箱检查 client 进程：`ps \| grep client` |
| 磁盘空间不足 | `docker image prune -f` |

## 8. 文件清单

| 位置 | 文件 | 说明 |
|------|------|------|
| 云主机 `~/migpt/certs/` | `server.p12`, `ca.crt` | Server 证书 |
| 云主机 `~/migpt/` | `config.ts` | LLM 配置 |
| 云主机 `~/migpt/` | `data/` | 持久化数据 |
| 音箱 `/data/open-xiaoai/certs/` | `client.p12`, `ca.crt` | Client 证书 |
| 音箱 `/data/open-xiaoai/` | `server.txt` | Server 地址 |
| 音箱 `/data/open-xiaoai/` | `client` | Client 二进制 |
| 本地保管 | `ca.key` | CA 私钥，**不要上传到任何服务器** |
