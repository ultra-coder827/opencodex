/**
 * OpenCode Zen Free-Tier Client Fingerprinting & Upstream Attestation.
 *
 * Upstream opencode.ai enforces server-side validation on free-tier models
 * (*-free, big-pickle, etc.):
 *  1. Requests must be directed to `/inference/v1/*` (not `/zen/v1/*`).
 *  2. Authentication must be `Authorization: Bearer public`.
 *  3. OpenCode v2 client User-Agent and headers (x-opencode-client: cli, x-opencode-project: global).
 *  4. OpenCode canonical descending session headers (x-opencode-session, x-opencode-session-id,
 *     x-session-affinity, x-session-id) with NO x-opencode-request header.
 *  5. Session ID matching /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/ with inverted 48-bit timestamp
 *     and small monotonic counter.
 *  6. Mandatory `stream: true`.
 *  7. Exact tool schemas for the core quartet {bash, glob, grep, read, shell}.
 */

import { openCodeZenKeyBaseUrl, type OpenCodeZenDestination } from "../types/opencode-zen";

export const OPENCODE_ZEN_KNOWN_FREE_MODELS = new Set([
  "big-pickle",
  "deepseek-v4-flash-free",
  "minimax-m2.5-free",
  "glm-5.1-free",
  "kimi-k2.5-free",
  "gpt-5-nano-free",
  "mimo-v2-pro-free",
  "mimo-v2-omni-free",
  "mimo-v2.6-flash-free",
  "mimo-v2.5-free",
  "longcat-2.0-free",
  "nemotron-3-ultra-free",
  "nemotron-3-super-free",
  "ling-3.0-flash-free",
  "north-mini-code-free",
  "laguna-s-2.1-free",
  "muse-spark-chat-contributor-free",
  "muse-spark-code-contributor-free",
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
]);

/** Returns true if modelId represents an OpenCode free-tier model. */
export function isOpenCodeZenFreeModel(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const lower = modelId.toLowerCase().trim();
  const unnamespaced = lower.includes("/") ? lower.split("/").pop()! : lower;
  return OPENCODE_ZEN_KNOWN_FREE_MODELS.has(unnamespaced)
    || unnamespaced.endsWith("-free")
    || unnamespaced.includes("-free-")
    || unnamespaced.endsWith("-contributor-free");
}

/** Check if provider destination points to official OpenCode Zen gateway. */
export function isOpenCodeZenDestination(provider: OpenCodeZenDestination | undefined): boolean {
  return openCodeZenKeyBaseUrl(provider) !== undefined;
}

/** Check if a request to provider and model should be treated as an OpenCode Zen free request. */
export function isOpenCodeZenFreeRequest(
  provider: (OpenCodeZenDestination & { providerName?: string }) | undefined,
  modelId: string | undefined,
): boolean {
  if (!isOpenCodeZenFreeModel(modelId)) return false;
  if (!provider) return false;
  if (provider.providerName === "opencode-zen") return true;
  return isOpenCodeZenDestination(provider);
}

const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

let lastSessionTimestamp = 0;
let sessionCounter = 0;
let cachedSessionId: string | undefined;
let cachedSessionTime = 0;

/**
 * Generate a canonical descending OpenCode session ID adhering to OpenCode's
 * packages/schema/src/identifier.ts descending algorithm.
 */
export function generateOpenCodeSessionId(timestamp = Date.now()): string {
  if (timestamp !== lastSessionTimestamp) {
    lastSessionTimestamp = timestamp;
    sessionCounter = 0;
  }
  sessionCounter++;
  const current = BigInt(timestamp) * 0x1000n + BigInt(sessionCounter);
  const value = ~current;
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0"),
  ).join("");
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  return "ses_" + time + Array.from(bytes, byte => BASE62_CHARS[byte % 62]).join("");
}

/**
 * Returns a stable session ID per process (refreshed every hour) to maintain session
 * affinity and avoid triggering 429 FreeUsageLimitError on burst requests.
 */
export function getStableOpenCodeSessionId(): string {
  const now = Date.now();
  if (!cachedSessionId || now - cachedSessionTime > 3_600_000) {
    cachedSessionId = generateOpenCodeSessionId(now);
    cachedSessionTime = now;
  }
  return cachedSessionId;
}

/**
 * Rewrite outbound inference URL from /zen/v1/* to /inference/v1/* for free models.
 */
export function resolveOpenCodeFreeUrl(urlStr: string): string {
  try {
    const url = new URL(urlStr);
    if (url.origin === "https://opencode.ai") {
      url.pathname = url.pathname.replace(/^\/zen\/v1(\/|$)/, "/inference/v1$1");
      return url.toString();
    }
  } catch {
    // Keep verbatim on parse error
  }
  return urlStr;
}

/**
 * Apply OpenCode v2 client fingerprint headers.
 */
export function applyOpenCodeFreeHeaders(
  headers: Record<string, string>,
  sessionId?: string,
): Record<string, string> {
  const sesId = sessionId || getStableOpenCodeSessionId();
  const out = { ...headers };
  out["Authorization"] = "Bearer public";
  out["authorization"] = "Bearer public";
  out["User-Agent"] = "opencode/latest/2.0.26/cli";
  out["user-agent"] = "opencode/latest/2.0.26/cli";
  out["x-opencode-client"] = "cli";
  out["x-opencode-project"] = "global";
  out["x-opencode-session"] = sesId;
  out["x-opencode-session-id"] = sesId;
  out["x-session-affinity"] = sesId;
  out["x-session-id"] = sesId;
  delete out["x-opencode-request"];
  delete out["X-Opencode-Request"];
  return out;
}

// Built-in tools required by OpenCode upstream verification gate
export const OPENCODE_REQUIRED_TOOLS_CHAT = [
  {
    type: "function",
    function: {
      name: "read",
      description: "Read the contents of a file. Returns the file contents with line numbers prefixed.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "The path to the file to read." },
          offset: { type: "number", description: "The 1-based line number to start reading from. Defaults to 1." },
          limit: { type: "number", description: "The maximum number of lines to read. Defaults to 2000." },
        },
        required: ["filePath"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description: "Execute a bash command in the terminal.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command to execute." },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "Find files matching a glob pattern.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "The glob pattern to match." },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search for regex patterns across files.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "The regex pattern to search for." },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shell",
      description: "Execute a shell command. Use this to run terminal commands, build scripts, tests, etc.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to execute." },
          timeout: { type: "number", description: "The timeout in milliseconds for the command. Defaults to 30000." },
          workdir: { type: "string", description: "The working directory for the command. Defaults to current directory." },
          description: { type: "string", description: "A description of what the command does." },
        },
        required: ["command", "description"],
        additionalProperties: false,
      },
    },
  },
] as const;

export const OPENCODE_REQUIRED_TOOLS_RESPONSES = OPENCODE_REQUIRED_TOOLS_CHAT.map(t => ({
  type: "function",
  name: t.function.name,
  description: t.function.description,
  parameters: t.function.parameters,
}));

const COLLISION_TOOL_NAMES = new Set(["read", "bash", "glob", "grep", "shell"]);

export const OPENCODE_PLACEHOLDER_INSTRUCTION =
  "\n\nDo not call the `read`, `bash`, `glob`, `grep`, or `shell` tools; they are placeholders that do nothing. Answer the prompt directly or use your other tools.";

/**
 * Transform Chat Completions request body for OpenCode free models:
 * 1. Alias conflicting client tools (read -> read_client, etc.) in tools and messages.
 * 2. Inject required OpenCode verification tools.
 * 3. Enforce stream: true.
 * 4. Ensure tool_choice is not "none".
 * 5. Add placeholder instruction to system message.
 */
export function transformOpenCodeFreeChatBody(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...body };
  out.stream = true;

  if (out.tool_choice === "none") {
    out.tool_choice = "auto";
  }

  // Alias existing tools if any collide with built-ins
  const existingTools = Array.isArray(out.tools) ? [...out.tools] : [];
  const clientTools: unknown[] = [];
  const aliasedNames = new Set<string>();

  for (const item of existingTools) {
    if (!item || typeof item !== "object") continue;
    const tool = item as Record<string, unknown>;
    const fn = (tool.function && typeof tool.function === "object")
      ? (tool.function as Record<string, unknown>)
      : tool;
    const name = typeof fn.name === "string" ? fn.name : undefined;
    if (name && COLLISION_TOOL_NAMES.has(name)) {
      aliasedNames.add(name);
      const aliasName = `${name}_client`;
      if (tool.function && typeof tool.function === "object") {
        clientTools.push({
          ...tool,
          function: { ...(tool.function as Record<string, unknown>), name: aliasName },
        });
      } else {
        clientTools.push({ ...tool, name: aliasName });
      }
    } else {
      clientTools.push(tool);
    }
  }

  // Combine client tools with required OpenCode tools
  out.tools = [...clientTools, ...OPENCODE_REQUIRED_TOOLS_CHAT];

  // Update messages: alias tool_calls matching collision names
  if (Array.isArray(out.messages)) {
    const newMessages = out.messages.map(msg => {
      if (!msg || typeof msg !== "object") return msg;
      const m = { ...(msg as Record<string, unknown>) };
      if (Array.isArray(m.tool_calls)) {
        m.tool_calls = m.tool_calls.map(tc => {
          if (!tc || typeof tc !== "object") return tc;
          const call = { ...(tc as Record<string, unknown>) };
          if (call.function && typeof call.function === "object") {
            const f = { ...(call.function as Record<string, unknown>) };
            if (typeof f.name === "string" && aliasedNames.has(f.name)) {
              f.name = `${f.name}_client`;
            }
            call.function = f;
          }
          return call;
        });
      }
      return m;
    });

    // Add placeholder instruction to first system message if one exists
    for (let i = 0; i < newMessages.length; i++) {
      const m = newMessages[i] as Record<string, unknown>;
      if (m.role === "system" || m.role === "developer") {
        if (typeof m.content === "string") {
          m.content += OPENCODE_PLACEHOLDER_INSTRUCTION;
          break;
        }
      }
    }
    out.messages = newMessages;
  }

  return out;
}

/**
 * Restore aliased tool names (e.g. read_client -> read) in output string or JSON.
 */
export function restoreOpenCodeFreeToolName(name: string): string {
  if (name.endsWith("_client")) {
    const base = name.slice(0, -7);
    if (COLLISION_TOOL_NAMES.has(base)) return base;
  }
  return name;
}

/**
 * Restore aliased tool names in an SSE chunk payload string.
 */
export function restoreOpenCodeFreeSsePayload(chunkText: string): string {
  if (!chunkText.includes("_client")) return chunkText;
  let text = chunkText;
  for (const name of COLLISION_TOOL_NAMES) {
    text = text.replaceAll(`"${name}_client"`, `"${name}"`);
  }
  return text;
}
