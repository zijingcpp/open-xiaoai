# Open-XiaoAI 工程概要

## 项目简介

Open-XiaoAI 是一个开源项目，通过刷入补丁固件，直接接管小爱音箱的麦克风（耳朵）和扬声器（嘴巴），借助多模态大模型和 AI Agent 将小爱音箱的潜力完全释放。

支持机型：小爱音箱 Pro（LX06）、Xiaomi 智能音箱 Pro（OH2P）

## 架构概览

项目采用 Client-Server 架构：

```
┌─────────────────┐         WebSocket (ws/wss)        ┌─────────────────┐
│   小爱音箱       │ ◄──────────────────────────────► │   Server 端      │
│   (Client 端)    │    音频流 / 事件 / 指令           │   (云主机/NAS)   │
│                  │                                   │                  │
│  · 麦克风采集    │                                   │  · LLM 对话      │
│  · 音频播放      │                                   │  · 语音识别      │
│  · 事件转发      │                                   │  · 业务逻辑      │
│  · 指令执行      │                                   │  · AI Agent      │
└─────────────────┘                                   └─────────────────┘
     Rust (ARMv7)                                      Node.js / Python
```

- Client 端运行在音箱上，负责音频采集、事件转发和指令执行，不含业务逻辑
- Server 端运行在电脑/云主机/NAS 上，负责 LLM 调用、语音识别等计算密集型任务
- 双端通过 WebSocket 实时双向通信，支持 ws（局域网）和 wss + mTLS（公网）

## 目录结构

```
open-xiaoai/
├── packages/                    # 核心组件
│   ├── client-rust/             # Client 端（Rust）
│   │   ├── src/
│   │   │   ├── bin/             # 可执行文件入口
│   │   │   │   ├── client.rs    #   主程序：WebSocket 连接、音频转发
│   │   │   │   └── monitor.rs   #   监控程序
│   │   │   ├── services/        # 服务模块
│   │   │   │   ├── audio/       #   音频采集与播放
│   │   │   │   ├── connect/     #   WebSocket 通信
│   │   │   │   ├── monitor/     #   状态监控
│   │   │   │   ├── speaker.rs   #   音箱控制（TTS、播放等）
│   │   │   │   └── auth.rs      #   mTLS 认证
│   │   │   └── utils/           # 工具函数
│   │   ├── boot.sh              # 开机自启脚本
│   │   └── init.sh              # 初始化安装脚本
│   │
│   ├── client-patch/            # 补丁固件制作工具
│   │   ├── src/
│   │   │   ├── extract.py       #   固件解包
│   │   │   ├── patch.sh         #   应用补丁
│   │   │   └── squashfs.sh      #   重新打包 squashfs
│   │   └── patches/             #   补丁文件
│   │       ├── 01-ssh.patch     #     开启 SSH
│   │       ├── 02-login.patch   #     修改登录
│   │       ├── 03-ota.patch     #     OTA 控制
│   │       └── 04-start.patch   #     启动脚本
│   │
│   ├── runtime/                 # 开发环境 Docker 镜像
│   │   ├── Dockerfile           #   包含 ARMv7 交叉编译工具链 + Node.js
│   │   └── root.squashfs        #   音箱根文件系统（用于编译链接）
│   │
│   └── flash-tool/              # macOS 刷机工具
│       └── flash                #   刷机脚本
│
├── examples/                    # 示例应用（Server 端）
│   ├── migpt/                   # 接入 MiGPT（Node.js + Rust neon）
│   │   ├── migpt/
│   │   │   ├── xiaoai.ts        #   主引擎：事件处理、对话管理
│   │   │   ├── speaker.ts       #   音箱控制封装
│   │   │   ├── summary.ts       #   对话摘要压缩
│   │   │   └── index.ts         #   入口
│   │   ├── src/server.rs        #   Rust neon 模块（WebSocket Server）
│   │   ├── config.ts            #   LLM 配置
│   │   ├── Dockerfile.deploy    #   部署用 Dockerfile
│   │   └── Dockerfile           #   开发用 Dockerfile
│   │
│   ├── xiaozhi/                 # 接入小智 AI（Python + Rust pyo3）
│   │   ├── xiaozhi/             #   小智 AI 协议实现
│   │   ├── src/server.rs        #   Rust pyo3 模块
│   │   └── config.py            #   配置
│   │
│   ├── gemini/                  # 接入 Gemini Live API（Python + Rust pyo3）
│   │   ├── gemini/              #   Gemini 实时对话
│   │   └── src/server.rs        #   Rust pyo3 模块
│   │
│   ├── kws/                     # 自定义唤醒词（纯 Shell）
│   │   ├── keywords.py          #   唤醒词模型
│   │   └── boot.sh              #   启动脚本
│   │
│   └── stereo/                  # 立体声组网（纯 Rust）
│       └── src/                 #   音频同步与网络发现
│
├── docs/                        # 文档
│   ├── flash.md                 #   刷机教程
│   ├── deploy.md                #   安全部署指南（证书、云主机）
│   ├── debug.md                 #   调试指南
│   └── security-plan.md         #   安全方案
│
└── certs/                       # TLS 证书（本地生成，不提交）
```

## 技术栈

| 组件 | 技术 | 说明 |
|------|------|------|
| Client 端 | Rust | 运行在 ARMv7 音箱上，资源占用极低 |
| Server 端 (migpt) | TypeScript + Rust neon | Node.js 业务逻辑 + Rust 通信模块 |
| Server 端 (xiaozhi/gemini) | Python + Rust pyo3 | Python 业务逻辑 + Rust 通信模块 |
| 通信协议 | WebSocket | 支持 ws（局域网）/ wss + mTLS（公网） |
| 构建工具 | Docker + cross | 交叉编译 ARMv7 二进制 |
| 部署 | Docker | 镜像打包，`--restart unless-stopped` 自动重启 |
| LLM | OpenAI 兼容接口 | 支持 Kimi、DeepSeek、OpenAI 等 |

## 数据流

```
用户说话 → 音箱麦克风 → Client 采集音频
  → WebSocket 转发到 Server
  → 小爱云端语音识别 → 识别结果事件转发到 Server
  → Server 调用 LLM 生成回复
  → Server 下发 TTS/播放指令到 Client
  → Client 调用音箱扬声器播放
```

## 文档索引

| 文档 | 说明 |
|------|------|
| [README.md](../README.md) | 项目介绍与快速开始 |
| [flash.md](flash.md) | 刷机教程 |
| [deploy.md](deploy.md) | 安全部署指南（证书生成、云主机部署） |
| [debug.md](debug.md) | 调试指南（镜像使用、远端部署、问题排查） |
| [security-plan.md](security-plan.md) | 安全方案设计 |
| [client-rust/README.md](../packages/client-rust/README.md) | Client 端编译运行 |
| [client-patch/README.md](../packages/client-patch/README.md) | 补丁固件制作 |
| [runtime/README.md](../packages/runtime/README.md) | 开发环境镜像 |
