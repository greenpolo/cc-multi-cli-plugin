import { readJsonFile } from "../fs.mjs";
import { BROKER_ENDPOINT_ENV, CodexAppServerClient } from "../app-server.mjs";
import { loadBrokerSession } from "../broker-lifecycle.mjs";
import { binaryAvailable } from "../process.mjs";

const BUILTIN_PROVIDER_LABELS = new Map([
  ["openai", "OpenAI"],
  ["ollama", "Ollama"],
  ["lmstudio", "LM Studio"]
]);

function normalizeProviderId(value) {
  const providerId = typeof value === "string" ? value.trim() : "";
  return providerId || null;
}

function formatProviderLabel(providerId, providerConfig = null) {
  const configuredName = typeof providerConfig?.name === "string" ? providerConfig.name.trim() : "";
  if (configuredName) {
    return configuredName;
  }
  if (!providerId) {
    return "The active provider";
  }
  return BUILTIN_PROVIDER_LABELS.get(providerId) ?? providerId;
}

function buildAuthStatus(fields = {}) {
  return {
    available: true,
    loggedIn: false,
    detail: "not authenticated",
    source: "unknown",
    authMethod: null,
    verified: null,
    requiresOpenaiAuth: null,
    provider: null,
    ...fields
  };
}

function resolveProviderConfig(configResponse) {
  const config = configResponse?.config;
  if (!config || typeof config !== "object") {
    return {
      providerId: null,
      providerConfig: null
    };
  }

  const providerId = normalizeProviderId(config.model_provider);
  const providers =
    config.model_providers && typeof config.model_providers === "object" && !Array.isArray(config.model_providers)
      ? config.model_providers
      : null;
  const providerConfig =
    providerId && providers?.[providerId] && typeof providers[providerId] === "object" ? providers[providerId] : null;

  return {
    providerId,
    providerConfig
  };
}

function buildAppServerAuthStatus(accountResponse, configResponse) {
  const account = accountResponse?.account ?? null;
  const requiresOpenaiAuth =
    typeof accountResponse?.requiresOpenaiAuth === "boolean" ? accountResponse.requiresOpenaiAuth : null;
  const { providerId, providerConfig } = resolveProviderConfig(configResponse);
  const providerLabel = formatProviderLabel(providerId, providerConfig);

  if (account?.type === "chatgpt") {
    const email = typeof account.email === "string" && account.email.trim() ? account.email.trim() : null;
    return buildAuthStatus({
      loggedIn: true,
      detail: email ? `ChatGPT login active for ${email}` : "ChatGPT login active",
      source: "app-server",
      authMethod: "chatgpt",
      verified: true,
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  if (account?.type === "apiKey") {
    return buildAuthStatus({
      loggedIn: true,
      detail: "API key configured (unverified)",
      source: "app-server",
      authMethod: "apiKey",
      verified: false,
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  if (requiresOpenaiAuth === false) {
    return buildAuthStatus({
      loggedIn: true,
      detail: `${providerLabel} is configured and does not require OpenAI authentication`,
      source: "app-server",
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  return buildAuthStatus({
    loggedIn: false,
    detail: `${providerLabel} requires OpenAI authentication`,
    source: "app-server",
    requiresOpenaiAuth,
    provider: providerId
  });
}

async function getCodexAuthStatusFromClient(client, cwd) {
  try {
    const accountResponse = await client.request("account/read", { refreshToken: false });
    const configResponse = await client.request("config/read", {
      includeLayers: false,
      cwd
    });

    return buildAppServerAuthStatus(accountResponse, configResponse);
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      source: "app-server"
    });
  }
}

export function getCodexAvailability(cwd) {
  const versionStatus = binaryAvailable("codex", ["--version"], { cwd });
  if (!versionStatus.available) {
    return versionStatus;
  }

  const appServerStatus = binaryAvailable("codex", ["app-server", "--help"], { cwd });
  if (!appServerStatus.available) {
    return {
      available: false,
      detail: `${versionStatus.detail}; advanced runtime unavailable: ${appServerStatus.detail}`
    };
  }

  return {
    available: true,
    detail: `${versionStatus.detail}; advanced runtime available`
  };
}

export function getSessionRuntimeStatus(env = process.env, cwd = process.cwd()) {
  const endpoint = env?.[BROKER_ENDPOINT_ENV] ?? loadBrokerSession(cwd)?.endpoint ?? null;
  if (endpoint) {
    return {
      mode: "shared",
      label: "shared session",
      detail: "This Claude session is configured to reuse one shared Codex runtime.",
      endpoint
    };
  }

  return {
    mode: "direct",
    label: "direct startup",
    detail: "No shared Codex runtime is active yet. The first review or task command will start one on demand.",
    endpoint: null
  };
}

export async function getCodexAuthStatus(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      authMethod: null,
      verified: null,
      requiresOpenaiAuth: null,
      provider: null
    };
  }

  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd, {
      env: options.env,
      reuseExistingBroker: true
    });
    return await getCodexAuthStatusFromClient(client, cwd);
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      source: "app-server"
    });
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
  }
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Codex did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  try {
    return {
      parsed: JSON.parse(rawOutput),
      parseError: null,
      rawOutput,
      ...fallback
    };
  } catch (error) {
    return {
      parsed: null,
      parseError: error.message,
      rawOutput,
      ...fallback
    };
  }
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}
