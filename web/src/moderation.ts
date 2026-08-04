export type ModerationResult = "safe" | "unsafe" | "unavailable";

export async function moderate(ai: Ai, content: string): Promise<ModerationResult> {
  try {
    const res = (await ai.run("@cf/meta/llama-guard-3-8b" as never, {
      messages: [{ role: "user", content }],
    } as never)) as { response?: string };
    const text = (res?.response ?? "").trim().toLowerCase();
    if (text === "safe") return "safe";
    if (text.startsWith("unsafe")) return "unsafe";
    return "unavailable";
  } catch {
    return "unavailable";
  }
}
