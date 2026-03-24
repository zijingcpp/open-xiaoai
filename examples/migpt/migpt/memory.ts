import { readFileSync, writeFileSync, existsSync } from "node:fs";
import OpenAILib from "openai";

const MEMORY_PATH = "/app/data/user-memory.json";

const EXTRACT_PROMPT = `你是一个记忆管理助手。根据今天的对话内容和已有的用户记忆，输出更新后的用户事实列表。

规则：
1. 提取用户的偏好、习惯、家庭信息、重要事实
2. 如果新对话修正了旧记忆，更新对应条目
3. 如果某条旧记忆被明确否定，删除它
4. 忽略闲聊、天气查询等无持久价值的内容
5. 每条事实用一个 key（英文标识）和 value（中文描述）表示

已有记忆：
{existing}

今天的对话：
{conversations}

请输出 JSON 数组，格式：[{"key": "xxx", "value": "xxx"}]
只输出 JSON，不要解释。`;

interface Fact {
  key: string;
  value: string;
  updated: string;
}

interface MemoryData {
  facts: Fact[];
  lastSummaryDate: string;
}

let client: OpenAILib | null = null;
let model = "";
let todayLog: { sender: string; text: string }[] = [];
let timer: ReturnType<typeof setInterval> | null = null;

export function initMemory(config: { baseURL: string; apiKey: string; model: string }) {
  client = new OpenAILib({ baseURL: config.baseURL, apiKey: config.apiKey });
  model = config.model;
  startScheduler();
}

function loadMemory(): MemoryData {
  if (!existsSync(MEMORY_PATH)) return { facts: [], lastSummaryDate: "" };
  try {
    return JSON.parse(readFileSync(MEMORY_PATH, "utf-8"));
  } catch {
    return { facts: [], lastSummaryDate: "" };
  }
}

function saveMemory(data: MemoryData) {
  writeFileSync(MEMORY_PATH, JSON.stringify(data, null, 2), "utf-8");
}

/** 记录一条对话 */
export function logMessage(sender: string, text: string) {
  todayLog.push({ sender, text });
}

/** 读取记忆，拼成注入 system prompt 的文本 */
export function getMemoryPrompt(): string {
  const { facts } = loadMemory();
  if (facts.length === 0) return "";
  return `[用户画像] ${facts.map((f) => f.value).join("；")}`;
}

/** 每日提取持久化 */
async function extractAndSave() {
  if (!client || todayLog.length === 0) return;

  const today = new Date().toISOString().slice(0, 10);
  const mem = loadMemory();
  if (mem.lastSummaryDate === today) return;

  const existing = mem.facts.length > 0
    ? mem.facts.map((f) => `${f.key}: ${f.value}`).join("\n")
    : "无";
  const conversations = todayLog.map((m) => `${m.sender}: ${m.text}`).join("\n");

  const prompt = EXTRACT_PROMPT
    .replace("{existing}", existing)
    .replace("{conversations}", conversations);

  try {
    const res = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
    });
    const content = res.choices[0]?.message?.content || "";
    const match = content.match(/\[[\s\S]*\]/);
    if (!match) return;

    const newFacts: { key: string; value: string }[] = JSON.parse(match[0]);
    const factMap = new Map(mem.facts.map((f) => [f.key, f]));
    for (const f of newFacts) {
      factMap.set(f.key, { key: f.key, value: f.value, updated: today });
    }

    saveMemory({ facts: Array.from(factMap.values()), lastSummaryDate: today });
    todayLog = [];
    console.log(`🧠 每日记忆已更新，共 ${factMap.size} 条`);
  } catch (e) {
    console.error("记忆提取失败:", e);
  }
}

function startScheduler() {
  if (timer) return;
  timer = setInterval(() => {
    const now = new Date();
    if (now.getHours() === 23 && now.getMinutes() === 30) {
      extractAndSave();
    }
  }, 60_000);
}
