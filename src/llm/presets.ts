import type { ConnectionKind, Model } from "../shared/schemas/settings.ts";

export type ModelCapabilities = Pick<
  Model,
  | "structuredOutput"
  | "maxTokensParam"
  | "sendTemperature"
  | "reasoningMode"
  | "reasoningTemplates"
  | "cacheMarkers"
  | "cacheMarkerTtl"
  | "sendPromptCacheKey"
>;

export interface KindPreset {
  label: string;
  defaultBaseUrl: string;
  suggestedKeyEnv: string | null;
  model: ModelCapabilities;
  /** Starting context window and output limit for new models of this kind. */
  limits: { contextWindow: number; maxOutputTokens: number };
  notes: string;
}

const DEFAULT_LIMITS = { contextWindow: 128_000, maxOutputTokens: 16_000 };

/**
 * Starting values per connection kind. Everything here can be changed per
 * model in the settings; "Test connection" checks and adjusts them.
 */
export const KIND_PRESETS: Record<ConnectionKind, KindPreset> = {
  openai: {
    label: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    suggestedKeyEnv: "OPENAI_API_KEY",
    model: {
      structuredOutput: "json_schema",
      maxTokensParam: "max_completion_tokens",
      sendTemperature: false,
      reasoningMode: "optional",
      reasoningTemplates: { onEnabled: { reasoning_effort: "{{effort}}" }, onDisabled: null },
      cacheMarkers: "none",
      cacheMarkerTtl: "5m",
      sendPromptCacheKey: true,
    },
    limits: DEFAULT_LIMITS,
    notes:
      'Prompt caching is automatic. Reasoning models default to some reasoning; to turn it down, set the \'reasoning off\' template to {"reasoning_effort": "minimal"} or "none".',
  },
  openrouter: {
    label: "OpenRouter",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    suggestedKeyEnv: "OPENROUTER_API_KEY",
    model: {
      structuredOutput: "json_schema",
      maxTokensParam: "max_tokens",
      sendTemperature: true,
      reasoningMode: "optional",
      reasoningTemplates: {
        onEnabled: { reasoning: { effort: "{{effort}}", exclude: true } },
        onDisabled: null,
      },
      cacheMarkers: "none",
      cacheMarkerTtl: "5m",
      sendPromptCacheKey: true,
    },
    limits: DEFAULT_LIMITS,
    notes:
      'For Anthropic and Gemini models, set cache markers to \'anthropic\' to enable prompt caching. To turn reasoning off on reasoning models, use {"reasoning": {"effort": "none"}}.',
  },
  deepseek: {
    label: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    suggestedKeyEnv: "DEEPSEEK_API_KEY",
    model: {
      structuredOutput: "json_object",
      maxTokensParam: "max_tokens",
      sendTemperature: true,
      reasoningMode: "on_by_default",
      reasoningTemplates: {
        onEnabled: { thinking: { type: "enabled" } },
        onDisabled: { thinking: { type: "disabled" } },
      },
      cacheMarkers: "none",
      cacheMarkerTtl: "5m",
      sendPromptCacheKey: false,
    },
    limits: DEFAULT_LIMITS,
    notes:
      "Supports JSON mode but not JSON schemas; the schema is described in the prompt instead.",
  },
  gemini: {
    label: "Google Gemini (OpenAI-compatible)",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    suggestedKeyEnv: "GEMINI_API_KEY",
    model: {
      structuredOutput: "json_schema",
      maxTokensParam: "max_tokens",
      sendTemperature: false,
      reasoningMode: "on_by_default",
      reasoningTemplates: {
        onEnabled: { reasoning_effort: "{{effort}}" },
        onDisabled: { reasoning_effort: "none" },
      },
      cacheMarkers: "none",
      cacheMarkerTtl: "5m",
      sendPromptCacheKey: false,
    },
    limits: DEFAULT_LIMITS,
    notes: "Some Gemini models can't turn thinking off; set reasoning to 'mandatory' for those.",
  },
  anthropic: {
    label: "Anthropic",
    defaultBaseUrl: "https://api.anthropic.com",
    suggestedKeyEnv: "ANTHROPIC_API_KEY",
    model: {
      structuredOutput: "json_schema",
      maxTokensParam: "max_tokens",
      sendTemperature: false,
      // Current Claude models think by default; "off" sends nothing, so each
      // model uses its own default (some can't turn thinking off at all).
      reasoningMode: "on_by_default",
      reasoningTemplates: {
        onEnabled: { thinking: { type: "adaptive" }, output_config: { effort: "{{effort}}" } },
        onDisabled: null,
      },
      cacheMarkers: "anthropic",
      cacheMarkerTtl: "5m",
      sendPromptCacheKey: false,
    },
    limits: { contextWindow: 1_000_000, maxOutputTokens: 64_000 },
    notes:
      "Anthropic's own Messages API: JSON-schema output, prompt caching on the stable parts of each request, and adaptive thinking with an effort level (low, medium, high, xhigh or max). The base URL only changes for a proxy.",
  },
  vllm: {
    label: "vLLM / SGLang / llama.cpp server",
    defaultBaseUrl: "http://localhost:8000/v1",
    suggestedKeyEnv: null,
    model: {
      structuredOutput: "json_schema",
      maxTokensParam: "max_tokens",
      sendTemperature: true,
      reasoningMode: "optional",
      reasoningTemplates: {
        onEnabled: { chat_template_kwargs: { enable_thinking: true } },
        onDisabled: { chat_template_kwargs: { enable_thinking: false } },
      },
      cacheMarkers: "none",
      cacheMarkerTtl: "5m",
      sendPromptCacheKey: false,
    },
    limits: DEFAULT_LIMITS,
    notes:
      "Prefix caching is automatic. Cached-token counts are reported only when vLLM runs with --enable-prompt-tokens-details. Some models use the key 'thinking' instead of 'enable_thinking'.",
  },
  ollama: {
    label: "Ollama on this computer",
    defaultBaseUrl: "http://localhost:11434",
    suggestedKeyEnv: null,
    model: {
      structuredOutput: "json_schema",
      maxTokensParam: "max_tokens",
      sendTemperature: true,
      reasoningMode: "optional",
      reasoningTemplates: {
        onEnabled: { think: true },
        onDisabled: { think: false },
      },
      cacheMarkers: "none",
      cacheMarkerTtl: "5m",
      sendPromptCacheKey: false,
    },
    limits: { contextWindow: 32_768, maxOutputTokens: 8_192 },
    notes:
      "Ollama's own API. Trainslator asks Ollama for the model's context window (num_ctx), so long prompts aren't cut; Ollama needs memory to match, so set the context window to what your machine can handle. For gpt-oss models, change the 'reasoning on' template to {\"think\": \"{{effort}}\"}.",
  },
  ollama_cloud: {
    label: "Ollama Cloud",
    defaultBaseUrl: "https://ollama.com",
    suggestedKeyEnv: "OLLAMA_API_KEY",
    model: {
      structuredOutput: "json_schema",
      maxTokensParam: "max_tokens",
      sendTemperature: true,
      reasoningMode: "optional",
      reasoningTemplates: {
        onEnabled: { think: true },
        onDisabled: { think: false },
      },
      cacheMarkers: "none",
      cacheMarkerTtl: "5m",
      sendPromptCacheKey: false,
    },
    limits: DEFAULT_LIMITS,
    notes:
      "Ollama's own API on ollama.com, with a key from ollama.com/settings/keys. Use the model names Ollama lists (e.g. gpt-oss:120b), without a :cloud suffix.",
  },
  custom: {
    label: "Other OpenAI-compatible API",
    defaultBaseUrl: "http://localhost:8080/v1",
    suggestedKeyEnv: null,
    model: {
      structuredOutput: "json_object",
      maxTokensParam: "max_tokens",
      sendTemperature: true,
      reasoningMode: "optional",
      reasoningTemplates: { onEnabled: null, onDisabled: null },
      cacheMarkers: "none",
      cacheMarkerTtl: "5m",
      sendPromptCacheKey: false,
    },
    limits: DEFAULT_LIMITS,
    notes: "Use Test connection to find which settings this API accepts.",
  },
};
