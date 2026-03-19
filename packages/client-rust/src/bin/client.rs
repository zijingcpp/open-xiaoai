use open_xiaoai::services::audio::config::AudioConfig;
use open_xiaoai::services::auth::create_tls_connector;
use open_xiaoai::services::monitor::kws::KwsMonitor;
use serde_json::json;
use std::path::Path;
use std::time::Duration;
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
            // mTLS 连接
            let connector = create_tls_connector(&client_p12, &ca_crt)?;
            let (ws_stream, _) = connect_async_tls_with_config(
                url,
                None,
                false,
                Some(tokio_tungstenite::Connector::NativeTls(connector)),
            ).await?;
            Ok(WsStream::Client(ws_stream))
        } else {
            // 普通 ws:// 连接（向后兼容）
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

        self.instruction_monitor
            .start(|event| async move {
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
