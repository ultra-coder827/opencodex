import { agentRouterDefaultHeaders } from "../agentrouter";
import { openaiChatCompletionsUrl } from "../openai-chat-url";
import type { OcxProviderConfig } from "../../types";

// Providers may opt into stripping one trailing "[...]" group from the wire model id.
// Z.AI needs this because its OpenAI path rejects glm-5.2[1m] with 400 code 1211;
// unflagged OpenAI-compatible providers and the Anthropic adapter keep ids verbatim.
export function stripBracketedModelSuffix(modelId: string): string {
  const suffixEnd = modelId.trimEnd().length;
  if (suffixEnd === 0 || modelId[suffixEnd - 1] !== "]") return modelId;

  let suffixStart = -1;
  for (let i = suffixEnd - 2; i >= 0 && modelId[i] !== "]"; i--) {
    if (modelId[i] === "[") suffixStart = i;
  }
  return suffixStart === -1 ? modelId : modelId.slice(0, suffixStart);
}

import {
  isOpenCodeZenFreeRequest,
  resolveOpenCodeFreeUrl,
  applyOpenCodeFreeHeaders,
  transformOpenCodeFreeChatBody,
} from "../../providers/opencode-free-fingerprint";
import { applyGithubCopilotContextTier } from "../../providers/github-copilot-context";

export function openAIChatTransport(provider: OcxProviderConfig, modelId?: string): {
  url: string;
  headers: Record<string, string>;
  hasCredential: boolean;
} {
  const isOpenCodeFree = isOpenCodeZenFreeRequest(provider, modelId);
  const hasCredential = (typeof provider.apiKey === "string" && provider.apiKey.trim().length > 0) || isOpenCodeFree;
  if ((provider.authMode === "key" || provider.authMode === "oauth") && !provider.keyOptional && !hasCredential) {
    throw new Error(`${provider.adapter} requires a non-empty credential (authMode: ${provider.authMode})`);
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...agentRouterDefaultHeaders(provider.baseUrl, provider.headers),
  };
  if (hasCredential && provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  if (provider.headers) Object.assign(headers, provider.headers);
  // A configured relative path wins, mirroring how the Responses adapter honours
  // `responsesPath`. An upstream can serve both wires under different prefixes, and a
  // per-model wire override only swaps the adapter, so without this the opted-in Chat
  // request would be sent to the Responses base with `/chat/completions` appended.
  let url = provider.chatCompletionsPath === undefined
    ? openaiChatCompletionsUrl(provider.baseUrl)
    : `${provider.baseUrl.replace(/\/$/, "")}${provider.chatCompletionsPath}`;

  if (isOpenCodeFree) {
    url = resolveOpenCodeFreeUrl(url);
    Object.assign(headers, applyOpenCodeFreeHeaders(headers));
  }

  return { url, headers, hasCredential };
}

export function applyOpenAIChatWireBodyModifiers(
  body: Record<string, unknown>,
  provider: OcxProviderConfig,
  modelId: string,
  providerName?: string,
): unknown {
  let modified = body;
  if (isOpenCodeZenFreeRequest({ ...provider, providerName }, modelId)) {
    modified = transformOpenCodeFreeChatBody(modified);
  }
  return applyGithubCopilotContextTier(modified, provider, modelId, providerName);
}

export function isNativeOpenAIChatTarget(provider: OcxProviderConfig): boolean {
  try {
    return new URL(provider.baseUrl).hostname === "api.openai.com";
  } catch {
    return false;
  }
}
