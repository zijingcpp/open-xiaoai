import { type EngineConfig, MiGPTEngine } from "@mi-gpt/engine";
import { deepMerge } from "@mi-gpt/utils";
import { jsonDecode } from "@mi-gpt/utils/parse";
import type { Prettify } from "@mi-gpt/utils/typing";
import { RustServer } from "./open-xiaoai.js";
import { OpenXiaoAISpeaker } from "./speaker.js";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 获取 engine 内部使用的 ChatBot 单例（ESM 模块缓存）
const _engineDir = dirname(fileURLToPath(import.meta.resolve("@mi-gpt/engine")));
const _chatModule = await import(join(_engineDir, "../../../@mi-gpt/chat/dist/index.js"));
const ChatBot = _chatModule.ChatBot as { config: { prompt: { system: string } } };
import { initSummary, summarizeMessages, getSummary, setSummary } from "./summary.js";
import { initMemory, logMessage, getMemoryPrompt, clearMemory } from "./memory.js";

export type OpenXiaoAIConfig = Prettify<EngineConfig<OpenXiaoAIEngine> & {
  /** ASR 防抖延迟（毫秒），等待用户说完再提交给 LLM，默认 800 */
  asrDebounceMs?: number;
}>;

const kDefaultOpenXiaoAIConfig: OpenXiaoAIConfig = {
  //
};

class OpenXiaoAIEngine extends MiGPTEngine {
  speaker = OpenXiaoAISpeaker;
  private _originalSystemPrompt = "";
  private _history: { sender: string; text: string }[] = [];
  private _maxHistory = 10;
  private _msgLock = Promise.resolve();
  private _continuous = false;
  private _continuousTimer: ReturnType<typeof setTimeout> | null = null;
  private _originalKeywords: string[] = [];
  private _continuousTimeout = 60_000;
  private _ttsFinishedResolve: (() => void) | null = null;
  private _ttsFinishedPromise: Promise<void> | null = null;
  private _shouldExit = false;
  private _waitTTSStartTime: number = 0;

  private async _waitForTTSFinished(timeoutMs = 120_000): Promise<void> {
    this._waitTTSStartTime = Date.now();
    console.log(`[${new Date().toISOString()}] ⏳ 开始等待 TTS 完成 (超时${timeoutMs}ms)`);
    this._ttsFinishedPromise = new Promise((resolve) => {
      this._ttsFinishedResolve = resolve;
    });
    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<void>((_, reject) => {
      timer = setTimeout(() => {
        console.log(`[${new Date().toISOString()}] ⚠️ 等待 TTS 完成超时，已等待${Date.now() - this._waitTTSStartTime}ms`);
        reject(new Error("timeout"));
      }, timeoutMs);
    });
    try {
      await Promise.race([this._ttsFinishedPromise, timeoutPromise]);
      console.log(`[${new Date().toISOString()}] ✅ TTS等待完成，总耗时${Date.now() - this._waitTTSStartTime}ms`);
    } catch { /* 超时 */ }
    clearTimeout(timer!);
    this._ttsFinishedResolve = null;
    this._ttsFinishedPromise = null;
  }

  private _exitContinuous() {
    this._continuous = false;
    if (this._continuousTimer) { clearTimeout(this._continuousTimer); this._continuousTimer = null; }
    this.config.callAIKeywords = this._originalKeywords;
    RustServer.set_block_nlp?.(false)?.catch?.(() => {});
    // 释放可能还在等待的 _waitForTTSFinished
    if (this._ttsFinishedResolve) this._ttsFinishedResolve();
    console.log(`[${new Date().toISOString()}] 🔇 退出连续对话模式`);
  }

  private _resetContinuousTimer() {
    if (this._continuousTimer) clearTimeout(this._continuousTimer);
    this._continuousTimer = setTimeout(() => this._exitContinuous(), this._continuousTimeout);
  }

  private _enterContinuous() {
    if (!this._continuous) {
      this._continuous = true;
      this._originalKeywords = this.config.callAIKeywords ?? [];
      console.log(`[${new Date().toISOString()}] 🎙️ 进入连续对话模式`);
    }
    this.config.callAIKeywords = [""];
  }

  async start(config: OpenXiaoAIConfig) {
    this._originalSystemPrompt = config.prompt?.system || "";
    this._maxHistory = config.context?.historyMaxLength || 10;
    this._ASR_DEBOUNCE_MS = config.asrDebounceMs ?? 800;

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
    this._startDebugServer();
    await RustServer.start();
  }

  async onMessage(msg: { text: string; id: string; sender: string; timestamp: number }) {
    console.log(`[${new Date().toISOString()}] 📨 onMessage开始 id=${msg.id.slice(0,8)} text="${msg.text.slice(0,30)}" _continuous=${this._continuous}`);

    if (/清(除|空|理)记忆/.test(msg.text)) {
      clearMemory();
      setSummary("");
      this._history = [];
      if (this._continuous) this._exitContinuous();
      await this.speaker.play({ text: "记忆已清空" });
      return;
    }

    if (this._continuous && /^(退出|关闭|停止)$/.test(msg.text)) {
      this._exitContinuous();
      await this.speaker.play({ text: "好的，有需要再叫我" });
      return;
    }

    if (this._continuous) {
      this._resetContinuousTimer();
    }

    // 组装 system prompt：原始 + 持久记忆 + 会话摘要
    const memoryPrompt = getMemoryPrompt();
    const summary = getSummary();
    let system = this._originalSystemPrompt;
    if (memoryPrompt) system += `\n\n${memoryPrompt}`;
    if (summary) system += `\n\n[之前的对话摘要] ${summary}`;
    console.log(`[${new Date().toISOString()}] 🧠 记忆=${memoryPrompt ? memoryPrompt.slice(0,50) + '...' : '无'} 摘要=${summary ? summary.slice(0,50) + '...' : '无'}`);
    this.config.prompt = { ...this.config.prompt, system };
    if (ChatBot.config?.prompt) ChatBot.config.prompt.system = system;

    const historyBefore = this._history.length;
    await super.onMessage(msg);
    const triggered = this._history.length > historyBefore;

    if (triggered) {
      console.log(`[${new Date().toISOString()}] 🔄 检测到LLM触发，准备进入连续对话流程`);
      this._enterContinuous();
      await this._waitForTTSFinished();

      if (this._shouldExit) {
        this._shouldExit = false;
        console.log(`[${new Date().toISOString()}] 🚪 LLM 返回 [EXIT]，退出连续对话`);
        this._exitContinuous();
      } else {
        await new Promise(r => setTimeout(r, 500));
        await this.speaker.wakeUp(true, { silent: true });
        this._resetContinuousTimer();
      }
    }

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
    console.log(`[${new Date().toISOString()}] 📨 onMessage结束 id=${msg.id.slice(0,8)}`);
  }

  async askAI(msg: { text: string; id: string; sender: string; timestamp: number }) {
    this._history.push({ sender: msg.sender, text: msg.text });
    logMessage(msg.sender, msg.text);
    console.log(`🔥 ${msg.text} [_history=${this._history.length}]`);

    RustServer.set_block_nlp?.(true)?.catch?.(() => {});

    console.log(`[${new Date().toISOString()}] 🤖 开始调用 LLM`);
    console.log(`[${new Date().toISOString()}] 📋 system prompt (${ChatBot.config?.prompt?.system?.length ?? 0}字): ...${ChatBot.config?.prompt?.system?.slice(-80)}`);
    const reply = await super.askAI(msg);
    console.log(`[${new Date().toISOString()}] 🤖 LLM stream 已建立`);

    if (this._continuous) {
      await this.speaker.abortXiaoAI();
    }

    if (reply.stream) {
      const origRead = reply.stream.read.bind(reply.stream);
      let fullText = "";
      let recorded = false;
      reply.stream.read = () => {
        const result = origRead();
        if (result.next) {
          // 检测并移除 [EXIT] 标记
          if (result.next.includes("[EXIT]")) {
            this._shouldExit = true;
            result.next = result.next.replace(/\s*\[EXIT\]\s*/g, "");
          }
          if (result.next) {
            console.log(`[${new Date().toISOString()}] 📝 分句: ${result.next.slice(0, 40)}`);
            fullText += result.next;
          }
        }
        if (!result.next && result.noMore && fullText && !recorded) {
          recorded = true;
          this._history.push({ sender: "assistant", text: fullText });
          console.log(`🔊 ${fullText.slice(0, 80)} [_history=${this._history.length}]`);
          logMessage("assistant", fullText);
        }
        return result;
      };
    }

    return reply;
  }

  private _pendingText = "";
  private _pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private _ASR_DEBOUNCE_MS = 800;

  private _flushPendingText() {
    if (!this._pendingText) return;
    const text = this._pendingText;
    this._pendingText = "";
    this._pendingTimer = null;
    this._msgLock = this._msgLock.then(() =>
      this.onMessage({
        text,
        id: randomUUID(),
        sender: "user",
        timestamp: Date.now(),
      }).catch(e => console.error("❌ onMessage 异常:", e))
    );
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
        line?.header?.name === "RecognizeResult"
      ) {
        if (this._continuous) {
          this.speaker.abortXiaoAI().catch(() => {});
        }
        if (line?.payload?.is_final && line?.payload?.results?.[0]?.text) {
          const text = line.payload.results[0].text;
          this._pendingText = this._pendingText ? this._pendingText + text : text;
          if (this._pendingTimer) clearTimeout(this._pendingTimer);
          this._pendingTimer = setTimeout(() => this._flushPendingText(), this._ASR_DEBOUNCE_MS);
        }
      }
    } else if (e.event === "kws") {
      console.log("🔥 唤醒词识别", e.data);
      if (this._continuous) this._exitContinuous();
      RustServer.set_block_nlp?.(false)?.catch?.(() => {});
    } else if (e.event === "tts_finished") {
      const elapsed = this._waitTTSStartTime ? Date.now() - this._waitTTSStartTime : 0;
      console.log(`[${new Date().toISOString()}] 📥 收到tts_finished事件 (等待已耗时${elapsed}ms)`);
      if (this._ttsFinishedResolve) {
        this._ttsFinishedResolve();
      }
    }
  };

  onRecord = (data: Uint8Array) => {
    console.log("🔥 收到录音音频流", data.length);
  };

  private _startDebugServer() {
    import("node:http").then(({ createServer }) => {
      createServer((req, res) => {
        const url = new URL(req.url!, `http://${req.headers.host}`);
        const text = url.searchParams.get("text");
        if (!text) { res.writeHead(400); res.end("missing ?text="); return; }
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`ok: ${text}`);
        this.onMessage({ text, id: randomUUID(), sender: "user", timestamp: Date.now() });
      }).listen(4400, "127.0.0.1", () => console.log("🔧 调试接口: http://127.0.0.1:4400/?text=你好"));
    });
  }
}

export const OpenXiaoAI = new OpenXiaoAIEngine();
