use std::sync::LazyLock;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AudioConfig {
    pub pcm: String,
    pub channels: u16,
    pub bits_per_sample: u16,
    pub sample_rate: u32,
    pub period_size: u32,
    pub buffer_size: u32,
}

pub static AUDIO_CONFIG: LazyLock<AudioConfig> = LazyLock::new(|| AudioConfig {
    pcm: "noop".into(),
    channels: 1,
    bits_per_sample: 16,
    sample_rate: 16000,
    // 增加缓冲区大小以避免音频播放时漏掉前面的内容
    // period_size 从 160 增加到 1024
    // buffer_size 从 480 增加到 4096
    period_size: 1024,
    buffer_size: 4096,
});

const PCM_WHITELIST: &[&str] = &["noop", "default"];

impl AudioConfig {
    pub fn validate(&self) -> Result<(), String> {
        if !PCM_WHITELIST.iter().any(|&p| p == self.pcm) {
            return Err(format!("pcm '{}' not allowed", self.pcm));
        }
        if self.channels < 1 || self.channels > 2 {
            return Err(format!("channels {} out of range [1,2]", self.channels));
        }
        if self.bits_per_sample != 16 && self.bits_per_sample != 32 {
            return Err(format!("bits_per_sample {} not in [16,32]", self.bits_per_sample));
        }
        if self.sample_rate < 8000 || self.sample_rate > 48000 {
            return Err(format!("sample_rate {} out of range [8000,48000]", self.sample_rate));
        }
        if self.period_size < 1 || self.period_size > 65536 {
            return Err(format!("period_size {} out of range", self.period_size));
        }
        if self.buffer_size < 1 || self.buffer_size > 65536 {
            return Err(format!("buffer_size {} out of range", self.buffer_size));
        }
        Ok(())
    }
}
