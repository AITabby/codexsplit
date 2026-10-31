# 生图能力反代方案（Gemini Nano Banana / 订阅账号）

状态：设计草案，待实现

## 目标

CodexSplit 目前只把 LLM 能力反代出去，生图统一走原生 Codex Images API
（`opencodex_generate_image` → `chatgpt.com/backend-api/codex/images/generations`，模型 `gpt-image-2`）。

本次要新增一路：**用用户的 Gemini Pro 订阅账号**（含 Nano Banana 生图能力）作为
第二类生图 provider，让 CodexSplit 对外同时暴露 LLM 和生图两类能力。

## 现有架构（src_v2）

关键调用链：

```
router.ts
  └─ transformer.ts        注入 opencodex_generate_image 工具定义给第三方模型
  └─ stream_engine.ts      识别模型发起��内部工具调用（internalImageToolCalls）
  └─ router.ts:3020        调 generateNativeCodexImage()
  └─ native_image_bridge.ts  → chatgpt.com Images API（返回 b64_json）
  └─ stream_engine.ts      emitImageGeneration() → SSE image_generation_call 事件
```

核心文件：

| 文件 | 职责 |
| --- | --- |
| `src_v2/services/native_image_bridge.ts` | 原生生图：工具名、参数解析、请求构造、b64 解析 |
| `src_v2/core/transformer.ts` | 把生图工具定义注入第三方 provider 的请求体 |
| `src_v2/core/stream_engine.ts` | 拦截内部工具调用，走网关内建路径而非发给上游 |
| `src_v2/server/router.ts` | 编排；`internalImageCalls` 循环里派发生图 |
| `src_v2/services/subscription_account_pool.ts` | 订阅账号池，provider 联合类型在此 |
| `src_v2/services/subscription_account_auth.ts` | 订阅账号登录/凭据捕获 |
| `src_v2/services/provider_presets.ts` | API-key 型 provider 目录（Google 也在此） |

## 关键设计决策

### 1. 订阅型 provider 与 key 型 provider 分开

`provider_presets.ts` 的注释明确写了：key 型 provider 和 OAuth 型 provider 分属两套注册表。
Gemini 订阅账号应走 `SUBSCRIPTION_ACCOUNT_PROVIDERS`（当前为
`antigravity / grok / claude / cursor / opencode`），新增 `gemini` 成员，而不是塞进
`provider_presets`。

### 2. 生图 provider 与 LLM provider 解耦

当前 `generateNativeCodexImage` 把"工具调用 → 上请求 → 解析 b64"写死成一条路径。
新增 Gemini 生图时，不建议在函数里加 if/else 堆分支，而是抽出统一的
`ImageGenerationProvider` 接口，按配置或模型路由选择实现。

建议形态：

```ts
interface ImageGenerationProvider {
  name: string;
  generate(
    args: ImageGenerationToolArguments,
    context: ImageGenerationContext,
  ): Promise<NativeGeneratedImage[]>;
}
```

现有 `generateNativeCodexImage` 改造成 `NativeCodexImageProvider` 实现该接口，
再新增 `GeminiSubscriptionImageProvider`。

### 3. Nano Banana 的上游协议

Nano Banana 是 Gemini 网页版/App 里的图像模型（`gemini-2.5-flash-image` 一类）。
要拿到 Pro 订阅里的配额，有两条路：

**路线 A：模拟网页版会话**
- 复用已登录账号的 cookie，请求 Gemini 内部 RPC（`batchexecute` / WebSocket）
- 优点：直接消耗 Pro 订阅配额，不需要额外 API key
- 代价：协议非公开，签名/风控/会话过期需长期跟进

**路线 B：Vertex AI / AI Studio 订阅级配额**
- 走正式 Gemini API，模型名形如 `gemini-2.5-flash-image-preview`
- 优点：接口稳定，直接拿二进制
- 代价：需要 Google Cloud 项目；需确认该路径确实挂在 Pro 订阅配额上
  （Pro 订阅与 Google AI Studio 的 API 配额是**两套独立通道**，需实测）

> 注意：Gemini Pro 订阅 ≠ Gemini API 额度。订阅覆盖的是网页版/App 使用。
> 走路线 B 时，额度挂在 Google Cloud / AI Studio 账户上，需要单独开通。

### 4. 返回格式统一

两条路线最终都要归一成 `NativeGeneratedImage[]`：

```ts
interface NativeGeneratedImage {
  data: string;          // base64（不带 data: 前缀）
  revisedPrompt?: string;
  partialImages?: string[];
}
```

Gemini 网页版返回的图片通常是 blob URL 或远端 URL，需要在服务端转成 base64
再交给 `emitImageGeneration`，这样对下游（Codex 客户端）完全透明。

## 实施步骤

1. **抽取 provider 接口**
   - 新建 `src_v2/services/image_generation_providers/` 目录
   - 定义 `ImageGenerationProvider` 接口
   - 把 `native_image_bridge.ts` 的现有逻辑迁成 `native_codex_image_provider.ts`

2. **接入 Gemini 订阅账号**
   - `subscription_account_pool.ts` 的 `SUBSCRIPTION_ACCOUNT_PROVIDERS` 增加 `gemini`
   - `subscription_account_auth.ts` 增加 `gemini` 的登录能力与凭据捕获
   - 复用 `chatgpt_account_auth.ts` 的模式（先读它确认登录流程的抽象）

3. **实现 Gemini 生图 provider**
   - 依据选定路线实现上游请求
   - 处理 blob/远端 URL → base64 转换
   - 错误信息中文化，风格对齐现有 `原生 Codex 生图失败（模型 X，HTTP Y）` 格式

4. **路由与配置**
   - `router.ts:3020` 处按配置选择 provider
   - 配置项建议：`OPENCODEX_IMAGE_PROVIDER=native_codex|gemini`、`OPENCODEX_NATIVE_IMAGE_MODEL`（已存在）
   - 可支持按模型名路由：`gpt-image-2` → 原生，`gemini-*-image` → Gemini

5. **凭据与环境**
   - 订阅账号凭据存放位置参考 `credential_store.ts`
   - 注意不要把 cookie 写进日志或错误信息

## 待确认问题

- 走路线 A 还是路线 B？A 更贴合"用 Pro 订阅"，B 更稳定
- 生图 provider 是全局配置还是按模型名自动路由？
- 是否需要支持"编辑已有图片"（image edit），Gemini 侧支持传参考图
- 多账号轮换（`SubscriptionRotationMode`）是否要覆盖生图路径

## 现状备忘

- 已验证可用路径：Gemini 网页版「制作图片」工具需要**登录态** + **Gemini 3 模式**，
  匿名态和 3.5 Flash-Lite 都不出图
- 网页版出图走 blob URL，浏览器扩展层抓不到原始二进制
  （`downloadMedia` 不支持 blob、`waitForEvent("download")` 不触发），
  这正是需要服务端直连的根本原因

