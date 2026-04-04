import { jsonEncode } from "@mi-gpt/utils/parse";
import { RustServer } from "./open-xiaoai.js";
import type { ISpeaker } from "@mi-gpt/engine/base";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exit_code: number;
}

/**
 * 清理文本，移除或替换 TTS 无法合成的字符
 * - 移除 emoji
 * - 移除 markdown 格式符号
 * - 移除特殊符号
 */
function cleanTextForTTS(text: string): string {
  if (!text) return "你好";

  return (
    text
      // 移除 emoji (包括常见 Unicode emoji 范围)
      .replace(
        /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F900}-\u{1F9FF}]|[\u{1F018}-\u{1F270}]|[\u{238C}-\u{2454}]|[\u{20D0}-\u{20EF}]|[\u{FE0F}]|[\u{1F000}-\u{1F02F}]|[\u{1F0A0}-\u{1F0FF}]|[\u{1F100}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]|[\u{1F700}-\u{1F77F}]|[\u{1F780}-\u{1F7FF}]|[\u{1F800}-\u{1F8FF}]|[\u{1F900}-\u{1F9FF}]|[\u{1FA00}-\u{1FA6F}]|[\u{1FA70}-\u{1FAFF}]/gu,
        ""
      )
      // 移除 markdown 格式符号
      .replace(/\*\*/g, "") // 粗体 **
      .replace(/\*/g, "") // 斜体 *
      .replace(/__/g, "") // 粗体 __
      .replace(/_/g, "") // 斜体 _
      .replace(/~~/g, "") // 删除线 ~~
      .replace(/`{1,3}/g, "") // 行内代码 ` 和代码块 ```
      .replace(/#{1,6}\s*/g, "") // 标题 #
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // 链接 [text](url) -> text
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, "") // 图片 ![alt](url)
      // 移除分隔线和列表符号
      .replace(/^---$/gm, "") // 分隔线 ---
      .replace(/^[-*+]\s*/gm, "") // 无序列表 - * +
      .replace(/^\d+\.\s*/gm, "") // 有序列表 1. 2.
      // 移除其他特殊符号
      .replace(/[_history=\d+]/g, "") // [_history=18] 这类标记
      .replace(/\|/g, "") // 表格符号 |
      .replace(/>/g, "") // 引用 >
      .replace(/\n{3,}/g, "\n\n") // 多个空行合并为两个
      // 数字和符号转中文（TTS 友好）
      .replace(/(\d+)\s*℃/g, (_, n) => `${numberToChinese(n)}摄氏度`)
      .replace(/(\d+)\s*°C/gi, (_, n) => `${numberToChinese(n)}摄氏度`)
      .replace(/(\d+)\s*%/g, (_, n) => `百分之${numberToChinese(n)}`)
      .replace(/(\d+)\s*km\/h/gi, (_, n) => `每小时${numberToChinese(n)}公里`)
      .replace(/(\d+)-(\d+)/g, (_, a, b) => `${numberToChinese(a)}到${numberToChinese(b)}`)
      .replace(/\d+/g, (n) => numberToChinese(n))
      // 清理多余空白
      .trim()
  );
}

/** 数字转中文口语（如 17 → 十七，2026 → 二零二六） */
function numberToChinese(n: string): string {
  const digits = "零一二三四五六七八九";
  const num = parseInt(n);
  if (isNaN(num)) return n;
  if (num < 0) return `负${numberToChinese(String(-num))}`;
  if (num < 10) return digits[num];
  if (num < 100) {
    const tens = Math.floor(num / 10);
    const ones = num % 10;
    return (tens === 1 ? "十" : digits[tens] + "十") + (ones ? digits[ones] : "");
  }
  if (num < 1000) {
    const h = Math.floor(num / 100);
    const rest = num % 100;
    return digits[h] + "百" + (rest < 10 && rest > 0 ? "零" + digits[rest] : rest > 0 ? numberToChinese(String(rest)) : "");
  }
  if (num < 10000) {
    const t = Math.floor(num / 1000);
    const rest = num % 1000;
    return digits[t] + "千" + (rest < 100 && rest > 0 ? "零" + numberToChinese(String(rest)) : rest > 0 ? numberToChinese(String(rest)) : "");
  }
  // 年份等大数字逐字读
  return n.split("").map(d => digits[parseInt(d)] ?? d).join("");
}

class SpeakerManager implements ISpeaker {
  status: "playing" | "paused" | "idle" = "idle";

  /**
   * 获取播放状态
   */
  async getPlaying(sync = false) {
    if (sync) {
      // 同步远端最新状态
      const res = await this.runShell("mphelper mute_stat");
      if (res?.stdout.includes("1")) {
        this.status = "playing";
      } else if (res?.stdout.includes("2")) {
        this.status = "paused";
      }
    }
    return this.status;
  }

  /**
   * 播放/暂停
   */
  async setPlaying(playing = true) {
    const res = await this.runShell(
      playing ? "mphelper play" : "mphelper pause"
    );
    return res?.stdout.includes('"code": 0');
  }

  /**
   * 播放文字、音频链接、音频流
   */
  async play({
    text,
    url,
    bytes,
    timeout = 10 * 60 * 1000,
    blocking = false,
  }: {
    text?: string;
    url?: string;
    bytes?: Uint8Array;
    /**
     * 超时时长（毫秒）
     *
     * 默认 10 分钟
     */
    timeout?: number;
    /**
     * 是否阻塞运行(仅对播放文字、音频链接有效)
     *
     * 如果是则等到音频播放完毕才会返回
     */
    blocking?: boolean;
  }) {
    if (bytes) {
      return RustServer.on_output_data(bytes) as Promise<boolean>;
    }

    // 清理文本中的特殊字符，确保 TTS 能正常合成
    const cleanedText = text ? cleanTextForTTS(text) : "你好";

    if (blocking) {
      const res = await this.runShell(
        url
          ? `miplayer -f '${url}'`
          : `/usr/sbin/tts_play.sh '${cleanedText}'`,
        { timeout }
      );
      return res?.exit_code === 0;
    }

    const res = await this.runShell(
      url
        ? `ubus call mediaplayer player_play_url '${jsonEncode({
            url: url,
            type: 1,
          })}'`
        : `ubus call mibrain text_to_speech '${jsonEncode({
            text: cleanedText,
            save: 0,
          })}'`,
      { timeout }
    );
    return res?.stdout.includes('"code": 0') ?? false;
  }

  /**
   * （取消）唤醒小爱
   */
  async wakeUp(
    awake = true,
    options?: {
      /**
       * 静默唤醒
       */
      silent: boolean;
    }
  ) {
    const { silent = true } = options ?? {};
    const command = awake
      ? silent
        ? `ubus call pnshelper event_notify '{"src":1,"event":0}'; miplayer -f /data/open-xiaoai/ding.mp3`
        : `ubus call pnshelper event_notify '{"src":0,"event":0}'`
      : `
        ubus call pnshelper event_notify '{"src":3, "event":7}'
        sleep 0.1
        ubus call pnshelper event_notify '{"src":3, "event":8}'
    `;
    const res = await this.runShell(command);
    return res?.stdout.includes('"code": 0');
  }

  /**
   * 把文字指令交给原来的小爱执行
   */
  async askXiaoAI(
    text: string,
    options?: {
      /**
       * 静默执行
       */
      silent: boolean;
    }
  ) {
    const { silent = false } = options ?? {};
    const res = await this.runShell(
      `ubus call mibrain ai_service '${jsonEncode({
        tts: silent ? undefined : 1,
        nlp: 1,
        nlp_text: text,
      })}'`
    );
    return res?.stdout.includes('"code": 0');
  }

  /**
   * 使用 mediaplayer stop 打断 TTS 播放，不会破坏 mico_aivs_lab 的对话状态机
   */
  async abortXiaoAI() {
    const res = await this.runShell(
      "ubus call mediaplayer player_play_operation '{\"action\":\"stop\"}'"
    );
    return res?.stdout.includes('"code": 0');
  }

  /**
   * 获取启动分区
   */
  async getBoot() {
    const res = await this.runShell("echo $(fw_env -g boot_part)");
    return res?.stdout.trim();
  }

  /**
   * 设置启动分区
   */
  async setBoot(boot_part: "boot0" | "boot1") {
    const res = await this.runShell(
      `fw_env -s boot_part ${boot_part} >/dev/null 2>&1 && echo $(fw_env -g boot_part)`
    );
    return res?.stdout.includes(boot_part);
  }

  /**
   * 获取设备型号、序列号信息
   */
  async getDevice() {
    const res = await this.runShell("echo $(micocfg_model) $(micocfg_sn)");
    const info = res?.stdout.trim().split(" ");
    return {
      model: info?.[0] ?? "unknown",
      sn: info?.[1] ?? "unknown",
    };
  }

  /**
   * 获取麦克风状态
   */
  async getMic() {
    const res = await this.runShell(
      "[ ! -f /tmp/mipns/mute ] && echo on || echo off"
    );
    let status: "on" | "off" = "off";
    if (res?.stdout.includes("on")) {
      status = "on";
    }
    return status;
  }

  /**
   * 打开/关闭麦克风
   */
  async setMic(on = true) {
    const res = await this.runShell(
      on
        ? `ubus -t1 -S call pnshelper event_notify '{"src":3, "event":7}' 2>&1`
        : `ubus -t1 -S call pnshelper event_notify '{"src":3, "event":8}' 2>&1`
    );
    return res?.stdout.includes('"code":0');
  }

  /**
   * 执行脚本
   */
  async runShell(
    script: string,
    options?: {
      /**
       * 超时时间（单位：毫秒）
       */
      timeout?: number;
    }
  ): Promise<CommandResult | undefined> {
    const { timeout = 10 * 1000 } = options ?? {};
    try {
      const res = await RustServer.run_shell(script, timeout);
      if (res) {
        return JSON.parse(res);
      }
    } catch (_) {
      return undefined;
    }
  }
}

export const OpenXiaoAISpeaker = new SpeakerManager();
