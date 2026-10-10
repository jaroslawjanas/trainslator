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
  notes: string;
}

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
    notes: "Some Gemini models can't turn thinking off; set reasoning to 'mandatory' for those.",
  },
  anthropic: {
    label: "Anthropic (OpenAI-compatible endpoint)",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    suggestedKeyEnv: "ANTHROPIC_API_KEY",
    model: {
      structuredOutput: "none",
      maxTokensParam: "max_tokens",
      sendTemperature: false,
      reasoningMode: "optional",
      reasoningTemplates: {
        onEnabled: { thinking: { type: "enabled", budget_tokens: "{{budget}}" } },
        onDisabled: null,
      },
      cacheMarkers: "none",
      cacheMarkerTtl: "5m",
      sendPromptCacheKey: false,
    },
    notes:
      "This endpoint ignores response_format and doesn't do prompt caching. For caching, use Anthropic models through OpenRouter with cache markers.",
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
    notes:
      "Prefix caching is automatic. Cached-token counts are reported only when vLLM runs with --enable-prompt-tokens-details. Some models use the key 'thinking' instead of 'enable_thinking'.",
  },
  ollama: {
    label: "Ollama (local or Ollama Cloud)",
    defaultBaseUrl: "http://localhost:11434/v1",
    suggestedKeyEnv: "OLLAMA_API_KEY",
    model: {
      structuredOutput: "json_schema",
      maxTokensParam: "max_tokens",
      sendTemperature: true,
      reasoningMode: "optional",
      reasoningTemplates: {
        onEnabled: { reasoning_effort: "{{effort}}" },
        onDisabled: { reasoning_effort: "none" },
      },
      cacheMarkers: "none",
      cacheMarkerTtl: "5m",
      sendPromptCacheKey: false,
    },
    notes:
      "For Ollama Cloud use base URL https://ollama.com/v1 with an API key. Reasoning models think by default; the 'reasoning off' template sends reasoning_effort: none. A local Ollama's context size can't be set through this API; long prompts are cut silently unless the model's num_ctx is large enough (Modelfile or OLLAMA_CONTEXT_LENGTH).",
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
    notes: "Use Test connection to find which settings this API accepts.",
  },
};
