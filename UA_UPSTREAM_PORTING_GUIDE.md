# UA 上游能力移植执行文档

## 2026-06-02 UnderstandingSelf Dashboard 与受控产物迁移附录

本附录对应 `docs/superpowers/plans/2026-06-02-astrbot-understandingself-dashboard-port.md`，优先级高于本文后续早期移植记录中关于 Dashboard 只做必要 cherry-pick 的限制。

本轮迁移基线：

- 目标 AstrBot 插件仓库：`astrbot_plugin_UnderstandAnything`
- 目标提交：`5495c30ce68bee46188c44b6485a8442520d9059`
- 参考仓库：`D:\AboutDEV\understanding\UnderstandingSelf`
- 参考提交：`2be9118c726c3833c670c00a9f0091e0a3f4801e`
- 参考插件根：`D:\AboutDEV\understanding\UnderstandingSelf\understand-anything-plugin`

本轮必须保留的 AstrBot 边界：

- `main.py`、`metadata.yaml`、`_conf_schema.json`、`requirements.txt` 继续作为 AstrBot 插件宿主和分发入口。
- `astrbot_adapter/web_api.py` 继续作为 AstrBot Plugin Page 的 API 边界。
- `astrbot_adapter/runner.py` 继续负责 AstrBot job 编排、Provider/SubAgent 调度、确认流程、GitHub/local source 处理。
- `astrbot_adapter/runtime.py` 与 `astrbot_adapter/node/bridge.mjs` 继续作为 Python 到 Node runtime action 的执行边界。
- `astrbot_adapter/job_store.py` 与 `astrbot_adapter/project_registry.py` 可以扩展状态和 observations，但不能被 UnderstandingSelf server store 直接替换。
- `astrbot_adapter/prompts/agents/` 保留 AstrBot SubAgent prompt 布局，按需迁入 UnderstandingSelf 的角色约束。
- 根目录 `skills/` 保留 AstrBot 可见 skill 布局。
- `pages/dashboard/` 保留 AstrBot 插件页构建产物布局。

本轮可复用的 UnderstandingSelf 内容：

- 新版 `packages/dashboard/src/` 作为 Dashboard 主体基线，但所有数据访问必须适配 AstrBot `pluginGet` / `pluginPost`。
- `packages/server/src/quality.ts`、`domain-analysis-ir.ts`、`assistant-context.ts`、`assistant-context-bundle.ts` 中的确定性校验、Domain IR、上下文净化能力，迁入 `understand-anything/` runtime，不迁入 server 宿主。
- `packages/assistant/src/` 的 assistant prompt/context builder，迁入或复用为 AstrBot runtime 能力，并替换 KimiCode 文案。
- `agents/domain-analyzer.md` 与 `skills/understand-domain/SKILL.md` 的 IR-first domain 工作流，适配 `$UA_GRAPH_ROOT/intermediate/domain-analysis.json`。

本轮禁止引入：

- KimiCode 进程探测、Kimi server 管理 API、Kimi container runner。
- `UnderstandingSelf/understand-anything-plugin/packages/server` 作为运行时宿主。
- 与 AstrBot 插件页无关的 standalone management routes。
- 覆盖 AstrBot 现有配置、Provider/SubAgent 注册、Runner、WebAPI 或 graphRoot 路径模型的上游宿主逻辑。

贡献者落点约定：

- 可复用 runtime 代码放入 `understand-anything/`，优先用 TypeScript action 暴露给 Python runner。
- AstrBot 需要执行的 agent prompt 放入 `astrbot_adapter/prompts/agents/`。
- 用户可见 skill 指令放入根目录 `skills/`。
- Dashboard 源码放入 `understand-anything/packages/dashboard/`。
- AstrBot 插件页构建产物放入 `pages/dashboard/`。
- 不提交 `node_modules/`、缓存、本地插件数据或机器相关临时文件。

## 目标与原则

目标是将上游 Understand-Anything 截至 `26edf61856fa476e466bda1814819a266a293c47` 的核心分析能力移植到 `astrbot_plugin_UnderstandAnything`，并形成 AstrBot 插件内统一、清晰、可持续维护的分析架构。

本地嵌入基线见 `understand-anything/UPSTREAM.json`，当前记录的上游提交为 `40519ee5ff693799ef3416cec13d205ec4d1b864`。本轮移植完成后，应将该文件更新到目标上游提交，并保留 AstrBot 插件布局策略。

插件仍处开发期，本轮以架构统一为第一优先级。旧的临时发现脚本、手工批次策略、重复路径兼容和冗余双链路不应继续保留。需要保留的是 AstrBot 宿主集成边界、SubAgents 注册逻辑、Dashboard bridge、任务进度、语言策略和 `UA_GRAPH_ROOT` 产物根模型。

## 路径映射与边界

上游到本地的映射如下：

- 上游 `understand-anything-plugin/packages/core` -> 本地 `understand-anything/packages/core`
- 上游 `understand-anything-plugin/packages/dashboard` -> 本地 `understand-anything/packages/dashboard`
- 上游 `understand-anything-plugin/src` -> 本地 `understand-anything/src`
- 上游 `understand-anything-plugin/skills/*` -> 本地 `skills/*`
- 上游 `understand-anything-plugin/agents/*` -> 本地 `astrbot_adapter/prompts/agents/*`

禁止引入上游宿主平台相关内容，包括 installers、hooks、Trae、Cline、Kimi、Claude 等平台目录。AstrBot 插件已经有自己的宿主入口、Dashboard bridge、SubAgents 注册、runner 和 job store，这些边界不应被上游通用插件结构覆盖。

Dashboard 不能整包覆盖。本地 Dashboard 已经包含 `AstrBotWorkspace`、`astrbotBridge`、`analysisRequest`、`jobTracking`、`pluginPageContext`、AstrBot WebUI locale 接入和后台 job 进度显示。上游 Dashboard 的 i18n/onboarding 只能按需 cherry-pick。

## 核心流水线

本轮核心任务是把 `/understand` 主流程从“SubAgent 自行发现项目并手工分批”改成“脚本确定性扫描 + 导入图 + 语义分批 + SubAgent 分析 + 确定性合并 + fingerprint baseline”。

需要加入并适配以下上游脚本：

- `skills/understand/scan-project.mjs`
- `skills/understand/extract-import-map.mjs`
- `skills/understand/compute-batches.mjs`
- `skills/understand/build-fingerprints.mjs`

`scan-project.mjs` 负责文件枚举、语言识别、分类、行数统计、复杂度评估和 ignore 过滤。它应使用 `git ls-files -z` 保留非 ASCII 路径，并在非 git 项目中回退到递归扫描。

`extract-import-map.mjs` 负责生成项目内部导入图，需保留上游对 TS/JS、Python、Go、Rust、Java、Kotlin、C#、Ruby、PHP、C、C++ 等语言的解析能力，并保留 tsconfig path alias 中 `"./"` 前缀的修复。

`compute-batches.mjs` 负责基于导入图的语义分批，输出稳定批次、`batchImportData` 和 `neighborMap`。该脚本依赖 `graphology` 与 `graphology-communities-louvain`，需要更新 `understand-anything/package.json` 和 `pnpm-lock.yaml`。

`build-fingerprints.mjs` 负责在写入最终 meta 前建立 fingerprint baseline。fingerprint 应写入 `UA_GRAPH_ROOT/fingerprints.json`。

`skills/understand/SKILL.md` 应被改造成调用这些脚本的主控流程。旧的 inline project discovery、inline fingerprint 生成脚本和 20-30 文件手工分批逻辑应删除，改为使用 bundled scripts 的结果。

## UA_GRAPH_ROOT 约束

AstrBot 插件的核心路径模型是：

- `PROJECT_ROOT` 只表示待分析源码根。
- `UA_GRAPH_ROOT` / `graphRoot` 是唯一图谱产物根。
- `knowledge-graph.json`、`domain-graph.json`、`meta.json`、`fingerprints.json`、`config.json`、`intermediate/`、`tmp/`、review 文件和批次输出都必须写入 `UA_GRAPH_ROOT`。

新增脚本必须显式接收 graph root。推荐接口：

- `scan-project.mjs <projectRoot> <outputPath> <graphRoot>`
- `extract-import-map.mjs <inputPath> <outputPath>`
- `compute-batches.mjs <projectRoot> --graph-root=<graphRoot>`
- `build-fingerprints.mjs <inputPath> --graph-root=<graphRoot>`

如果脚本保留 fallback，只能在没有 host graphRoot 时回退到 `PROJECT_ROOT/.understand-anything`。在 AstrBot runner 已提供 graphRoot 的路径下，不得写入 `PROJECT_ROOT/.understand-anything`。

Ignore 规则应读取 `UA_GRAPH_ROOT/.understandignore`，并可结合 `PROJECT_ROOT/.understandignore` / `.gitignore` 作为输入来源。用户在 Dashboard 或聊天确认的 `.understandignore` 已由 host 写入 graphRoot，扫描脚本必须消费这个文件。

## Prompt 与 SubAgents

所有 AstrBot agent prompt frontmatter 中的 `model: inherit` 都应删除。角色名、文件名和 SubAgents 注册所需的 prompt 路径不能改变。该改动来自上游修复：避免非 Claude 工具把 `inherit` 当作非法模型 id。

`astrbot_adapter/prompts/agents/project-scanner.md` 应改为消费确定性扫描结果，不再要求 SubAgent 自行编写文件发现脚本。它的职责是汇总 scan/import/batch 前置结果，写出 `$UA_GRAPH_ROOT/intermediate/scan-result.json`。

`astrbot_adapter/prompts/agents/file-analyzer.md` 应支持：

- 输入 `batchFiles`
- 输入 `batchImportData`
- 输入 `neighborMap`
- 使用 `extract-structure.mjs` 做结构提取
- 使用 `batchImportData[filePath]` 原样生成内部 import edges
- 大批次可输出 `batch-<batchIndex>-part-<partIndex>.json`
- 普通批次输出 `batch-<batchIndex>.json`
- 写完后必须检查输出文件存在

`skills/understand/SKILL.md` 中调用 `ua_run_subagent_role` 和 `ua_run_subagent_batches` 的方式应保留。每个 batch 仍应显式传入 `expected_output_path`。如果允许多段输出，主控流程必须在 expected output 之外也接受符合命名规则的 part 文件，并交给 merge 脚本统一处理。

语言策略保持本地 AstrBot 逻辑：`output_locale=auto` 时按“显式配置 > 请求/WebUI locale > 聊天推断 > zh-CN fallback”。不要强制中文。英文 WebUI 或英文请求产生英文分析产物是预期行为。

## 批次合并与结构提取

`skills/understand/merge-batch-graphs.py` 本地版本已经包含 AstrBot 适配，不能被上游文件整体覆盖。需要移植的是上游多段 batch 能力：

- 识别 `batch-<N>.json`
- 识别 `batch-<N>-part-<K>.json`
- 按 logical batch 聚合 part 文件
- 检测缺失 part 序号并写入 warning
- 忽略并报告非法 batch 文件名，例如 fused 或临时文件

必须保留本地能力：

- 命令形式 `python merge-batch-graphs.py <project-root> <graph-root>`
- 从 `$UA_GRAPH_ROOT/intermediate` 读取批次
- 输出 `$UA_GRAPH_ROOT/intermediate/assembled-graph.json`
- canonical edge direction
- import edge recovery
- tested_by 关系恢复

`skills/understand/extract-structure.mjs` 也不能整体覆盖。需要移植上游两处修复：

- symlink-safe CLI 检测，避免通过 symlinked `SKILL_DIR` 调用时 main 不执行
- 写出结果后的输出存在性校验

本地 `runtimeRoot` 和 `understand-anything` workspace dependency 解析逻辑必须保留。

## Dashboard 取舍

本轮 Dashboard 只处理与核心移植相关的必要项：

- 如果 Tailwind v4 检测需要，可 cherry-pick 上游 `index.css` 的 `@source` 配置。
- 如果构建依赖要求，可评估 Vite/Astro 版本更新，但必须通过本地 Dashboard 测试。

本轮不移植上游 Dashboard 的完整 i18n 框架和 onboarding overlay。若后续需要 onboarding，应接入本地 `i18n/messages.ts` 和 `AstrBotWorkspace`，避免引入第二套 locale 系统。

## Runner 与验收

`astrbot_adapter/runner.py` 是高影响修改面。GitNexus 对 `_build_skill_execution_prompt`、`_ensure_graph_root_defaults`、`_validate_required_outputs` 的影响分析均为 CRITICAL。实现时应小步修改，并围绕 graphRoot 和语言策略补测试。

Runner 需要确保：

- 作业开始前创建 `UA_GRAPH_ROOT`
- host prompt 明确传递 `PROJECT_ROOT` 与 `UA_GRAPH_ROOT`
- skill prompt 中所有 `$PROJECT_ROOT/.understand-anything` 都被解释为 `$UA_GRAPH_ROOT`
- `understand` 作业完成后要求存在并可读取：
  - `knowledge-graph.json`
  - `meta.json`
  - `fingerprints.json`

现有 SubAgents 注册修复必须保持：宿主已有所需 SubAgents 时，Dashboard 状态应显示 satisfied，不应提示必须重新注册。

## 测试要求

必须补充或更新测试：

- `tests/test_adapter.py`
  - `UA_GRAPH_ROOT` 被注入 prompt
  - `output_locale` 行为不变
  - `understand` 作业缺少 `meta.json` 或 `fingerprints.json` 会失败
  - 已注册 SubAgents 仍被识别
  - Dashboard/API 传入 locale 后分析语言正确
- `skills/understand/test_merge_batch_graphs.py`
  - `batch-1.json` 正常合并
  - `batch-1-part-1.json` + `batch-1-part-2.json` 正常合并
  - 缺失 `part-2` 时产生 warning
  - 非法 batch 文件名被忽略并报告
  - `<project-root> <graph-root>` 参数仍生效
- Node smoke tests 或等价脚本验证：
  - 非 ASCII 路径可扫描
  - graphRoot `.understandignore` 生效
  - tsconfig `"./src/*"` alias 可解析
  - semantic batches 稳定生成 `batchImportData` 和 `neighborMap`
  - symlinked `SKILL_DIR` 下 `extract-structure.mjs` 可运行

推荐验收命令：

```bash
uv run pytest data/plugins/astrbot_plugin_UnderstandAnything/tests/test_adapter.py -q
uv run pytest data/plugins/astrbot_plugin_UnderstandAnything/skills/understand/test_merge_batch_graphs.py -q
cd data/plugins/astrbot_plugin_UnderstandAnything/understand-anything && pnpm install --frozen-lockfile
cd data/plugins/astrbot_plugin_UnderstandAnything/understand-anything && pnpm test
cd data/plugins/astrbot_plugin_UnderstandAnything/understand-anything && pnpm build
ruff format data/plugins/astrbot_plugin_UnderstandAnything
ruff check data/plugins/astrbot_plugin_UnderstandAnything
```

## 完成定义

本轮完成时应满足：

- `/understand` 主流程使用上游确定性扫描、导入图、语义分批和 fingerprint baseline。
- 所有分析产物在 AstrBot 提供 graphRoot 时都写入 `UA_GRAPH_ROOT`。
- 旧的手工 discovery/batching/fingerprint 内联逻辑已清理。
- 多段 batch 输出可被合并。
- SubAgents 已注册状态判断不回退。
- Dashboard 仍能发起作业、确认 `.understandignore`、展示进度、读取完成图谱。
- 中英文输出语言行为保持现有预期。
- `UPSTREAM.json` 指向目标上游 commit。
