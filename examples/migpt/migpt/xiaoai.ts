import { type EngineConfig, MiGPTEngine } from "@mi-gpt/engine";
import { deepMerge } from "@mi-gpt/utils";
import { jsonDecode } from "@mi-gpt/utils/parse";
import type { Prettify } from "@mi-gpt/utils/typing";
import { RustServer } from "./open-xiaoai.js";
import { OpenXiaoAISpeaker } from "./speaker.js";
import { randomUUID } from "node:crypto";
import { initSummary, summarizeMessages, getSummary, setSummary } from "./summary.js";

export type OpenXiaoAIConfig = Prettify<EngineConfig<OpenXiaoAIEngine>>;

const kDefaultOpenXiaoAIConfig: OpenXiaoAIConfig = {
  //
};

class OpenXiaoAIEngine extends MiGPTEngine {
  speaker = OpenXiaoAISpeaker;
  private _originalSystemPrompt = "";
  private _history: { sender: string; text: string }[] = [];
  private _maxHistory = 10;

  async start(config: OpenXiaoAIConfig) {
    this._originalSystemPrompt = config.prompt?.system || "";
    this._maxHistory = config.context?.historyMaxLength || 10;

    // 初始化摘要用的 LLM client
    if (config.openai) {
      initSummary({
        baseURL: config.openai.baseURL!,
        apiKey: config.openai.apiKey!,
        model: config.openai.model!,
      });
    }

    await super.start(deepMerge(kDefaultOpenXiaoAIConfig, config));
    // 注册全局回调函数
    (global as any).RUST_CALLBACKS = {
      on_event: this.onEvent,
      on_input_data: this.onRecord,
    };
    // 启动服务
    console.log("✅ 服务已启动...");
    await RustServer.start();
  }

  /**
   * 重写 onMessage，注入摘要上下文
   */
  async onMessage(msg: { text: string; id: string; sender: string; timestamp: number }) {
    // 记录历史用于摘要
    this._history.push({ sender: msg.sender, text: msg.text });

    // 历史满时，压缩前半部分为摘要
    if (this._history.length >= this._maxHistory) {
      const half = Math.floor(this._history.length / 2);
      const old = this._history.slice(0, half);
      this._history = this._history.slice(half);

      const prevSummary = getSummary();
      const input = prevSummary
        ? [{ sender: "system", text: `之前的摘要: ${prevSummary}` }, ...old]
        : old;
      const summary = await summarizeMessages(input);
      if (summary) {
        setSummary(summary);
        console.log(`📝 对话摘要已更新: ${summary}`);
      }
    }

    // 注入摘要到 system prompt
    const summary = getSummary();
    this.config.prompt = {
      ...this.config.prompt,
      system: summary
        ? `${this._originalSystemPrompt}\n\n[之前的对话摘要] ${summary}`
        : this._originalSystemPrompt,
    };

    await super.onMessage(msg);
  }

  /**
   * 收到事件
   */
  onEvent = (event: string) => {
    const e = JSON.parse(event);
    if (e.event === "playing") {
      // 更新播放状态
      OpenXiaoAISpeaker.status =
        e.data === "Playing"
          ? "playing"
          : e.data === "Paused"
          ? "paused"
          : "idle";
    } else if (e.event === "instruction" && e.data.NewLine) {
      // 收到语音识别结果
      const line = jsonDecode(e.data.NewLine);
      if (
        line?.header?.namespace === "SpeechRecognizer" &&
        line?.header?.name === "RecognizeResult" &&
        line?.payload?.is_final &&
        line?.payload?.results?.[0]?.text
      ) {
        const text = line.payload.results[0].text;
        this.onMessage({
          text,
          id: randomUUID(),
          sender: "user",
          timestamp: Date.now(),
        });
      }
    } else if (e.event === "kws") {
      const keyword = e.data;
      console.log("🔥 唤醒词识别", keyword);
    }
  };

  /**
   * 收到录音音频流
   */
  onRecord = (data: Uint8Array) => {
    console.log("🔥 收到录音音频流", data.length);
  };
}

export const OpenXiaoAI = new OpenXiaoAIEngine();
