use open_xiaoai::services::audio::config::AudioConfig;
use open_xiaoai::services::auth::create_tls_connector;
use open_xiaoai::services::monitor::kws::KwsMonitor;
use serde_json::json;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::LazyLock;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::sleep;
use tokio_tungstenite::{connect_async, connect_async_tls_with_config};

use open_xiaoai::base::AppError;
use open_xiaoai::base::VERSION;
use open_xiaoai::services::audio::play::AudioPlayer;
use open_xiaoai::services::audio::record::AudioRecorder;
use open_xiaoai::services::connect::data::{Event, Request, Response, Stream};
use open_xiaoai::services::connect::handler::MessageHandler;
use open_xiaoai::services::connect::message::{MessageManager, WsStream};
use open_xiaoai::services::connect::rpc::RPC;
use open_xiaoai::services::monitor::instruction::InstructionMonitor;
use open_xiaoai::services::monitor::playing::PlayingMonitor;

/// run_shell 命令白名单前缀
const SHELL_WHITELIST: &[&str] = &[
    "mphelper",
    "miplayer",
    "/usr/sbin/tts_play.sh",
    "ubus call mediaplayer",
    "ubus call mibrain",
    "ubus call pnshelper",
    "fw_env",
    "micocfg_",
    "/etc/init.d/mico_aivs_lab",
    "echo $(fw_env",
    "echo $(micocfg_",
    "[ ! -f /tmp/mipns/mute ]",
];

const CERTS_DIR: &str = "/data/open-xiaoai/certs";

/// TTS 队列：tts_play.sh 命令入队立即返回，后台串行执行
/// generation 用于打断：abortXiaoAI 时递增，消费端跳过旧 generation 的命令
static TTS_GEN: AtomicU64 = AtomicU64::new(0);
/// TTS_PENDING 计数器：记录队列中待播放的 TTS 数量
static TTS_PENDING: AtomicUsize = AtomicUsize::new(0);
/// 拦截原生 NLP 回复：当为 true 时，Client 端检测到 NLP TTS 指令会立刻 mediaplayer stop
static BLOCK_NLP: AtomicBool = AtomicBool::new(false);

/// 获取当前时间字符串 (HH:MM:SS.mmm)
fn now_str() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap();
    let secs = now.as_secs();
    let ms = now.subsec_millis();
    let hours = (secs / 3600) % 24;
    let mins = (secs / 60) % 60;
    let secs = secs % 60;
    format!("{:02}:{:02}:{:02}.{:03}", hours, mins, secs, ms)
}

static TTS_TX: LazyLock<mpsc::Sender<(u64, String)>> = LazyLock::new(|| {
    let (tx, mut rx) = mpsc::channel::<(u64, String)>(32);
    tokio::spawn(async move {
        while let Some((gen, script)) = rx.recv().await {
            let pending = TTS_PENDING.load(Ordering::Relaxed);
            println!("[{}] 📢 TTS队列: 开始播放, gen={}, pending={}", now_str(), gen, pending);
            if gen < TTS_GEN.load(Ordering::Relaxed) {
                let pending_after = TTS_PENDING.fetch_sub(1, Ordering::Relaxed) - 1;
                println!("[{}] ⏭️ TTS队列: 跳过(已打断), pending={}", now_str(), pending_after);
                continue;
            }
            let start = std::time::Instant::now();
            let _ = open_xiaoai::utils::shell::run_shell(&script).await;
            let elapsed = start.elapsed().as_millis();
            let prev = TTS_PENDING.fetch_sub(1, Ordering::Relaxed);
            let pending_after = prev - 1;
            println!("[{}] ✅ TTS队列: 播放完成, 耗时{}ms, pending={}->{}",
                now_str(), elapsed, prev, pending_after);
            if prev == 1 {
                println!("[{}] 📤 TTS队列: 发送tts_finished事件", now_str());
                let _ = MessageManager::instance()
                    .send_event("tts_finished", None)
                    .await;
            }
        }
    });
    tx
});

struct AppClient {
    kws_monitor: KwsMonitor,
    instruction_monitor: InstructionMonitor,
    playing_monitor: PlayingMonitor,
}

impl AppClient {
    pub fn new() -> Self {
        Self {
            kws_monitor: KwsMonitor::new(),
            instruction_monitor: InstructionMonitor::new(),
            playing_monitor: PlayingMonitor::new(),
        }
    }

    pub async fn connect(&self, url: &str) -> Result<WsStream, AppError> {
        let client_p12 = format!("{}/client.p12", CERTS_DIR);
        let ca_crt = format!("{}/ca.crt", CERTS_DIR);

        if url.starts_with("wss://") && Path::new(&client_p12).exists() && Path::new(&ca_crt).exists() {
            let connector = create_tls_connector(&client_p12, &ca_crt)?;
            let (ws_stream, _) = connect_async_tls_with_config(
                url,
                None,
                false,
                Some(tokio_tungstenite::Connector::NativeTls(connector)),
            ).await?;
            Ok(WsStream::Client(ws_stream))
        } else {
            let (ws_stream, _) = connect_async(url).await?;
            Ok(WsStream::Client(ws_stream))
        }
    }

    pub async fn run(&mut self) {
        let url = std::env::args().nth(1).expect("❌ 请输入服务器地址");
        println!("✅ 已启动");

        let mut retry_delay = Duration::from_secs(1);
        let max_delay = Duration::from_secs(60);

        loop {
            let Ok(ws_stream) = self.connect(&url).await else {
                eprintln!("❌ 连接失败，{}秒后重试", retry_delay.as_secs());
                sleep(retry_delay).await;
                retry_delay = (retry_delay * 2).min(max_delay);
                continue;
            };
            println!("✅ 已连接: {:?}", url);
            retry_delay = Duration::from_secs(1);

            self.init(ws_stream).await;
            if let Err(e) = MessageManager::instance().process_messages().await {
                eprintln!("❌ 消息处理异常: {}", e);
            }
            self.dispose().await;
            eprintln!("❌ 已断开连接");
        }
    }

    async fn init(&mut self, ws_stream: WsStream) {
        MessageManager::instance().init(ws_stream).await;
        MessageHandler::<Event>::instance()
            .set_handler(on_event)
            .await;
        MessageHandler::<Stream>::instance()
            .set_handler(on_stream)
            .await;

        let rpc = RPC::instance();
        rpc.add_command("get_version", get_version).await;
        rpc.add_command("run_shell", run_shell).await;
        rpc.add_command("start_play", start_play).await;
        rpc.add_command("stop_play", stop_play).await;
        rpc.add_command("start_recording", start_recording).await;
        rpc.add_command("stop_recording", stop_recording).await;
        rpc.add_command("set_block_nlp", set_block_nlp).await;

        self.instruction_monitor
            .start(|event| async move {
                // 本地拦截：BLOCK_NLP 开启时，检测到 NLP TTS 立刻 mediaplayer stop
                if BLOCK_NLP.load(Ordering::Relaxed) {
                    if let open_xiaoai::services::monitor::file::FileMonitorEvent::NewLine(ref line) = event {
                        if (line.contains("\"namespace\":\"Nlp\"") && line.contains("\"name\":\"StartStream\""))
                            || (line.contains("\"namespace\":\"SpeechSynthesizer\"") && line.contains("\"name\":\"Speak\""))
                        {
                            println!("[{}] 🚫 BLOCK_NLP: 检测到原生NLP回复，立刻打断", now_str());
                            let _ = open_xiaoai::utils::shell::run_shell(
                                "ubus call mediaplayer player_play_operation '{\"action\":\"stop\"}'"
                            ).await;
                        }
                    }
                }
                MessageManager::instance()
                    .send_event("instruction", Some(json!(event)))
                    .await
            })
            .await;

        self.playing_monitor
            .start(|event| async move {
                MessageManager::instance()
                    .send_event("playing", Some(json!(event)))
                    .await
            })
            .await;

        self.kws_monitor
            .start(|event| async move {
                MessageManager::instance()
                    .send_event("kws", Some(json!(event)))
                    .await
            })
            .await;
    }

    async fn dispose(&mut self) {
        MessageManager::instance().dispose().await;
        let _ = AudioPlayer::instance().stop().await;
        let _ = AudioRecorder::instance().stop_recording().await;
        self.instruction_monitor.stop().await;
        self.playing_monitor.stop().await;
        self.kws_monitor.stop().await;
    }
}

async fn get_version(_: Request) -> Result<Response, AppError> {
    let data = json!(VERSION.to_string());
    Ok(Response::from_data(data))
}

async fn start_play(request: Request) -> Result<Response, AppError> {
    let config = request
        .payload
        .and_then(|payload| serde_json::from_value::<AudioConfig>(payload).ok());
    if let Some(ref c) = config {
        c.validate().map_err(|e| -> AppError { e.into() })?;
    }
    AudioPlayer::instance().start(config).await?;
    Ok(Response::success())
}

async fn stop_play(_: Request) -> Result<Response, AppError> {
    AudioPlayer::instance().stop().await?;
    Ok(Response::success())
}

async fn start_recording(request: Request) -> Result<Response, AppError> {
    let config = request
        .payload
        .and_then(|payload| serde_json::from_value::<AudioConfig>(payload).ok());
    if let Some(ref c) = config {
        c.validate().map_err(|e| -> AppError { e.into() })?;
    }
    AudioRecorder::instance()
        .start_recording(
            |bytes| async {
                MessageManager::instance()
                    .send_stream("record", bytes, None)
                    .await
            },
            config,
        )
        .await?;
    Ok(Response::success())
}

async fn stop_recording(_: Request) -> Result<Response, AppError> {
    AudioRecorder::instance().stop_recording().await?;
    Ok(Response::success())
}

async fn set_block_nlp(request: Request) -> Result<Response, AppError> {
    let enabled = match request.payload {
        Some(payload) => serde_json::from_value::<bool>(payload)?,
        _ => return Err("missing bool payload".into()),
    };
    BLOCK_NLP.store(enabled, Ordering::Relaxed);
    println!("[{}] {} BLOCK_NLP = {}", now_str(), if enabled { "🚫" } else { "✅" }, enabled);
    Ok(Response::success())
}

fn is_shell_allowed(script: &str) -> bool {
    let trimmed = script.trim();
    SHELL_WHITELIST.iter().any(|prefix| trimmed.starts_with(prefix))
}

async fn run_shell(request: Request) -> Result<Response, AppError> {
    let script = match request.payload {
        Some(payload) => serde_json::from_value::<String>(payload)?,
        _ => return Err("empty command".into()),
    };

    if !is_shell_allowed(&script) {
        eprintln!("⛔ 拒绝执行命令: {}", script);
        return Err(format!("command not allowed: {}", script).into());
    }

    let trimmed = script.trim();

    // abortXiaoAI: 递增 generation 使队列中待播放的 TTS 失效，并重置计数器
    if trimmed.contains("mediaplayer") && trimmed.contains("stop") {
        println!("[{}] 🔄 mediaplayer stop, TTS gen递增", now_str());
        TTS_GEN.fetch_add(1, Ordering::Relaxed);
        TTS_PENDING.store(0, Ordering::Relaxed);
    }

    // tts_play.sh: 入队立即返回，后台串行播放
    if trimmed.starts_with("/usr/sbin/tts_play.sh") {
        let gen = TTS_GEN.load(Ordering::Relaxed);
        let pending = TTS_PENDING.fetch_add(1, Ordering::Relaxed) + 1;
        println!("[{}] 📥 TTS队列: 收到指令, gen={}, pending={}", now_str(), gen, pending);
        let _ = TTS_TX.send((gen, script)).await;
        let res = json!({"exit_code": 0, "stdout": "", "stderr": ""});
        return Ok(Response::from_data(res));
    }

    let res = open_xiaoai::utils::shell::run_shell(script.as_str()).await?;
    Ok(Response::from_data(json!(res)))
}

async fn on_event(event: Event) -> Result<(), AppError> {
    println!("🔥 收到事件: {:?}", event);
    Ok(())
}

async fn on_stream(stream: Stream) -> Result<(), AppError> {
    let Stream { tag, bytes, .. } = stream;
    if tag.as_str() == "play" {
        let _ = AudioPlayer::instance().play(bytes).await;
    }
    Ok(())
}

#[tokio::main]
async fn main() {
    AppClient::new().run().await;
}
