import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { SubscriptionAccountPool, subscriptionProfileHasCredential, type SubscriptionProvider, type SubscriptionAccountView, type SubscriptionLoginProfile } from "./subscription_account_pool.js";
import { SubscriptionAuthService } from "./subscription_auth.js";

type LoginFlow = {
  id: string;
  provider: SubscriptionProvider;
  account_id: string;
  status: "pending" | "completed" | "failed";
  error?: string;
  child?: ChildProcess;
  profile?: SubscriptionLoginProfile;
  created_at: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function safeError(error: unknown): string {
  return String(error instanceof Error ? error.message : error || "登录流程失败")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/(?:access|refresh)[_-]?token[=:][^\s,}]+/gi, "token=[redacted]")
    .slice(0, 320);
}

export const SUBSCRIPTION_LOGIN_CAPABILITIES: Record<SubscriptionProvider, {
  login_supported: boolean;
  capture_supported: boolean;
  direct_entry_supported: boolean;
  login_hint: string;
}> = {
  antigravity: {
    login_supported: false,
    capture_supported: true,
    direct_entry_supported: true,
    login_hint: "支持直接填入 Token / 凭证，或从 Antigravity 客户端一键捕获当前登录态",
  },
  grok: {
    login_supported: true,
    capture_supported: true,
    direct_entry_supported: true,
    login_hint: "支持直接填入 Grok API Key / 凭证，或启动 Grok OAuth 网页登录",
  },
  claude: {
    login_supported: true,
    capture_supported: true,
    direct_entry_supported: true,
    login_hint: "支持直接填入 Claude API Key / Token，或启动 Claude 网页登录",
  },
  cursor: {
    login_supported: false,
    capture_supported: true,
    direct_entry_supported: true,
    login_hint: "支持直接填入 Cursor Token / Key，或从 Cursor 客户端一键捕获当前登录态",
  },
  opencode: {
    login_supported: false,
    capture_supported: false,
    direct_entry_supported: true,
    login_hint: "公共免费订阅：零装机即用；亦可填入自定义 OpenCode Token",
  },
  workbuddy: {
    login_supported: false,
    capture_supported: false,
    direct_entry_supported: true,
    login_hint: "公共免费订阅：零装机即用；亦可填入自定义 WorkBuddy Token",
  },
};

export class SubscriptionAccountLoginService {
  private readonly flows = new Map<string, LoginFlow>();

  constructor(private readonly pool: SubscriptionAccountPool) {}

  public capabilities(provider: SubscriptionProvider) {
    return SUBSCRIPTION_LOGIN_CAPABILITIES[provider];
  }

  public startLogin(provider: SubscriptionProvider, label?: unknown): { flow_id: string; account: null; login: LoginFlow } {
    const capability = this.capabilities(provider);
    if (!capability.login_supported) {
      throw new Error(`${provider} 暂无可隔离的官方登录命令；${capability.login_hint}`);
    }
    if (this.getPending(provider)) throw new Error(`${provider} 已有登录流程进行中，请先完成或关闭当前登录流程`);
    const profile = this.pool.createLoginProfile({ provider, label });
    const flow: LoginFlow = {
      id: randomUUID(),
      provider,
      account_id: profile.id,
      status: "pending",
      profile,
      created_at: nowIso(),
    };
    const command = provider === "grok" ? "grok" : "claude";
    const args = provider === "grok" ? ["login", "--oauth"] : ["auth", "login", "--claudeai"];
    const env = {
      ...process.env,
      ...(provider === "grok" ? { GROK_HOME: profile.profile_dir } : { CLAUDE_CONFIG_DIR: profile.profile_dir }),
    };
    try {
      const child = spawn(command, args, { env, stdio: "ignore", detached: true });
      flow.child = child;
      child.once("error", (error) => {
        this.failFlow(flow, safeError(error));
      });
      child.once("exit", (code, signal) => {
        this.finishFlow(flow, code, signal);
      });
      child.unref();
    } catch (error) {
      this.pool.discardLoginProfile(profile);
      throw new Error(`无法启动 ${provider} 登录流程：${safeError(error)}`);
    }
    this.flows.set(flow.id, flow);
    return { flow_id: flow.id, account: null, login: this.publicFlow(flow) };
  }

  public async captureCurrent(provider: SubscriptionProvider, label?: unknown): Promise<{ account: SubscriptionAccountView; created: boolean }> {
    this.pool.compactDuplicateAccounts(provider);
    const account = this.pool.createAccount({ provider, label });
    try {
      await SubscriptionAuthService.captureCurrentCredential(provider, account.profile_dir);
      const captured = this.pool.getAccount(provider, account.id);
      if (!captured || captured.auth_status !== "ready") throw new Error("当前登录态没有生成可用凭证");
      const duplicate = this.pool.findDuplicateCredential(provider, account.profile_dir, account.id);
      if (duplicate) {
        this.pool.removeAccount(provider, account.id);
        this.pool.discardLoginProfile({ id: account.id, provider, label: account.label, profile_dir: account.profile_dir });
        return { account: duplicate, created: false };
      }
      return { account: captured, created: true };
    } catch (error) {
      this.pool.removeAccount(provider, account.id);
      this.pool.discardLoginProfile({ id: account.id, provider, label: account.label, profile_dir: account.profile_dir });
      throw error;
    }
  }

  public async addDirectCredential(
    provider: SubscriptionProvider,
    input: {
      label?: unknown;
      token?: unknown;
      accessToken?: unknown;
      refreshToken?: unknown;
      apiKey?: unknown;
      sessionKey?: unknown;
    },
  ): Promise<{ account: SubscriptionAccountView; created: boolean }> {
    const rawToken = String(
      input.token || input.accessToken || input.apiKey || input.sessionKey || "",
    ).trim();
    if (!rawToken) {
      throw new Error(`请填写有效的 ${provider} Token 或凭证`);
    }

    this.pool.compactDuplicateAccounts(provider);
    const account = this.pool.createAccount({ provider, label: input.label });

    try {
      fs.mkdirSync(account.profile_dir, { recursive: true, mode: 0o700 });
      try { fs.chmodSync(account.profile_dir, 0o700); } catch {}

      const writeJson = (filePath: string, data: any) => {
        const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
        fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
        try { fs.chmodSync(tempPath, 0o600); } catch {}
        fs.renameSync(tempPath, filePath);
        try { fs.chmodSync(filePath, 0o600); } catch {}
      };

      const refreshTok = String(input.refreshToken || "").trim();

      if (provider === "cursor") {
        writeJson(path.join(account.profile_dir, "credentials.json"), {
          accessToken: rawToken,
          refreshToken: refreshTok || rawToken,
        });
      } else if (provider === "antigravity") {
        let authData: any;
        if (rawToken.startsWith("{") && rawToken.endsWith("}")) {
          try {
            authData = JSON.parse(rawToken);
          } catch {}
        }
        if (!authData || typeof authData !== "object") {
          authData = {
            token: {
              access_token: rawToken,
              refresh_token: refreshTok || rawToken,
              expiry: "2099-01-01T00:00:00Z",
            },
          };
        }
        writeJson(path.join(account.profile_dir, "auth.json"), authData);
      } else if (provider === "claude") {
        const payload = {
          accessToken: rawToken,
          refreshToken: refreshTok,
          expiresAt: Date.now() + 365 * 86400 * 1000,
        };
        writeJson(path.join(account.profile_dir, "credentials.json"), payload);
        writeJson(path.join(account.profile_dir, "claude_desktop_auth.json"), payload);
      } else if (provider === "grok") {
        writeJson(path.join(account.profile_dir, "auth.json"), {
          default: {
            token: rawToken,
            key: rawToken,
          },
        });
      } else {
        // opencode / workbuddy
        writeJson(path.join(account.profile_dir, "auth.json"), {
          token: rawToken,
          mode: "direct",
        });
      }

      const captured = this.pool.getAccount(provider, account.id);
      if (!captured || captured.auth_status !== "ready") {
        throw new Error("凭证写入后未生成可用状态");
      }

      const duplicate = this.pool.findDuplicateCredential(provider, account.profile_dir, account.id);
      if (duplicate) {
        this.pool.removeAccount(provider, account.id);
        this.pool.discardLoginProfile({
          id: account.id,
          provider,
          label: account.label,
          profile_dir: account.profile_dir,
        });
        return { account: duplicate, created: false };
      }

      return { account: captured, created: true };
    } catch (error) {
      this.pool.removeAccount(provider, account.id);
      this.pool.discardLoginProfile({
        id: account.id,
        provider,
        label: account.label,
        profile_dir: account.profile_dir,
      });
      throw error;
    }
  }

  public getPending(provider: SubscriptionProvider): LoginFlow | null {
    const flow = [...this.flows.values()].find((candidate) => candidate.provider === provider && candidate.status === "pending");
    if (!flow) return null;
    this.refreshFlow(flow);
    return flow.status === "pending" ? this.publicFlow(flow) : null;
  }

  public cancelLogin(id: unknown): boolean {
    const key = String(id || "").trim();
    const flow = this.flows.get(key);
    if (!flow || flow.status !== "pending") return false;
    try { flow.child?.kill("SIGTERM"); } catch {}
    this.failFlow(flow, "用户取消登录");
    return true;
  }

  public getFlow(id: unknown): LoginFlow | null {
    const key = String(id || "").trim();
    const flow = this.flows.get(key);
    if (!flow) return null;
    this.refreshFlow(flow);
    return this.publicFlow(flow);
  }

  private refreshFlow(flow: LoginFlow): void {
    if (flow.status !== "pending") return;
    this.completeFlowIfCredentialReady(flow);
  }

  private finishFlow(flow: LoginFlow, code: number | null, signal: NodeJS.Signals | null): void {
    if (flow.status !== "pending") return;
    if (this.completeFlowIfCredentialReady(flow)) return;
    this.failFlow(flow, `登录未完成（${signal || `exit ${code ?? "unknown"}`}）`);
  }

  private completeFlowIfCredentialReady(flow: LoginFlow): boolean {
    const profile = flow.profile;
    if (!profile || !subscriptionProfileHasCredential(flow.provider, profile.profile_dir)) return false;
    const duplicate = this.pool.findDuplicateCredential(flow.provider, profile.profile_dir, profile.id);
    if (duplicate) {
      flow.account_id = duplicate.id;
      this.pool.discardLoginProfile(profile);
    } else {
      this.pool.registerLoginProfile(profile);
    }
    flow.status = "completed";
    return true;
  }

  private failFlow(flow: LoginFlow, error: string): void {
    if (flow.status !== "pending") return;
    flow.status = "failed";
    flow.error = error;
    if (flow.profile) this.pool.discardLoginProfile(flow.profile);
  }

  private publicFlow(flow: LoginFlow): LoginFlow {
    return {
      id: flow.id,
      provider: flow.provider,
      account_id: flow.account_id,
      status: flow.status,
      ...(flow.error ? { error: flow.error } : {}),
      created_at: flow.created_at,
    };
  }
}
