import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { THINKING_LEVELS, type ThinkingLevel } from "@kanna/shared";

export interface ModelConnectionInput {
  providerId: string;
  providerName: string;
  baseUrl: string;
  modelId: string;
  modelName: string;
  apiKey?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  supportsImages?: boolean;
  thinkingLevel?: ThinkingLevel;
}

export interface ModelConnectionPublic extends Omit<ModelConnectionInput, "apiKey" | "thinkingLevel"> {
  configured: boolean;
  keyConfigured: boolean;
  thinkingLevel: ThinkingLevel;
}

export interface ModelOptionPublic {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  keyConfigured: boolean;
  reasoning: boolean;
  thinkingLevels: ThinkingLevel[];
}

export interface DiscoveredModelPublic {
  id: string;
  name: string;
  ownedBy?: string;
}

export interface ModelDiscoveryInput {
  providerId?: string;
  baseUrl: string;
  apiKey?: string;
}

interface ModelDefinition {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
  input?: string[];
  compat?: {
    supportsReasoningEffort?: boolean;
    thinkingFormat?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface ModelsFile {
  providers?: Record<
    string,
    {
      name?: string;
      baseUrl?: string;
      api?: string;
      models?: ModelDefinition[];
      [key: string]: unknown;
    }
  >;
}

interface AuthFile {
  [providerId: string]: { type: "api_key"; key: string } | Record<string, unknown>;
}

interface ActiveFile {
  providerId: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
}

function thinkingLevel(value: unknown, fallback: ThinkingLevel): ThinkingLevel {
  return THINKING_LEVELS.includes(value as ThinkingLevel) ? (value as ThinkingLevel) : fallback;
}

function supportedThinkingLevels(model: ModelDefinition): ThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  if (model.compat?.thinkingFormat === "deepseek") return ["off", "low", "high", "max"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

async function readObject<T>(path: string): Promise<T> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as T) : ({} as T);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {} as T;
    throw error;
  }
}

async function writeProtectedJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
}

export class ModelConfigStore {
  constructor(
    readonly modelsPath: string,
    readonly authPath: string,
    private readonly activePath: string,
    private readonly fallback?: { providerId?: string; modelId?: string; apiKey?: string },
  ) {}

  async getActive(): Promise<ModelConnectionPublic | undefined> {
    const models = await readObject<ModelsFile>(this.modelsPath);
    const active = await readObject<ActiveFile>(this.activePath);
    const providerId =
      active.providerId || this.fallback?.providerId || Object.keys(models.providers ?? {})[0];
    if (!providerId) return undefined;
    const provider = models.providers?.[providerId];
    if (!provider) return undefined;
    const modelId = active.modelId || this.fallback?.modelId || provider.models?.[0]?.id;
    const model = provider.models?.find((item) => item.id === modelId);
    if (!model || !provider.baseUrl) return undefined;
    const auth = await readObject<AuthFile>(this.authPath);
    const credential = auth[providerId];
    const availableThinkingLevels = supportedThinkingLevels(model);
    const requestedThinkingLevel = thinkingLevel(active.thinkingLevel, model.reasoning ? "medium" : "off");
    const normalizedThinkingLevel = model.compat?.thinkingFormat === "deepseek"
      ? requestedThinkingLevel === "minimal"
        ? "low"
        : requestedThinkingLevel === "medium" || requestedThinkingLevel === "xhigh"
          ? "high"
          : requestedThinkingLevel
      : requestedThinkingLevel;
    return {
      configured: true,
      keyConfigured: Boolean(this.fallback?.apiKey || (credential && "key" in credential && credential.key)),
      providerId,
      providerName: provider.name ?? providerId,
      baseUrl: provider.baseUrl,
      modelId: model.id,
      modelName: model.name ?? model.id,
      contextWindow: model.contextWindow ?? 128_000,
      maxTokens: model.maxTokens ?? 8192,
      reasoning: model.reasoning ?? false,
      supportsImages: model.input?.includes("image") ?? false,
      thinkingLevel: availableThinkingLevels.includes(normalizedThinkingLevel)
        ? normalizedThinkingLevel
        : (availableThinkingLevels[0] ?? "off"),
    };
  }

  async list(): Promise<ModelOptionPublic[]> {
    const models = await readObject<ModelsFile>(this.modelsPath);
    const auth = await readObject<AuthFile>(this.authPath);
    return Object.entries(models.providers ?? {}).flatMap(([providerId, provider]) => {
      const credential = auth[providerId];
      const keyConfigured = Boolean(
        (providerId === this.fallback?.providerId && this.fallback.apiKey) ||
          (credential && "key" in credential && credential.key),
      );
      return (provider.models ?? []).map((model) => ({
        providerId,
        providerName: provider.name ?? providerId,
        modelId: model.id,
        modelName: model.name ?? model.id,
        keyConfigured,
        reasoning: model.reasoning ?? false,
        thinkingLevels: supportedThinkingLevels(model),
      }));
    });
  }

  async find(providerId: string, modelId: string): Promise<ModelOptionPublic | undefined> {
    return (await this.list()).find((model) => model.providerId === providerId && model.modelId === modelId);
  }

  async discover(input: ModelDiscoveryInput): Promise<DiscoveredModelPublic[]> {
    const endpoint = new URL(input.baseUrl.trim());
    if (!["http:", "https:"].includes(endpoint.protocol))
      throw new Error("Model endpoint must use HTTP or HTTPS");
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/models`;
    endpoint.search = "";
    endpoint.hash = "";

    const apiKey = input.apiKey?.trim() || (await this.savedKey(input.providerId?.trim()));
    if (!apiKey) throw new Error("Enter an API key or save one for this provider before discovering models");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "GET",
        headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      if ((error as Error).name === "AbortError")
        throw new Error("Model discovery timed out after 15 seconds");
      throw new Error(
        `Could not reach the model endpoint: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new Error(`Model discovery failed (${response.status} ${response.statusText})`);

    const payload = (await response.json()) as {
      data?: unknown;
      models?: unknown;
    };
    const rawModels = Array.isArray(payload.data)
      ? payload.data
      : Array.isArray(payload.models)
        ? payload.models
        : undefined;
    if (!rawModels) throw new Error("The model endpoint returned an unsupported response");

    const discovered = new Map<string, DiscoveredModelPublic>();
    for (const value of rawModels.slice(0, 500)) {
      if (!value || typeof value !== "object") continue;
      const record = value as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id.trim() : "";
      if (!id || id.length > 200) continue;
      const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : id;
      const ownedBy =
        typeof record.owned_by === "string" && record.owned_by.trim() ? record.owned_by.trim() : undefined;
      discovered.set(id, { id, name, ...(ownedBy ? { ownedBy } : {}) });
    }
    return [...discovered.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  async save(input: ModelConnectionInput): Promise<ModelConnectionPublic> {
    const providerId = input.providerId.trim();
    const modelId = input.modelId.trim();
    if (!/^[a-zA-Z0-9._-]+$/.test(providerId)) throw new Error("Provider ID contains unsupported characters");
    if (!modelId) throw new Error("Model ID is required");
    const endpoint = new URL(input.baseUrl.trim());
    if (!["http:", "https:"].includes(endpoint.protocol))
      throw new Error("Model endpoint must use HTTP or HTTPS");
    const models = await readObject<ModelsFile>(this.modelsPath);
    models.providers ??= {};
    const previousProvider = models.providers[providerId];
    const isDeepSeek = /deepseek/i.test(`${providerId} ${modelId} ${endpoint.hostname}`);
    const selectedThinkingLevel = thinkingLevel(input.thinkingLevel, input.reasoning ? "medium" : "off");
    // DeepSeek defaults to thinking on, so even "off" must send an explicit disable flag.
    const reasoning = isDeepSeek || (input.reasoning ?? selectedThinkingLevel !== "off");
    const activeThinkingLevel = reasoning ? selectedThinkingLevel : "off";
    const configuredModel = {
      id: modelId,
      name: input.modelName.trim() || modelId,
      reasoning,
      ...(reasoning
        ? {
            thinkingLevelMap: {
              off: "none",
              minimal: "low",
              low: "low",
              medium: isDeepSeek ? "high" : "medium",
              high: "high",
              xhigh: "high",
              max: isDeepSeek ? "max" : "high",
            },
          }
        : {}),
      input: input.supportsImages ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: Math.max(1024, input.contextWindow ?? 128_000),
      maxTokens: Math.max(256, input.maxTokens ?? 8192),
      compat: {
        supportsDeveloperRole: false,
        supportsStore: false,
        maxTokensField: "max_tokens",
        supportsReasoningEffort: reasoning,
        ...(reasoning ? { thinkingFormat: isDeepSeek ? "deepseek" : "openai" } : {}),
      },
    };
    models.providers[providerId] = {
      ...previousProvider,
      name: input.providerName.trim() || providerId,
      baseUrl: endpoint.toString().replace(/\/$/, ""),
      api: "openai-completions",
      models: [configuredModel, ...(previousProvider?.models ?? []).filter((model) => model.id !== modelId)],
    };
    await writeProtectedJson(this.modelsPath, models);
    if (input.apiKey?.trim()) {
      const auth = await readObject<AuthFile>(this.authPath);
      auth[providerId] = { type: "api_key", key: input.apiKey.trim() };
      await writeProtectedJson(this.authPath, auth);
    }
    await writeProtectedJson(this.activePath, { providerId, modelId, thinkingLevel: activeThinkingLevel });
    const saved = await this.getActive();
    if (!saved) throw new Error("Model configuration could not be loaded after saving");
    return saved;
  }

  getRuntimeKey(providerId: string): string | undefined {
    return providerId === this.fallback?.providerId ? this.fallback.apiKey : undefined;
  }

  private async savedKey(providerId?: string): Promise<string | undefined> {
    if (!providerId) return undefined;
    const runtimeKey = this.getRuntimeKey(providerId);
    if (runtimeKey) return runtimeKey;
    const auth = await readObject<AuthFile>(this.authPath);
    const credential = auth[providerId];
    return credential && "key" in credential && typeof credential.key === "string"
      ? credential.key
      : undefined;
  }
}
