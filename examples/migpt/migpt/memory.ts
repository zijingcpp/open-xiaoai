import { Memory } from "mem0ai/oss";

let memory: InstanceType<typeof Memory> | null = null;

const USER_ID = "xiaoai-user";

export function initMemory(config: {
  apiKey: string;
  baseURL?: string;
  model?: string;
}) {
  memory = new Memory({
    version: "v1.1",
    llm: {
      provider: "openai",
      config: {
        apiKey: config.apiKey,
        model: config.model || "gpt-4.1-nano",
        openaiBaseUrl: config.baseURL,
      },
    },
    embedder: {
      provider: "openai",
      config: {
        apiKey: config.apiKey,
        model: "text-embedding-3-small",
        // @ts-ignore - baseURL for embedder
        openaiBaseUrl: config.baseURL,
      },
    },
    vectorStore: {
      provider: "memory",
      config: { collectionName: "xiaoai-memories", dimension: 1536 },
    },
    historyDbPath: "/app/data/mem0-history.db",
  });
}

export async function addMemory(
  userText: string,
  assistantText: string
): Promise<void> {
  if (!memory) return;
  try {
    await memory.add(
      [
        { role: "user", content: userText },
        { role: "assistant", content: assistantText },
      ],
      { userId: USER_ID }
    );
  } catch (e) {
    console.error("Mem0 add error:", e);
  }
}

export async function searchMemory(query: string): Promise<string> {
  if (!memory) return "";
  try {
    const results = await memory.search(query, { userId: USER_ID });
    const memories = (results as any)?.results || results;
    if (!Array.isArray(memories) || memories.length === 0) return "";
    return memories
      .slice(0, 5)
      .map((m: any) => m.memory)
      .join("; ");
  } catch (e) {
    console.error("Mem0 search error:", e);
    return "";
  }
}
