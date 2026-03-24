import { type EngineConfig, MiGPTEngine } from "@mi-gpt/engine";
import { deepMerge } from "@mi-gpt/utils";
import { jsonDecode } from "@mi-gpt/utils/parse";
import type { Prettify } from "@mi-gpt/utils/typing";
import { RustServer } from "./open-xiaoai.js";
import { OpenXiaoAISpeaker } from "./speaker.js";
import { randomUUID } from "node:crypto";
import { initSummary, summarizeMessages, getSummary, setSummary } from "./summary.js";
import { initMemory, logMessage, getMemoryPrompt, clearMemory } from "./memory.js";

export type OpenXiaoAIConfig = Prettify<EngineConfig<OpenXiaoAIEngine>>;

const kDefaultOpenXiaoAIConfig: OpenXiaoAIConfig = {
  //
};

class OpenXiaoAIEngine extends MiGPTEngine {
  speaker = OpenXiaoAISpeaker;
  private _originalSystemPrompt = "";
  private _history: { sender: string; text: string }[] = [];
  private _maxHistory = 10;
  private _msgLock = Promise.resolve();

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
    // 指令拦截：清除记忆
    if (/清(除|空|理)记忆/.test(msg.text)) {
      clearMemory();
      setSummary("");
      this._history = [];
      await this.speaker.play({ text: "记忆已清空" });
      return;
    }

    // 组装 system prompt：原始 + 持久记忆 + 会话摘要
    const memoryPrompt = getMemoryPrompt();
    const summary = getSummary();
    let system = this._originalSystemPrompt;
    if (memoryPrompt) system += `\n\n${memoryPrompt}`;
    if (summary) system += `\n\n[之前的对话摘要] ${summary}`;
    this.config.prompt = { ...this.config.prompt, system };

    // 调用引擎（内部判断是否触发 LLM）
    await super.onMessage(msg);

    // 摘要压缩（仅当有足够历史时）
    if (this._history.length >= this._maxHistory) {
      console.log(`📝 触发摘要压缩: _history=${this._history.length}, threshold=${this._maxHistory}`);
      const half = Math.floor(this._history.length / 2);
      const old = this._history.slice(0, half);
      this._history = this._history.slice(half);

      const prevSummary = getSummary();
      const input = prevSummary
        ? [{ sender: "system", text: `之前的摘要: ${prevSummary}` }, ...old]
        : old;
      const newSummary = await summarizeMessages(input);
      if (newSummary) {
        setSummary(newSummary);
        console.log(`📝 对话摘要已更新: ${newSummary}`);
      }
    }
  }

  async askAI(msg: { text: string; id: string; sender: string; timestamp: number }) {
    // 只有触发 LLM 的消息才记录到历史和每日日志
    this._history.push({ sender: msg.sender, text: msg.text });
    logMessage(msg.sender, msg.text);
    console.log(`🔥 ${msg.text} [_history=${this._history.length}]`);

    const reply = await super.askAI(msg);

    // 监听流式回复，收集完整文本
    if (reply.stream) {
      const origRead = reply.stream.read.bind(reply.stream);
      let fullText = "";
      reply.stream.read = () => {
        const result = origRead();
        if (result.next) fullText += result.next;
        if (result.noMore && fullText) {
          this._history.push({ sender: "assistant", text: fullText });
          console.log(`🔊 ${fullText.slice(0, 50)} [_history=${this._history.length}]`);
          logMessage("assistant", fullText);
        }
        return result;
      };
    }

    return reply;
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
        this._msgLock = this._msgLock.then(() =>
          this.onMessage({
            text,
            id: randomUUID(),
            sender: "user",
            timestamp: Date.now(),
          }).catch(e => console.error("❌ onMessage 异常:", e))
        );
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
