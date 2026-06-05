import type { LlmProviderConfig, SettingsResponse } from "../services/tauri/settings";

/** Mirror of backend `model_supports_vision` in chat_turn.rs. */
export function modelSupportsVision(provider: string, model: string): boolean {
  const m = model.toLowerCase();
  const p = provider.toLowerCase();
  if (p === "openai" || p.includes("openai")) {
    return (
      m.includes("gpt-4o") ||
      m.includes("gpt-4-vision") ||
      m.includes("gpt-4-turbo") ||
      m.includes("o1") ||
      m.includes("o3") ||
      m.includes("o4")
    );
  }
  if (p === "anthropic" || p.includes("claude") || m.includes("claude")) {
    return (
      m.includes("claude-3") ||
      m.includes("claude-4") ||
      m.includes("claude-opus") ||
      m.includes("claude-sonnet") ||
      m.includes("claude-haiku")
    );
  }
  if (p === "qwen" || p === "tongyi" || p.includes("qwen")) {
    return (
      m.includes("qwen-vl") ||
      m.includes("qwen2-vl") ||
      m.includes("qwen2.5-vl") ||
      m.includes("qwen3-vl") ||
      m.includes("qvq") ||
      m.includes("qwen-omni") ||
      m.includes("vl") ||
      m.includes("vision")
    );
  }
  if (p === "kimi" || p === "moonshot") {
    return m.includes("vision") || m.includes("vl");
  }
  if (p === "zhipu") {
    return m.includes("vision") || m.includes("vl") || m.includes("glm-4v");
  }
  if (p === "minimax") {
    return m.includes("vision") || m.includes("vl");
  }
  return false;
}

export function resolveActiveProvider(
  settings: SettingsResponse,
  modelId: string,
): { provider: string; model: string } {
  if (modelId) {
    const found = settings.llm_providers?.find((p) => p.id === modelId);
    if (found) return { provider: found.provider, model: found.model };
  }
  return { provider: settings.provider, model: settings.model };
}

export function visionCapable(
  settings: SettingsResponse,
  modelId: string,
  providers?: LlmProviderConfig[],
): boolean {
  if (settings.vision_enabled) return true;
  const { provider, model } = resolveActiveProvider(
    { ...settings, llm_providers: providers ?? settings.llm_providers },
    modelId,
  );
  return modelSupportsVision(provider, model);
}
