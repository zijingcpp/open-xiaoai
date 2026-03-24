import { type EngineConfig, MiGPTEngine } from "@mi-gpt/engine";
import { deepMerge } from "@mi-gpt/utils";
import { jsonDecode } from "@mi-gpt/utils/parse";
import type { Prettify } from "@mi-gpt/utils/typing";
import { RustServer } from "./open-xiaoai.js";
import { OpenXiaoAISpeaker } from "./speaker.js";
import { randomUUID } from "node:crypto";
import { initSummary, summarizeMessages, getSummary, setSummary } from "./summary.js";
import { initMemory, logMessage, getMemoryPrompt } from "./memory.js";

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

    if (config.openai) {
      const llmConfig = {
        baseURL: config.openai.baseURL!,
        apiKey: config.openai.apiKey!,
        model: config.openai.model!,
      };
      initSummary(llmConfig);
      initMemory(llmConfig);
    }

    await super.start(deepMerge(kDefaultOpenXiaoAIConfig, config));
    (global as any).RUST_CALLBACKS = {
      on_event: this.onEvent,
      on_input_data: this.onRecord,
    };
    console.log("✅ 服务已启动...");
    await RustServer.start();
  }

  async onMessage(msg: { text: string; id: string; sender: string; timestamp: number }) {
    this._history.push({ sender: msg.sender, text: msg.text });

    // 记录到每日日志（用于 23:30 持久化）
    logMessage(msg.sender, msg.text);

    // 会话内摘要压缩
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

    // 组装 system prompt：原始 + 持久记忆 + 会话摘要
    const memoryPrompt = getMemoryPrompt();
    const summary = getSummary();
    let system = this._originalSystemPrompt;
    if (memoryPrompt) system += `\n\n${memoryPrompt}`;
    if (summary) system += `\n\n[之前的对话摘要] ${summary}`;
    this.config.prompt = { ...this.config.prompt, system };

    await super.onMessage(msg);
  }

  onEvent = (event: string) => {
    const e = JSON.parse(event);
    if (e.event === "playing") {
      OpenXiaoAISpeaker.status =
        e.data === "Playing"
          ? "playing"
          : e.data === "Paused"
          ? "paused"
          : "idle";
    } else if (e.event === "instruction" && e.data.NewLine) {
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
      console.log("🔥 唤醒词识别", e.data);
    }
  };

  onRecord = (data: Uint8Array) => {
    console.log("🔥 收到录音音频流", data.length);
  };
}

export const OpenXiaoAI = new OpenXiaoAIEngine();
