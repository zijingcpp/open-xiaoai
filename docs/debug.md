# Open-XiaoAI 调试指南

本文档总结 Server 端和 Client 端的本地调试方法、镜像使用和远端部署流程。

## 1. 开发环境镜像

项目提供了预构建的 runtime 镜像，包含 Rust 交叉编译工具链和 Node.js 环境：

```
idootop/open-xiaoai-runtime:lx06    # ARMv7 交叉编译 + Node.js
```

所有容器均将本地仓库挂载到 `/app`：

```bash
docker run --rm --network host \
  -v $(pwd):/app \
  idootop/open-xiaoai-runtime:lx06 \
  bash
```

## 2. Client 端调试

### 2.1 交叉编译（音箱用 ARMv7）

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

产物路径：`packages/client-rust/target/armv7-unknown-linux-gnueabihf/release/client`

### 2.2 本地 x86 编译（用于本地调试）

在 runtime 容器内直接编译 x86 版本：

```bash
docker run --rm --network host \
  -v $(pwd):/app -w /app/packages/client-rust \
  idootop/open-xiaoai-runtime:lx06 \
  cargo build --release
```

### 2.3 上传到音箱

```bash
# 方式一：dd + ssh
dd if=target/armv7-unknown-linux-gnueabihf/release/client \
| ssh -o HostKeyAlgorithms=+ssh-rsa root@<音箱IP> "dd of=/data/open-xiaoai/client"

# 方式二：adb
adb push target/armv7-unknown-linux-gnueabihf/release/client /data/open-xiaoai/client
adb shell chmod +x /data/open-xiaoai/client
```

### 2.4 运行与调试

```bash
# SSH 连接音箱
ssh -o HostKeyAlgorithms=+ssh-rsa root@<音箱IP>

# 前台运行（可看日志）
/data/open-xiaoai/client ws://<SERVER_IP>:4399

# 后台运行
/data/open-xiaoai/client ws://<SERVER_IP>:4399 &

# 查看进程
ps | grep client

# 停止
kill -9 $(ps | grep "open-xiaoai/client" | grep -v grep | awk '{print $1}')
```

### 2.5 开机自启

```bash
cp /data/open-xiaoai/boot.sh /data/init.sh
chmod +x /data/init.sh
reboot
```

`boot.sh` 会读取 `/data/open-xiaoai/server.txt` 中的地址，kill 旧进程后在后台启动 Client。

## 3. Server 端调试

### 3.1 本地开发运行

在 runtime 容器内运行 Server（以 migpt 为例）：

```bash
docker run --rm --network host \
  -v $(pwd):/app -w /app/examples/migpt \
  idootop/open-xiaoai-runtime:lx06 \
  bash -c "corepack enable && pnpm install && pnpm build && pnpm start"
```

或者进入容器交互式调试：

```bash
docker run -it --network host \
  -v $(pwd):/app -w /app/examples/migpt \
  idootop/open-xiaoai-runtime:lx06 bash

# 容器内
corepack enable && pnpm install
pnpm build   # 编译 Rust neon 模块
pnpm start   # 启动 Server
```

### 3.2 构建部署镜像

```bash
cd /path/to/open-xiaoai

docker build --network host \
  -f examples/migpt/Dockerfile.deploy \
  -t open-xiaoai-migpt:latest .
```

### 3.3 本地测试部署镜像

```bash
docker run -d --name migpt-test \
  --network host \
  -v $(pwd)/examples/migpt/config.ts:/app/config.ts \
  open-xiaoai-migpt:latest

# 查看日志
docker logs -f migpt-test

# 清理
docker rm -f migpt-test
```

## 4. 远端部署（云主机）

以下以 ssh 别名 `<HOST>` 为例（如 `my-ali`），需在 `~/.ssh/config` 中配置。

### 4.1 一键更新流程

代码修改后，执行以下命令完成构建 → 推送 → 重启：

```bash
# 1. 本地构建
cd /path/to/open-xiaoai
docker build --network host \
  -f examples/migpt/Dockerfile.deploy \
  -t open-xiaoai-migpt:latest .

# 2. 导出并上传
docker save open-xiaoai-migpt:latest | gzip > /tmp/open-xiaoai-migpt.tar.gz
scp /tmp/open-xiaoai-migpt.tar.gz <HOST>:~/migpt/open-xiaoai.tar.gz

# 3. 远端加载并重建容器
ssh <HOST> "docker load < ~/migpt/open-xiaoai.tar.gz && \
  docker rm -f migpt && \
  cd ~/migpt && docker run -d \
    --name migpt \
    --network host \
    --restart unless-stopped \
    -v \$(pwd)/config.ts:/app/config.ts \
    -v \$(pwd)/certs:/app/certs \
    -v \$(pwd)/data:/app/data \
    open-xiaoai-migpt:latest"
```

### 4.2 仅更新配置（无需重新构建）

```bash
# 上传新配置
scp examples/migpt/config.ts <HOST>:~/migpt/config.ts

# 重启容器使配置生效
ssh <HOST> "docker restart migpt"
```

### 4.3 远端运维命令

```bash
# 查看状态
ssh <HOST> "docker ps | grep migpt"

# 实时日志
ssh <HOST> "docker logs -f --tail 50 migpt"

# 重启
ssh <HOST> "docker restart migpt"

# 停止
ssh <HOST> "docker stop migpt"

# 进入容器排查
ssh <HOST> "docker exec -it migpt bash"

# 清理旧镜像（释放磁盘）
ssh <HOST> "docker image prune -f"
```

### 4.4 远端目录结构

```
~/migpt/
├── config.ts          # LLM 配置（挂载到容器 /app/config.ts）
├── certs/             # TLS 证书
│   ├── server.p12
│   └── ca.crt
├── data/              # 持久化数据（挂载到容器 /app/data）
└── open-xiaoai.tar.gz # 最近上传的镜像包
```

## 5. 常见问题排查

| 问题 | 排查方法 |
|------|----------|
| Server 启动失败 | `docker logs migpt` 查看错误日志 |
| LLM 404 错误 | 检查 `config.ts` 中的 `model` 名称是否正确 |
| Client 连不上 Server | 检查安全组是否放行 4399 端口、`server.txt` 地址是否正确 |
| TLS 握手失败 | 确认证书文件完整，`ca.crt` 和 `.p12` 文件双端一致 |
| 容器反复重启 | `docker logs migpt` 查看崩溃原因，`docker events` 查看重启事件 |
| 音箱无响应 | SSH 到音箱检查 client 进程是否存活：`ps \| grep client` |
| 磁盘空间不足 | `docker image prune -f` 清理旧镜像 |
