import { describe, expect, test } from "bun:test";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import {
  OPENCODE_ZEN_OBSERVED_RPM_HINT,
  OPENCODE_ZEN_SYNTHETIC_RETRY_AFTER_SEC,
  enrichOpenCodeZenRateLimitMessage,
  enrichOpenCodeZenUpstreamMessage,
  isTransientConsoleGoUploadRejection,
  isOpenCodeZenRateLimitProvider,
} from "../../src/providers/opencode-zen-rate-limit";
import { resolveClientRetryAfter } from "../../src/lib/retry-after";
import { safeConfigDTO } from "../../src/server/auth-cors";
import type { OcxConfig } from "../../src/types";

describe("opencode-zen rate-limit guidance (#1145)", () => {
  test("registry note documents the observed short-window RPM", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "opencode-zen");
    expect(entry?.note).toBeDefined();
    expect(entry!.note!.toLowerCase()).toContain("15-20");
    expect(entry!.note!.toLowerCase()).toContain("retry-after");
    expect(entry!.note!.toLowerCase()).toMatch(/may return|when retry-after is omitted/);
  });

  test("safeConfigDTO surfaces the registry note for a saved opencode-zen row", () => {
    const dto = safeConfigDTO({
      port: 10100,
      hostname: "127.0.0.1",
      defaultProvider: "opencode-zen",
      providers: {
        "opencode-zen": {
          adapter: "openai-chat",
          baseUrl: "https://opencode.ai/zen/v1",
          authMode: "key",
          apiKey: "zen-key",
        },
      },
    } as OcxConfig) as {
      providers: Record<string, { note?: string }>;
    };

    expect(dto.providers["opencode-zen"].note?.toLowerCase()).toContain("15-20");
  });

  test("isOpenCodeZenRateLimitProvider matches zen and destination aliases", () => {
    expect(isOpenCodeZenRateLimitProvider({ providerName: "opencode-zen" })).toBe(true);
    expect(isOpenCodeZenRateLimitProvider({ providerName: "openai" })).toBe(false);
    expect(isOpenCodeZenRateLimitProvider({
      baseUrl: "https://opencode.ai/zen/v1",
      adapter: "openai-chat",
    })).toBe(true);
    expect(isOpenCodeZenRateLimitProvider({
      baseUrl: "https://opencode.ai/zen/go/v1",
      adapter: "openai-chat",
    })).toBe(false);
  });

  test("enrichOpenCodeZenRateLimitMessage adds guidance and a parseable retry hint", () => {
    const enriched = enrichOpenCodeZenRateLimitMessage(
      "Provider error 429: Rate limit exceeded. Please try again later.",
      { status: 429, providerName: "opencode-zen", hasApiKey: true },
    );
    expect(enriched).toContain(OPENCODE_ZEN_OBSERVED_RPM_HINT);
    expect(enriched).toContain(`Try again in ${OPENCODE_ZEN_SYNTHETIC_RETRY_AFTER_SEC}s`);
    expect(enriched).toContain("retryOn429");
    expect(resolveClientRetryAfter({
      status: 429,
      message: enriched,
    })).toBe(String(OPENCODE_ZEN_SYNTHETIC_RETRY_AFTER_SEC));
  });

  test("explicit rate-limit types receive guidance without matching message text", () => {
    const enriched = enrichOpenCodeZenUpstreamMessage("Too Many Requests", {
      status: 429, providerName: "opencode-zen", upstreamErrorType: "rate_limit_error",
    });
    expect(enriched).toContain("Try again in 15s");
    expect(resolveClientRetryAfter({ status: 429, message: enriched })).toBe("15");
  });

  test("rate limits mentioning a plan or load balancer still receive guidance", () => {
    for (const message of ["Rate limit exceeded for credit-based plan", "load balancer rate limit", "balanced throughput"]) {
      expect(enrichOpenCodeZenUpstreamMessage(message, {
        status: 429, providerName: "opencode-zen", upstreamErrorType: "rate_limit_error",
      })).toContain("Try again in 15s");
    }
  });

  test("quota errors never receive short-window pacing guidance", () => {
    for (const [upstreamErrorType, message] of [
      ["insufficient_quota", "Rate limit exceeded"],
      ["rate_limit_error", "Monthly quota exceeded; rate limit exceeded"],
      ["insufficient_quota", "Too Many Requests"],
      ["rate_limit_error", "Rate limit exceeded: insufficient credit"],
      ["rate_limit_error", "Rate limit exceeded: balance exhausted"],
      ["billing_error", "Too Many Requests"],
      ["rate_limit_error", "The usage limit has been reached"],
      ["usage_limit_reached", "Too Many Requests"],
    ]) {
      expect(enrichOpenCodeZenUpstreamMessage(message!, {
        status: 429, providerName: "opencode-zen", upstreamErrorType,
      })).toBe(message!);
    }
  });

  test("structured quota and billing codes suppress pacing guidance", () => {
    for (const upstreamErrorCode of ["insufficient_quota", "billing_hard_limit_reached", "usage_limit_reached"]) {
      expect(enrichOpenCodeZenUpstreamMessage("Rate limit exceeded", {
        status: 429, providerName: "opencode-zen", upstreamErrorType: "rate_limit_error", upstreamErrorCode,
      })).toBe("Rate limit exceeded");
    }
  });

  test("enrichOpenCodeZenRateLimitMessage skips synthetic hint when upstream Retry-After is set", () => {
    const enriched = enrichOpenCodeZenRateLimitMessage(
      "Provider error 429: Rate limit exceeded.",
      {
        status: 429,
        providerName: "opencode-zen",
        hasApiKey: true,
        upstreamRetryAfter: "120",
      },
    );
    expect(enriched).toContain(OPENCODE_ZEN_OBSERVED_RPM_HINT);
    expect(enriched).not.toContain(`Try again in ${OPENCODE_ZEN_SYNTHETIC_RETRY_AFTER_SEC}s`);
    expect(resolveClientRetryAfter({
      status: 429,
      message: enriched,
      upstreamRetryAfter: "120",
    })).toBe("120");
  });

  test("enrichOpenCodeZenRateLimitMessage omits retryOn429 tip on keyless or non-HTTP routes", () => {
    const keyless = enrichOpenCodeZenRateLimitMessage(
      "Provider error 429: Rate limit exceeded.",
      { status: 429, providerName: "opencode-zen", hasApiKey: false },
    );
    expect(keyless).toContain("Slow the request pace.");
    expect(keyless).not.toContain("retryOn429");

    const runTurn = enrichOpenCodeZenRateLimitMessage(
      "Provider error 429: Rate limit exceeded.",
      {
        status: 429,
        providerName: "opencode-zen",
        hasApiKey: true,
        supportsHttpSameKeyRetry: false,
      },
    );
    expect(runTurn).not.toContain("retryOn429");
  });

  test("enrichOpenCodeZenRateLimitMessage is a no-op for other providers and non-429s", () => {
    const other = "Provider error 429: Rate limit exceeded. Please try again later.";
    expect(enrichOpenCodeZenRateLimitMessage(other, {
      status: 429,
      providerName: "openrouter",
    })).toBe(other);
    expect(enrichOpenCodeZenRateLimitMessage("Provider error 500: boom", {
      status: 500,
      providerName: "opencode-zen",
    })).toBe("Provider error 500: boom");
  });

  test("enrichOpenCodeZenRateLimitMessage does not double-append", () => {
    const once = enrichOpenCodeZenRateLimitMessage(
      "Provider error 429: Rate limit exceeded.",
      { status: 429, providerName: "opencode-zen", hasApiKey: true },
    );
    expect(enrichOpenCodeZenRateLimitMessage(once, {
      status: 429,
      providerName: "opencode-zen",
      hasApiKey: true,
    })).toBe(once);
  });
});

describe("Console Go transient upload refusal", () => {
  // The observed Go-route refusal, byte-for-byte as Console serves it.
  const GO_MESSAGE = "Error from provider (Console Go): Upstream request failed: [invalid_request_error] Invalid upload request.";
  // The Zen key route names the same gateway without the Go suffix.
  const ZEN_MESSAGE = "Error from provider (Console): Upstream request failed: [invalid_request_error] Invalid upload request.";
  const envelope = (message: string) => JSON.stringify({ model: "muse-spark-1.3-contributor", error: { param: null, type: "invalid_request_error", message } });
  const GO_ROUTE = { outboundUrl: "https://opencode.ai/zen/go/v1/responses" };
  const ZEN_ROUTE = { outboundUrl: "https://opencode.ai/zen/v1/responses" };

  test("accepts the canonical refusal on both canonical Console routes", () => {
    expect(isTransientConsoleGoUploadRejection({ status: 400, errorBody: envelope(GO_MESSAGE), ...GO_ROUTE })).toBe(true);
    expect(isTransientConsoleGoUploadRejection({ status: 400, errorBody: envelope(ZEN_MESSAGE), ...ZEN_ROUTE })).toBe(true);
    // A custom row pointed at the same destination is still Console: the base URL decides.
    expect(isTransientConsoleGoUploadRejection({ status: 400, errorBody: envelope(GO_MESSAGE), outboundUrl: "https://opencode.ai/zen/go/v1/responses" })).toBe(true);
  });

  test("rejects the refusal text from a non-Console route", () => {
    expect(isTransientConsoleGoUploadRejection({ status: 400, errorBody: envelope(GO_MESSAGE), outboundUrl: "https://api.deepseek.com/v1/responses" })).toBe(false);
    // opencode.ai without the /zen segment is not the Console gateway.
    expect(isTransientConsoleGoUploadRejection({ status: 400, errorBody: envelope(GO_MESSAGE), outboundUrl: "https://opencode.ai/v1/responses" })).toBe(false);
    expect(isTransientConsoleGoUploadRejection({ status: 400, errorBody: envelope(GO_MESSAGE) })).toBe(false);
  });

  test("requires the effective canonical HTTPS endpoint", () => {
    const userInfoUrl = new URL("https://opencode.ai/zen/go/v1/responses");
    userInfoUrl.username = "fixture-user";
    userInfoUrl.password = "fixture-password";
    expect(isTransientConsoleGoUploadRejection({ status: 400, errorBody: envelope(GO_MESSAGE), outboundUrl: userInfoUrl.href })).toBe(false);
    for (const outboundUrl of [
      "http://opencode.ai/zen/go/v1/responses",
      "https://opencode.ai:8443/zen/go/v1/responses",
      "https://opencode.ai/zen/go/v1/responses?tenant=fixture",
      "https://opencode.ai/zen/go/v1/responses#fragment",
      "https://opencode.ai.evil.test/zen/go/v1/responses",
      "https://opencode.ai/zen-other/v1/responses",
      "https://opencode.ai/zen/go/v1/models",
    ]) expect(isTransientConsoleGoUploadRejection({ status: 400, errorBody: envelope(GO_MESSAGE), outboundUrl })).toBe(false);
  });

  test("rejects noncanonical envelopes, suffixes, and other statuses", () => {
    // A bare string is not the structured envelope.
    expect(isTransientConsoleGoUploadRejection({ status: 400, errorBody: JSON.stringify({ error: "Invalid upload request." }), ...GO_ROUTE })).toBe(false);
    // A suffix means the gateway said something else; do not guess.
    expect(isTransientConsoleGoUploadRejection({ status: 400, errorBody: envelope(GO_MESSAGE + " Please retry."), ...GO_ROUTE })).toBe(false);
    // Different status: only the gateway 400 is the flap.
    expect(isTransientConsoleGoUploadRejection({ status: 500, errorBody: envelope(GO_MESSAGE), ...GO_ROUTE })).toBe(false);
    expect(isTransientConsoleGoUploadRejection({ status: 400, errorBody: undefined, ...GO_ROUTE })).toBe(false);
    // Other 400s on the same wire are verdicts on the request, not flaps.
    expect(isTransientConsoleGoUploadRejection({
      status: 400,
      errorBody: envelope("Error from provider (Console Go): Upstream request failed: [invalid_request_error] reasoning_effort max requires an active Muse Code subscription for model muse-spark-1.3-contributor."),
      ...GO_ROUTE,
    })).toBe(false);
    expect(isTransientConsoleGoUploadRejection({
      status: 400,
      errorBody: JSON.stringify({ type: "error", error: { type: "MissingSessionID", message: "Request is missing x-opencode-session" } }),
      ...GO_ROUTE,
    })).toBe(false);
  });

  test("rejects partial envelopes and padded messages", () => {
    const withError = (error: unknown) => JSON.stringify({ model: "muse-spark-1.3-contributor", error });
    // type carries the refusal identity; a partial envelope is a different error.
    expect(isTransientConsoleGoUploadRejection({ status: 400, errorBody: withError({ param: null, message: GO_MESSAGE }), ...GO_ROUTE })).toBe(false);
    expect(isTransientConsoleGoUploadRejection({ status: 400, errorBody: withError({ param: null, type: "server_error", message: GO_MESSAGE }), ...GO_ROUTE })).toBe(false);
    // param must be present and null.
    expect(isTransientConsoleGoUploadRejection({ status: 400, errorBody: withError({ type: "invalid_request_error", message: GO_MESSAGE }), ...GO_ROUTE })).toBe(false);
    expect(isTransientConsoleGoUploadRejection({ status: 400, errorBody: withError({ param: "input", type: "invalid_request_error", message: GO_MESSAGE }), ...GO_ROUTE })).toBe(false);
    // Padding means the gateway wrapped or appended something.
    expect(isTransientConsoleGoUploadRejection({ status: 400, errorBody: withError({ param: null, type: "invalid_request_error", message: " " + GO_MESSAGE }), ...GO_ROUTE })).toBe(false);
    expect(isTransientConsoleGoUploadRejection({ status: 400, errorBody: withError({ param: null, type: "invalid_request_error", message: GO_MESSAGE + "\n" }), ...GO_ROUTE })).toBe(false);
    // The exact canonical envelope still matches.
    expect(isTransientConsoleGoUploadRejection({ status: 400, errorBody: envelope(GO_MESSAGE), ...GO_ROUTE })).toBe(true);
  });
});

import {
  isOpenCodeZenFreeModel,
  isOpenCodeZenFreeRequest,
  generateOpenCodeSessionId,
  getStableOpenCodeSessionId,
  resolveOpenCodeFreeUrl,
  applyOpenCodeFreeHeaders,
  transformOpenCodeFreeChatBody,
  restoreOpenCodeFreeToolName,
  OPENCODE_REQUIRED_TOOLS_CHAT,
} from "../../src/providers/opencode-free-fingerprint";
import { openAIChatTransport } from "../../src/adapters/openai-chat/wire";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import { parseRequest } from "../../src/responses/parser";

describe("OpenCode Zen Free-Tier Attestation & Transformation", () => {
  test("identifies free models correctly", () => {
    expect(isOpenCodeZenFreeModel("big-pickle")).toBe(true);
    expect(isOpenCodeZenFreeModel("deepseek-v4-flash-free")).toBe(true);
    expect(isOpenCodeZenFreeModel("mimo-v2.6-flash-free")).toBe(true);
    expect(isOpenCodeZenFreeModel("muse-spark-1.2-contributor-free")).toBe(true);
    expect(isOpenCodeZenFreeModel("opencode-zen/big-pickle")).toBe(true);
    expect(isOpenCodeZenFreeModel("opencode-zen/deepseek-v4-flash-free")).toBe(true);

    expect(isOpenCodeZenFreeModel("claude-sonnet-5-5")).toBe(false);
    expect(isOpenCodeZenFreeModel("gpt-5-preview")).toBe(false);
    expect(isOpenCodeZenFreeModel(undefined)).toBe(false);
  });

  test("identifies free requests for opencode-zen", () => {
    const zenConfig = {
      providerName: "opencode-zen",
      baseUrl: "https://opencode.ai/zen/v1",
      authMode: "key" as const,
    };
    expect(isOpenCodeZenFreeRequest(zenConfig, "deepseek-v4-flash-free")).toBe(true);
    expect(isOpenCodeZenFreeRequest(zenConfig, "big-pickle")).toBe(true);
    expect(isOpenCodeZenFreeRequest(zenConfig, "claude-sonnet-5-5")).toBe(false);

    const otherProvider = {
      providerName: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      authMode: "key" as const,
    };
    expect(isOpenCodeZenFreeRequest(otherProvider, "deepseek-v4-flash-free")).toBe(false);
  });

  test("generates valid OpenCode descending session IDs", () => {
    const id = generateOpenCodeSessionId();
    expect(id).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(id.length).toBe(30);

    const stableId = getStableOpenCodeSessionId();
    expect(stableId).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(getStableOpenCodeSessionId()).toBe(stableId);
  });

  test("resolves free model URLs to /inference/v1", () => {
    expect(resolveOpenCodeFreeUrl("https://opencode.ai/zen/v1/chat/completions"))
      .toBe("https://opencode.ai/inference/v1/chat/completions");
    expect(resolveOpenCodeFreeUrl("https://opencode.ai/zen/v1/responses"))
      .toBe("https://opencode.ai/inference/v1/responses");
    expect(resolveOpenCodeFreeUrl("https://opencode.ai/zen/v1/messages"))
      .toBe("https://opencode.ai/inference/v1/messages");
    expect(resolveOpenCodeFreeUrl("https://api.openai.com/v1/chat/completions"))
      .toBe("https://api.openai.com/v1/chat/completions");
  });

  test("applies OpenCode v2 client headers and removes x-opencode-request", () => {
    const headers = applyOpenCodeFreeHeaders({
      "Content-Type": "application/json",
      "Authorization": "Bearer oc_sk_user_key",
      "x-opencode-request": "req_12345",
    });

    expect(headers["Authorization"]).toBe("Bearer public");
    expect(headers["User-Agent"]).toBe("opencode/latest/2.0.26/cli");
    expect(headers["x-opencode-client"]).toBe("cli");
    expect(headers["x-opencode-project"]).toBe("global");
    expect(headers["x-opencode-session"]).toMatch(/^ses_/);
    expect(headers["x-opencode-session-id"]).toBe(headers["x-opencode-session"]);
    expect(headers["x-session-affinity"]).toBe(headers["x-opencode-session"]);
    expect(headers["x-session-id"]).toBe(headers["x-opencode-session"]);
    expect(headers["x-opencode-request"]).toBeUndefined();
  });

  test("openAIChatTransport automatically routes free models without requiring an API key", () => {
    const zen = {
      baseUrl: "https://opencode.ai/zen/v1",
      adapter: "openai-chat",
      authMode: "key" as const,
      // No apiKey configured!
    };

    const transport = openAIChatTransport(zen, "deepseek-v4-flash-free");
    expect(transport.url).toBe("https://opencode.ai/inference/v1/chat/completions");
    expect(transport.headers["Authorization"]).toBe("Bearer public");
    expect(transport.headers["User-Agent"]).toBe("opencode/latest/2.0.26/cli");
    expect(transport.hasCredential).toBe(true);
  });

  test("transformOpenCodeFreeChatBody injects required tools and stream: true", () => {
    const transformed = transformOpenCodeFreeChatBody({
      model: "deepseek-v4-flash-free",
      messages: [
        { role: "system", content: "You are an assistant." },
        { role: "user", content: "Hello" },
      ],
      stream: false,
      tool_choice: "none",
    });

    expect(transformed.stream).toBe(true);
    expect(transformed.tool_choice).toBe("auto");
    expect(Array.isArray(transformed.tools)).toBe(true);
    const tools = transformed.tools as any[];
    expect(tools.length).toBe(OPENCODE_REQUIRED_TOOLS_CHAT.length);
    expect(tools.some(t => t.function.name === "read")).toBe(true);
    expect(tools.some(t => t.function.name === "bash")).toBe(true);
    expect(tools.some(t => t.function.name === "glob")).toBe(true);
    expect(tools.some(t => t.function.name === "grep")).toBe(true);
    expect(tools.some(t => t.function.name === "shell")).toBe(true);

    // Placeholder instruction was appended to system message
    const msgs = transformed.messages as any[];
    expect(msgs.length).toBe(2);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("placeholder");
  });

  test("transformOpenCodeFreeChatBody aliases client conflicting tools and restores them", () => {
    const clientReadTool = {
      type: "function",
      function: {
        name: "read",
        description: "Client own read tool",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    };

    const transformed = transformOpenCodeFreeChatBody({
      model: "deepseek-v4-flash-free",
      messages: [
        { role: "system", content: "You are an assistant." },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } }],
        },
      ],
      tools: [clientReadTool],
      stream: true,
    });

    const tools = transformed.tools as any[];
    // Client tool renamed to read_client
    expect(tools.some(t => t.function.name === "read_client")).toBe(true);
    // Verbatim read tool still present
    expect(tools.some(t => t.function.name === "read")).toBe(true);

    // Assistant message tool_call renamed to read_client
    const msgs = transformed.messages as any[];
    expect(msgs[1].tool_calls[0].function.name).toBe("read_client");

    // Restores read_client to read
    expect(restoreOpenCodeFreeToolName("read_client")).toBe("read");
    expect(restoreOpenCodeFreeToolName("shell_client")).toBe("shell");
    expect(restoreOpenCodeFreeToolName("custom_tool")).toBe("custom_tool");
  });

  test("createOpenAIChatAdapter builds compliant OpenCode free request", () => {
    const zen = {
      baseUrl: "https://opencode.ai/zen/v1",
      adapter: "openai-chat",
      authMode: "key" as const,
      keyOptional: true,
    };
    const adapter = createOpenAIChatAdapter(zen);
    const parsed = parseRequest({
      model: "opencode-zen/deepseek-v4-flash-free",
      input: "Write hello world in python",
      stream: true,
    });

    const request = adapter.buildRequest(parsed);
    expect(request.url).toBe("https://opencode.ai/inference/v1/chat/completions");
    expect(request.headers["Authorization"]).toBe("Bearer public");
    expect(request.headers["User-Agent"]).toBe("opencode/latest/2.0.26/cli");

    const body = JSON.parse(request.body as string);
    expect(body.stream).toBe(true);
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools.some((t: any) => t.function.name === "read")).toBe(true);
  });
});

