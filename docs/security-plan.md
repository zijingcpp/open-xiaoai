# Open-XiaoAI 公有云部署安全改造方案

> 版本：v2.0 | 日期：2026-03-19 | 状态：阶段一已完成

## 1. 背景

Open-XiaoAI 采用 Client-Server 架构，Client 运行在小爱音箱上（Rust），Server 运行在 PC/服务器上（Rust + Python/Node.js），双端通过 WebSocket 通信。

原始设计面向局域网场景，将 Server 部署到公有云后，通信链路暴露在公网，需要进行安全改造。

## 2. 架构概览

```
小爱音箱 (Client)                          公有云 (Server)
┌──────────────────┐                    ┌──────────────────────────┐
│  client (Rust)   │◄── wss (mTLS) ──► │  Server App (:4399)      │
│                  │                    │  - mTLS 双向证书认证      │
│  - run_shell     │                    │  - RPC 调用              │
│  - audio record  │                    │  - Python/Node.js 业务   │
│  - audio play    │                    │                          │
│  - monitor       │                    │                          │
└──────────────────┘                    └──────────────────────────┘

证书体系（自签 CA，不需要域名）：
┌─────────┐
│  CA 证书 │  ca.crt / ca.key
└────┬────┘
     ├── Server 证书  server.crt / server.key / server.p12
     │   SAN: IP:139.224.115.165, IP:127.0.0.1
     └── Client 证书  client.crt / client.key / client.p12
         CN: open-xiaoai-client
```

## 3. 风险评估

| # | 风险点 | 位置 | 严重度 | 改造状态 |
|---|--------|------|--------|---------|
| R1 | 明文传输 | 双端 | 高 | ✅ mTLS 加密 |
| R2 | 无认证机制 | 双端 | 高 | ✅ mTLS 证书认证（Server 端 CA 验证） |
| R3 | 任意 shell 执行 | Client | **严重** | ✅ 白名单拦截 |
| R4 | 重连无退避 | Client | 中 | ✅ 指数退避 |
| R5 | 二进制下载无校验 | Client | 高 | ✅ sha256 校验 |
| R6 | AudioConfig 远程可控 | Client | 中 | ✅ 参数校验 |
| R7 | 无心跳机制 | 双端 | 低 | ✅ Ping/Pong 15s/30s |
| R8 | run_shell 未根治 | Client | 中 | ⏳ 长期（拆解为独立 RPC） |

## 4. 已完成的改造

### 4.1 mTLS 双向证书认证

**替代了原计划的 Caddy TLS + Token 认证方案。**

优势：
- 不需要域名（证书 SAN 直接写 IP）
- 证书即身份（类似 SSH 密钥认证）
- 传输全程加密
- 可吊销单个证书而不影响其他设备

**证书生成**（一次性）：
```bash
cd certs/

# CA
openssl genrsa -out ca.key 2048
openssl req -new -x509 -key ca.key -out ca.crt -days 3650 -subj "/CN=OpenXiaoAI CA"

# Server 证书（替换 IP）
openssl genrsa -out server.key 2048
openssl req -new -key server.key -out server.csr -subj "/CN=open-xiaoai-server"
echo "subjectAltName = IP:你的云主机IP, IP:127.0.0.1" > server_ext.cnf
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out server.crt -days 3650 -extfile server_ext.cnf
openssl pkcs12 -export -out server.p12 -inkey server.key -in server.crt -certfile ca.crt -passout pass:

# Client 证书
openssl genrsa -out client.key 2048
openssl req -new -key client.key -out client.csr -subj "/CN=open-xiaoai-client"
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out client.crt -days 3650
openssl pkcs12 -export -out client.p12 -inkey client.key -in client.crt -certfile ca.crt -passout pass:
```

**Server 端部署**：将 `ca.crt`、`server.p12` 放到 Server 工作目录的 `certs/` 下。

**Client 端部署**：将 `ca.crt`、`client.p12` 放到音箱的 `/data/open-xiaoai/certs/` 下。

**向后兼容**：证书文件不存在时自动降级为 ws:// 无加密模式。

**涉及文件**：
- `packages/client-rust/Cargo.toml` — 添加 native-tls、tokio-native-tls、openssl、tokio-openssl 依赖
- `packages/client-rust/src/services/auth.rs` — 新增，Server 用 openssl（CA 验证），Client 用 native-tls
- `packages/client-rust/src/services/connect/message.rs` — 新增 ServerTls 变体（tokio_openssl::SslStream）
- `packages/client-rust/src/bin/client.rs` — wss:// 连接时加载客户端证书
- `examples/*/src/server.rs` — 调用 create_tls_acceptor + accept_tls 完成 mTLS 握手

### 4.2 run_shell 命令白名单

Client 端在执行 shell 命令前校验前缀白名单：

| 允许的前缀 | 用途 |
|-----------|------|
| `mphelper` | 播放控制 |
| `/usr/sbin/tts_play.sh` | TTS |
| `ubus call mediaplayer` | 播放 URL |
| `ubus call mibrain` | 小爱指令 |
| `ubus call pnshelper` | 唤醒/麦克风 |
| `fw_env` | 启动分区 |
| `micocfg_` | 设备信息 |
| `/etc/init.d/mico_aivs_lab` | 中断小爱 |

不在白名单内的命令直接拒绝并记录日志。

**涉及文件**：`packages/client-rust/src/bin/client.rs`

### 4.3 指数退避重连

连接失败时退避间隔：1s → 2s → 4s → 8s → 16s → 32s → 60s（上限）。连接成功后重置。

**涉及文件**：`packages/client-rust/src/bin/client.rs`

### 4.4 二进制下载校验

`boot.sh` 和 `init.sh` 下载 client 二进制时同时下载 sha256 校验文件并验证，校验失败拒绝启动。

**涉及文件**：`packages/client-rust/boot.sh`、`packages/client-rust/init.sh`

## 5. 待完成的改造

### 5.1 [P2] 安全组收紧

云服务器安全组限制 4399 端口源 IP，仅允许已知出口 IP 访问。

### 5.2 [P3] 彻底移除 run_shell

将 SpeakerManager 的每个操作拆为 Client 端独立 RPC 命令，移除通用 run_shell。

## 6. 测试结果

| 测试项 | 结果 | 说明 |
|--------|------|------|
| ws:// 向后兼容（本地） | ✅ | 无证书时自动降级 |
| ws:// 向后兼容（公网） | ✅ | 云端 Python server 验证 |
| mTLS 连接（wss://） | ✅ | Server 确认 CN=open-xiaoai-client |
| mTLS 无证书拒绝 | ✅ | 连接失败，触发退避 |
| 指数退避重连 | ✅ | 1s→2s→4s→8s→16s |
| run_shell 白名单拦截 | ✅ | `echo hello`、`rm -rf /` 被拒 |
| run_shell 白名单放行 | ✅ | `mphelper mute_stat` 正常执行 |

## 7. 使用方式

### 首次部署

1. 生成证书（参考 4.1 节）
2. Server 端：将 `ca.crt`、`server.p12` 放到工作目录 `certs/`
3. Client 端：将 `ca.crt`、`client.p12` 放到 `/data/open-xiaoai/certs/`
4. `server.txt` 内容改为 `wss://云主机IP:4399`

### 局域网使用（无需证书）

不放置证书文件即可，自动降级为 ws:// 模式，与原始行为一致。

## 8. 文件变更清单

### 新增
| 文件 | 说明 |
|------|------|
| `packages/client-rust/src/services/auth.rs` | mTLS acceptor/connector |
| `certs/` | 证书目录（ca、server、client） |

### 修改
| 文件 | 改动 |
|------|------|
| `packages/client-rust/Cargo.toml` | 添加 native-tls、tokio-native-tls |
| `packages/client-rust/src/services/mod.rs` | 注册 auth 模块 |
| `packages/client-rust/src/services/connect/message.rs` | 新增 ServerTls 变体 |
| `packages/client-rust/src/bin/client.rs` | mTLS + 白名单 + 退避 |
| `packages/client-rust/boot.sh` | wss:// + sha256 校验 |
| `packages/client-rust/init.sh` | wss:// + sha256 校验 |
| `examples/xiaozhi/src/server.rs` | mTLS 支持 |
| `examples/migpt/src/server.rs` | mTLS 支持 |
| `examples/gemini/src/server.rs` | mTLS 支持 |
