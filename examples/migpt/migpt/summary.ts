import OpenAILib from "openai";

let conversationSummary = "";
let summaryClient: OpenAILib | null = null;
let summaryModel = "";

const SUMMARIZE_PROMPT = `请将以下对话内容压缩为一段简短的摘要，保留关键信息（用户偏好、重要事实、待办事项等），去掉闲聊和重复内容。摘要不超过200字。只输出摘要，不要解释。`;

export function initSummary(config: { baseURL: string; apiKey: string; model: string }) {
  summaryClient = new OpenAILib({ baseURL: config.baseURL, apiKey: config.apiKey });
  summaryModel = config.model;
}

/**
 * 对一组消息生成摘要
 */
export async function summarizeMessages(
  messages: { sender: string; text: string }[]
): Promise<string> {
  if (!summaryClient || messages.length === 0) return "";
  const text = messages.map((m) => `${m.sender}: ${m.text}`).join("\n");
  try {
    const res = await summaryClient.chat.completions.create({
      model: summaryModel,
      messages: [
        { role: "system", content: SUMMARIZE_PROMPT },
        { role: "user", content: text },
      ],
    });
    return res.choices[0]?.message?.content || "";
  } catch (e) {
    console.error("摘要生成失败:", e);
    return "";
  }
}

export function getSummary(): string {
  return conversationSummary;
}

export function setSummary(s: string) {
  conversationSummary = s;
}
