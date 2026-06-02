# AstrBot UnderstandingSelf Dashboard Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 将 `astrbot_plugin_UnderstandAnything` 改造成 AstrBot-native 的 UnderstandingSelf 新 dashboard 版本，同时迁入受控内容构建、强校验、Domain IR 编译和项目状态机能力。

**架构：** 保留 AstrBot 插件宿主边界，由 Python `astrbot_adapter` 负责任务编排、AstrBot WebAPI、项目注册和 SubAgent 调度；由 TypeScript `understand-anything` runtime 负责图谱规范化、源码清单、Domain IR 编译、指纹和质量报告等确定性产物治理；由 React dashboard 复用 `UnderstandingSelf` 新界面并接入 AstrBot plugin page bridge。

**技术栈：** AstrBot Python plugin, Python 3.10+, Node.js 22+, pnpm 10+, TypeScript, React 19, Vite, Vitest, pytest.

---

## 0. Review Status

This document is a reviewable migration plan. Do not execute implementation tasks until the user approves the plan.

Current target repository:

- `D:\AboutDEV\understanding\astrbot_plugin_UnderstandAnything`
- Git remote: `https://github.com/AstralSolipsism/astrbot_plugin_UnderstandAnything.git`
- Current cloned branch: `main`

Reference repository:

- `D:\AboutDEV\understanding\UnderstandingSelf`
- Reference plugin root: `D:\AboutDEV\understanding\UnderstandingSelf\understand-anything-plugin`

## 1. Source Baseline And Boundaries

### 1.1 Preserve From AstrBot Plugin

These files and responsibilities stay owned by the target plugin:

- `main.py`: AstrBot plugin lifecycle and command registration.
- `metadata.yaml`, `_conf_schema.json`, `requirements.txt`: AstrBot distribution metadata and configuration.
- `astrbot_adapter/runtime.py`: Node runtime bootstrap and `run_action()` bridge orchestration.
- `astrbot_adapter/web_api.py`: AstrBot plugin page WebAPI.
- `astrbot_adapter/runner.py`: AstrBot job orchestration, provider/SubAgent execution, confirmation flow, GitHub/local source handling.
- `astrbot_adapter/job_store.py`: job state storage, extended by this plan.
- `astrbot_adapter/project_registry.py`: project registry, extended by this plan.
- `astrbot_adapter/prompts/agents/`: AstrBot SubAgent prompts, updated to remove KimiCode assumptions.
- Root `skills/`: AstrBot-visible user skills and content generation instructions.
- `pages/dashboard/`: committed AstrBot plugin page build output.

Acceptance:

- Existing AstrBot command behavior remains wired through `main.py`.
- No Kimi server, container server, or `UnderstandingSelf/packages/server` process manager is introduced into the plugin runtime.
- Existing AstrBot provider/SubAgent configuration remains the source of model execution.

### 1.2 Reuse From UnderstandingSelf

Reuse these parts from `D:\AboutDEV\understanding\UnderstandingSelf\understand-anything-plugin`:

- `packages/dashboard/src/`: new dashboard UI, Canvas, graph scene, assistant workbench, project portal, workers, locales, markdown rendering, job observations.
- `packages/dashboard/package.json`: dependency additions such as `leafer-ui`, `lucide-react`, `@ai-sdk/react`, and `ai` only where they are still needed after AstrBot bridge adaptation.
- `packages/server/src/quality.ts`: source inventory, graph repair/quality assessment, visible content validation, fingerprint candidate collection.
- `packages/server/src/domain-analysis-ir.ts`: constrained DomainAnalysisIR schema, normalization and deterministic domain graph compilation.
- `packages/server/src/assistant-context.ts`: assistant context item sanitization and graph/file scope validation.
- `packages/server/src/assistant-context-bundle.ts`: context bundle discipline, reused conceptually and adapted to AstrBot runtime action payloads.
- `packages/assistant/src/`: deterministic assistant prompt/context builders, with KimiCode wording replaced by AstrBot wording.
- `agents/domain-analyzer.md` and `skills/understand-domain/SKILL.md`: IR-first domain workflow, adapted to `$UA_GRAPH_ROOT`.

Acceptance:

- Reused code is adapted to target package boundaries under `understand-anything/`.
- Imports target `@understand-anything/core` and target local modules, not `packages/server`.
- User-visible references to KimiCode are removed or replaced with AstrBot provider/SubAgent wording.

### 1.3 Explicit Non-Goals

Do not port these `UnderstandingSelf` server-host features:

- KimiCode process probing.
- KimiCode server management APIs.
- KimiCode Docker/container runner.
- Standalone management UI routes unrelated to AstrBot plugin pages.
- Any deployment workflow unrelated to AstrBot plugin packaging.

Acceptance:

- `rg -n "Kimi|kimi|KIMI|Claude|claude" astrbot_adapter understand-anything packages pages skills` only returns allowed historical notes or intentionally adapted text.
- No new long-running server process is required outside AstrBot and the existing Node runtime action bridge.

## 2. Target Architecture

### 2.1 Runtime Ownership Split

Python owns orchestration:

- source checkout/fetch/cleanup
- job creation, confirmation, cancellation and progress
- project registration and status
- AstrBot provider/SubAgent execution
- WebAPI serialization

TypeScript owns deterministic content governance:

- graph normalization and `validateGraph`
- source inventory generation
- graph quality repair/assessment
- DomainAnalysisIR normalization and compilation
- fingerprint generation/verification
- quality report generation
- assistant context sanitization

Dashboard owns presentation and user workflow:

- project selection and project state display
- job observation timeline
- graph/canvas rendering
- assistant workbench
- analysis/diff/onboard controls

Acceptance:

- Python code does not reimplement large graph/domain validation algorithms that already exist in TypeScript.
- TypeScript runtime actions are invoked through `astrbot_adapter/runtime.py` and `astrbot_adapter/node/bridge.mjs`.
- Dashboard calls AstrBot plugin APIs through `pluginGet` and `pluginPost`.

### 2.2 Job Flow

Approved final flow for a normal `understand` job:

1. Python creates a queued job and project status.
2. Python prepares source and `UA_GRAPH_ROOT`.
3. TypeScript runtime preflight builds `source-inventory.json`.
4. AstrBot SubAgent/provider performs analysis and writes candidate graph/meta/domain IR files.
5. TypeScript runtime validates and normalizes outputs.
6. TypeScript runtime compiles DomainAnalysisIR when present.
7. TypeScript runtime regenerates or verifies `fingerprints.json`.
8. TypeScript runtime writes `quality-report.json`.
9. Python marks job/project succeeded only if runtime validation passes.

Acceptance:

- A job cannot finish successfully when required final files are missing or invalid.
- A failed validation produces structured job observations and a clear failed project state.
- Final files under `UA_GRAPH_ROOT` are deterministic outputs of the validator, not just unchecked model output.

## 3. Dashboard Migration

### 3.1 Dashboard Source Strategy

Use `UnderstandingSelf/understand-anything-plugin/packages/dashboard/src` as the primary source baseline. Keep target AstrBot-specific modules and adapt them into the new UI:

- Target AstrBot bridge: `understand-anything/packages/dashboard/src/utils/astrbotBridge.ts`
- Target plugin page context: `understand-anything/packages/dashboard/src/utils/pluginPageContext.ts`
- Target analysis request helpers: `understand-anything/packages/dashboard/src/utils/analysisRequest.ts`
- Target job tracking helpers, extended for observations and project status.

Acceptance:

- New dashboard UI exposes project portal, graph/canvas view, domain graph, assistant workbench, job observations and existing AstrBot actions.
- Dashboard build remains `base: "./"` and is usable as an AstrBot Plugin Page.
- Dashboard does not call raw `/api/...` server endpoints that are absent in AstrBot.

### 3.2 Dashboard API Adaptation

Required bridge behavior:

- `status`: returns runtime/provider/subagent readiness.
- `projects`: returns project summaries with status, counts, current job and last error.
- `jobs`: returns job snapshots with observations.
- `jobs/start`: starts analysis through AstrBot runner.
- `jobs/<job_id>`: returns job details.
- `jobs/<job_id>/confirm`: keeps existing confirmation flow.
- `jobs/<job_id>/events`: streams or polls structured job updates.
- `chat`, `explain`, `diff`, `onboard`: remain AstrBot-backed assistant actions.
- `file-content`: keeps target safe source preview behavior.
- `runtime/repair`: keeps target dependency repair.

Acceptance:

- Existing dashboard tests for `astrbotBridge`, `analysisRequest`, and `jobTracking` are updated and pass.
- New dashboard components receive the data they require without depending on `packages/server`.
- If streaming assistant UX is not implemented in the first pass, non-streaming AstrBot assistant responses are shown through the same assistant panel states.

### 3.3 Dashboard Build Artifacts

Build and distribution rule:

- Runtime dashboard source remains in `understand-anything/packages/dashboard/`.
- Vite build output remains in `understand-anything/packages/dashboard/dist/`.
- AstrBot plugin page output is copied into `pages/dashboard/`.

Acceptance:

- `pnpm --dir understand-anything/packages/dashboard build` succeeds.
- `pages/dashboard/index.html` and static assets are refreshed after build.
- `pages/dashboard/` does not contain source maps or local-only dev files unless the existing packaging policy explicitly allows them.

## 4. Project And Job State Machine

### 4.1 Project Status

Add project status compatible with the new dashboard:

- `empty`: project registered but no successful graph yet.
- `cloning`: source is being cloned/fetched.
- `analyzing`: analysis or validation is running.
- `ready`: last analysis succeeded and graph files are valid.
- `stale`: source has updates compared with stored fingerprints or commit metadata.
- `failed`: latest operation failed.
- `deleting`: delete operation is in progress.

Target storage location:

- Extend `astrbot_adapter/project_registry.py` `ProjectRecord`, or create a focused `astrbot_adapter/project_state.py` if extending the registry would make it too large.

Acceptance:

- Project summaries include `status`, `current_job_id`, `last_job_id`, `last_error`, `last_analyzed_at`, `node_count`, `edge_count`, and `graph_root`.
- Existing registry lookup by `project_id`, `project_name`, `project_path`, and alias remains compatible.
- Delete and refresh operations update project status coherently.

### 4.2 Job Observations

Add structured observations model similar to UnderstandingSelf:

Fields:

- `id`
- `timestamp`
- `kind`: `stage`, `validation`, `quality`, `artifact`, `warning`, `error`, `assistant`, `system`
- `level`: `info`, `success`, `warning`, `error`
- `title`
- `message`
- `stage`
- `status`
- `details`

Target storage location:

- Extend `astrbot_adapter/job_store.py` `JobSnapshot`.
- Serialize observations through `astrbot_adapter/web_api.py`.

Acceptance:

- Logs remain available for backward compatibility.
- Observations are included in `jobs`, `jobs/<job_id>`, and job events.
- A failed runtime validation produces at least one `level: "error"` observation with stage `validate`.

### 4.3 Job Status Compatibility

Keep target job statuses for compatibility:

- `queued`
- `running`
- `waiting_confirmation`
- `finished`
- `failed`
- `cancelled`

Add derived fields rather than renaming statuses:

- `phase`
- `phase_label`
- `percent`
- `observations`
- `terminal`

Acceptance:

- Existing tests expecting `finished` still pass.
- New dashboard can map source-style `succeeded` concepts to target `finished`.

## 5. Content Construction And Validation Pipeline

### 5.1 New Runtime Validation Modules

Create focused TypeScript modules under target runtime:

- Create `understand-anything/src/validation/quality.ts`
- Create `understand-anything/src/validation/domain-analysis-ir.ts`
- Create `understand-anything/src/validation/output-pipeline.ts`
- Create `understand-anything/src/validation/source-inventory.ts` if source inventory is split from `quality.ts`
- Create `understand-anything/src/validation/quality-report.ts` if report generation is split from `quality.ts`
- Create tests under `understand-anything/src/validation/__tests__/`

Reference files:

- `..\UnderstandingSelf\understand-anything-plugin\packages\server\src\quality.ts`
- `..\UnderstandingSelf\understand-anything-plugin\packages\server\src\quality.test.ts`
- `..\UnderstandingSelf\understand-anything-plugin\packages\server\src\domain-analysis-ir.ts`
- `..\UnderstandingSelf\understand-anything-plugin\packages\server\src\domain-analysis-ir.test.ts`

Acceptance:

- `pnpm --dir understand-anything test` passes.
- Tests cover invalid paths, missing file references, self/dangling edges, duplicate node IDs, placeholder visible text, invalid DomainAnalysisIR, and final domain graph compilation.
- Runtime modules never write outside the provided project root or graph root.

### 5.2 Runtime Actions

Extend runtime bridge actions:

- Modify `understand-anything/src/index.ts` to export validation entrypoints.
- Modify `astrbot_adapter/node/bridge.mjs` to support:
  - `preflight_inventory`
  - `validate_outputs`
  - `compile_domain_ir`
  - `assistant_context_bundle`

Action payload requirements:

- `projectRoot`
- `graphRoot`
- `jobId`
- `jobKind`
- `locale`
- `expectedGitCommitHash`
- `strictVisibleLanguage`

Action response requirements:

- `ok`
- `artifacts`
- `observations`
- `quality`
- `fatal`
- `warnings`

Acceptance:

- Unsupported action still fails with `Unsupported Understand Anything bridge action`.
- Supported actions return object JSON only.
- Python runner can pass action results directly into job observations.

### 5.3 Required Artifacts

Final successful `understand` output must include:

- `knowledge-graph.json`
- `meta.json`
- `source-inventory.json`
- `fingerprints.json`
- `quality-report.json`

Final successful domain output must include:

- `intermediate/domain-analysis.json`
- `domain-graph.json`
- `quality-report.json` updated with domain results

Acceptance:

- Existing `_validate_required_outputs()` is replaced or augmented by runtime validation.
- `fingerprints.json` is generated or verified by runtime validation after graph validation.
- Invalid fingerprints cannot be accepted just because the file exists.

### 5.4 Visible Language Gate

Preserve AstrBot multilingual behavior with this rule:

- If job locale resolves to Chinese (`zh`, `zh-CN`, `zh-TW`) or auto-detection chooses Chinese, enforce Chinese visible-content ratio.
- For non-Chinese locales, enforce non-empty visible descriptions, no placeholder text, valid graph shape, valid paths, and quality report thresholds, but do not fail solely for not being Chinese.

Acceptance:

- Chinese jobs fail when visible descriptions are mostly non-Chinese or missing.
- English and other locale jobs are still strongly validated for schema, paths, quality and placeholder content.
- The selected language directive from `astrbot_adapter/runner.py` remains active in prompts.

## 6. Domain IR Migration

### 6.1 Domain Skill Contract

Change AstrBot domain workflow so the SubAgent writes constrained IR only:

- Modify `skills/understand-domain/SKILL.md`
- Modify `astrbot_adapter/prompts/agents/domain-analyzer.md`

Required output path:

- `$UA_GRAPH_ROOT/intermediate/domain-analysis.json`

Forbidden for the SubAgent:

- final `domain-graph.json`
- `nodes`
- `edges`
- `layers`
- `tour`
- final graph weights
- final graph IDs that the compiler should own

Acceptance:

- Prompt text tells the agent to produce DomainAnalysisIR only.
- Prompt text uses `$UA_GRAPH_ROOT`, not `$PROJECT_ROOT/.understand-anything`.
- Prompt text has no `model: inherit` or KimiCode-specific frontmatter.

### 6.2 Deterministic Domain Compilation

Runtime compiles `domain-analysis.json` into `domain-graph.json`.

Compiler responsibilities:

- Normalize domain, flow, step and cross-domain interaction IDs.
- Attach provenance from `sourceNodeIds`, `sourceFilePaths`, and evidence.
- Generate stable domain/flow/step nodes.
- Generate stable `contains_flow`, `flow_step`, and `cross_domain` edges.
- Validate final graph through core `validateGraph`.

Acceptance:

- Domain graph output is deterministic for the same IR input.
- Invalid IR fields that look like final graph output are rejected.
- Missing provenance is reported as warning or error according to quality severity.

## 7. Assistant Context Migration

### 7.1 Deterministic Context Builders

Add or adapt assistant modules from `UnderstandingSelf/packages/assistant`:

- `understand-anything/packages/assistant/` if a separate workspace package is preferred.
- Or `understand-anything/src/assistant/` if keeping runtime exports simple is preferred.

Recommended choice:

- Create `understand-anything/packages/assistant/` to maximize upstream reuse and keep assistant prompt logic out of the root action index.

Acceptance:

- `pnpm-workspace.yaml` already includes `packages/*`, so the new package is built by workspace filters.
- Assistant prompts say AstrBot/AstrBot provider instead of Kimi Code.
- Assistant context never exposes forbidden absolute project storage paths.

### 7.2 AstrBot Assistant API Compatibility

Existing Python runner actions remain:

- `chat`
- `explain`
- `diff`
- `onboard`

Enhancement:

- They call sanitized context builders before provider execution.
- Dashboard assistant workbench can show source snippets and selected graph context.

Acceptance:

- Existing chat/explain/diff/onboard tests continue passing.
- New tests cover rejected absolute paths and out-of-project context items.

## 8. AstrBot API Compatibility

### 8.1 Web API Extensions

Extend `astrbot_adapter/web_api.py` responses:

- `GET status`: include runtime validation readiness and provider/subagent status.
- `GET projects`: include project status fields.
- `GET jobs`: include observations.
- `GET jobs/<job_id>`: include observations and validation result.
- `GET jobs/<job_id>/events`: include observation deltas or complete snapshot events.
- `POST jobs/start`: preserve existing request shape and add optional analysis mode hints.
- `POST jobs/<job_id>/confirm`: preserve confirmation behavior.

Acceptance:

- Existing dashboard requests still work.
- New dashboard can render project portal and observation timeline without server-specific endpoints.
- API payloads are JSON-serializable and do not leak local absolute paths except approved project roots already shown by existing plugin behavior.

### 8.2 Runner Integration

Modify `astrbot_adapter/runner.py`:

- Emit observations for source setup, preflight inventory, SubAgent dispatch, validation, quality report, and completion.
- Invoke `preflight_inventory` before AI analysis.
- Invoke `validate_outputs` after AI analysis.
- Invoke `compile_domain_ir` for domain jobs.
- Update project status around clone/analyze/validate/failure.

Acceptance:

- Analysis job fails before `finished` if validation fails.
- Project status becomes `ready` only after validation success.
- Project status becomes `failed` with `last_error` on validation or provider failure.
- Cancellation still sets job status `cancelled`.

## 9. Verification Matrix

Run these checks after implementation:

```powershell
python -m pytest tests -q
```

Expected:

- All Python adapter tests pass.

```powershell
pnpm --dir understand-anything install --frozen-lockfile
pnpm --dir understand-anything build
pnpm --dir understand-anything test
```

Expected:

- Runtime builds.
- Runtime validation and existing core/action tests pass.

```powershell
pnpm --dir understand-anything/packages/dashboard build
pnpm --dir understand-anything/packages/dashboard test
```

Expected:

- Dashboard builds.
- Dashboard bridge and UI utility tests pass.

Manual AstrBot smoke acceptance:

- Open plugin dashboard page.
- Start a local project analysis.
- Observe project status moving through queued/running/analyzing/ready.
- Observe structured job observations.
- Confirm `UA_GRAPH_ROOT` contains expected artifacts.
- Open graph, domain graph if generated, assistant workbench, file preview, explain, diff and onboard actions.
- Trigger an invalid graph fixture and confirm the job fails with validation observations.

## 10. Implementation Steps And Section Mapping

### Task 1: Baseline And Guardrails

**Plan Sections:** 1, 2, 9

**Files:**

- Modify: `UA_UPSTREAM_PORTING_GUIDE.md`
- Create: `docs/upstream/understandingself-dashboard-port-notes.md`

- [ ] Record the exact reference commit and target commit used for the migration.
- [ ] List preserved AstrBot-owned files and excluded Kimi/server features.
- [ ] Add a short contributor note that runtime reusable code should go under `understand-anything/`, AstrBot prompts under `astrbot_adapter/prompts/agents/`, and plugin page output under `pages/dashboard/`.

**Acceptance:**

- `git diff -- UA_UPSTREAM_PORTING_GUIDE.md docs/upstream/understandingself-dashboard-port-notes.md` shows only documentation changes.
- The documentation states that `packages/server` is not ported as a runtime host.

### Task 2: Runtime Validation Modules

**Plan Sections:** 5, 6

**Files:**

- Create: `understand-anything/src/validation/quality.ts`
- Create: `understand-anything/src/validation/domain-analysis-ir.ts`
- Create: `understand-anything/src/validation/output-pipeline.ts`
- Create: `understand-anything/src/validation/__tests__/quality.test.ts`
- Create: `understand-anything/src/validation/__tests__/domain-analysis-ir.test.ts`
- Modify: `understand-anything/tsconfig.json` if new include rules are needed.

- [ ] Port source inventory, graph quality, visible content validation and DomainAnalysisIR logic from the reference server files.
- [ ] Adapt imports to target `@understand-anything/core`.
- [ ] Add tests for invalid graph shape, invalid file paths, duplicate node IDs, placeholder text, invalid DomainAnalysisIR and deterministic domain graph compilation.

**Acceptance:**

- `pnpm --dir understand-anything test` passes.
- Tests fail if `domain-analysis.json` includes final graph fields such as `nodes` or `edges`.
- Tests fail if a knowledge graph references files outside the project inventory.

### Task 3: Runtime Bridge Actions

**Plan Sections:** 2.1, 5.2

**Files:**

- Modify: `understand-anything/src/index.ts`
- Modify: `astrbot_adapter/node/bridge.mjs`
- Create: `understand-anything/src/__tests__/validation-actions.test.ts`

- [ ] Export `preflight_inventory`, `validate_outputs`, `compile_domain_ir`, and `assistant_context_bundle` entrypoints.
- [ ] Add bridge cases for the new action names.
- [ ] Return structured action responses with `ok`, `observations`, `artifacts`, `quality`, `fatal`, and `warnings`.

**Acceptance:**

- `node astrbot_adapter/node/bridge.mjs understand-anything validate_outputs <payload.json>` returns object JSON for a valid fixture.
- Unsupported actions still throw `Unsupported Understand Anything bridge action`.
- `pnpm --dir understand-anything build` passes.

### Task 4: Job Observations And Project Status

**Plan Sections:** 4, 8.1

**Files:**

- Modify: `astrbot_adapter/job_store.py`
- Modify: `astrbot_adapter/project_registry.py`
- Modify: `astrbot_adapter/web_api.py`
- Modify: `tests/test_adapter.py`

- [ ] Add `JobObservation` serialization.
- [ ] Add observation append/update helpers.
- [ ] Add project status fields and update serialization.
- [ ] Preserve existing job status names.

**Acceptance:**

- `python -m pytest tests -q` passes.
- Tests verify `jobs` and `jobs/<job_id>` include observations.
- Tests verify project summaries include `status`, `current_job_id`, `last_error`, `node_count`, and `edge_count`.

### Task 5: Runner Validation Pipeline

**Plan Sections:** 2.2, 5.3, 5.4, 8.2

**Files:**

- Modify: `astrbot_adapter/runner.py`
- Modify: `tests/test_adapter.py`

- [ ] Invoke preflight inventory before provider/SubAgent analysis.
- [ ] Invoke validation after provider/SubAgent output.
- [ ] Update project status around source, analysis, validation and failure.
- [ ] Convert runtime validation observations into job observations.
- [ ] Replace existence-only output validation with runtime validation for graph, meta, fingerprints and quality report.

**Acceptance:**

- `python -m pytest tests -q` passes.
- A valid fixture job reaches `finished` and project status `ready`.
- A fixture with invalid fingerprints fails validation.
- A fixture with mostly non-Chinese visible text fails when locale is Chinese.
- A non-Chinese locale fixture still passes when schema, paths and quality are valid.

### Task 6: Domain IR Prompt And Skill

**Plan Sections:** 6

**Files:**

- Modify: `skills/understand-domain/SKILL.md`
- Modify: `astrbot_adapter/prompts/agents/domain-analyzer.md`
- Modify: `tests/test_adapter.py`

- [ ] Change domain skill to require `$UA_GRAPH_ROOT/intermediate/domain-analysis.json`.
- [ ] Remove instructions that ask the agent to write final `domain-graph.json`.
- [ ] Remove KimiCode-specific or `model: inherit` assumptions.
- [ ] Ensure prompt forbids final graph fields and explains that runtime compiles the final graph.

**Acceptance:**

- `rg -n "domain-graph.json|model: inherit|Kimi|kimi" skills/understand-domain/SKILL.md astrbot_adapter/prompts/agents/domain-analyzer.md` shows no forbidden instructions except explanatory text saying the runtime, not the agent, writes `domain-graph.json`.
- Domain job tests confirm the runner expects IR and compiles final domain graph through runtime action.

### Task 7: Assistant Context And Prompt Builders

**Plan Sections:** 7

**Files:**

- Create: `understand-anything/packages/assistant/package.json`
- Create: `understand-anything/packages/assistant/src/index.ts`
- Create: `understand-anything/packages/assistant/src/context.ts`
- Create: `understand-anything/packages/assistant/src/__tests__/context.test.ts`
- Modify: `understand-anything/src/index.ts`
- Modify: `astrbot_adapter/node/bridge.mjs`
- Modify: `astrbot_adapter/runner.py`

- [ ] Port assistant context builders from reference package.
- [ ] Replace KimiCode wording with AstrBot provider/SubAgent wording.
- [ ] Sanitize context items and reject out-of-project absolute paths.
- [ ] Keep existing chat/explain/diff/onboard behavior available through AstrBot APIs.

**Acceptance:**

- `pnpm --dir understand-anything build` passes.
- `pnpm --dir understand-anything test` passes.
- Python tests verify assistant actions continue to return markdown and do not leak forbidden absolute paths.

### Task 8: Dashboard Source Port

**Plan Sections:** 3, 8.1

**Files:**

- Replace/adapt: `understand-anything/packages/dashboard/src/`
- Modify: `understand-anything/packages/dashboard/package.json`
- Modify: `understand-anything/pnpm-lock.yaml`
- Modify: `understand-anything/packages/dashboard/vite.config.ts`
- Modify tests under `understand-anything/packages/dashboard/src/**/__tests__/`

- [ ] Import the new dashboard source baseline from reference.
- [ ] Reconnect all data reads/writes through target `astrbotBridge.ts`.
- [ ] Adapt project portal and job observation components to target job/project schema.
- [ ] Replace Kimi labels and server management states with AstrBot provider/SubAgent/runtime states.
- [ ] Keep safe file preview and plugin page asset-token behavior.

**Acceptance:**

- `pnpm --dir understand-anything/packages/dashboard build` passes.
- `pnpm --dir understand-anything/packages/dashboard test` passes.
- `rg -n "/api/|Kimi|kimi|management" understand-anything/packages/dashboard/src` shows no unadapted server-only calls or Kimi labels.

### Task 9: Plugin Page Artifact Refresh

**Plan Sections:** 3.3, 9

**Files:**

- Modify generated output: `understand-anything/packages/dashboard/dist/`
- Modify generated output: `pages/dashboard/`
- Modify: `README.md` only if build instructions change.

- [ ] Build dashboard production output.
- [ ] Copy the production output into `pages/dashboard/`.
- [ ] Ensure no `node_modules`, local cache or machine-specific files are committed.

**Acceptance:**

- `Test-Path pages/dashboard/index.html` returns `True`.
- `git status --short pages/dashboard understand-anything/packages/dashboard/dist` shows refreshed build artifacts only.
- Opening the plugin page through AstrBot loads the new dashboard shell.

### Task 10: End-To-End Verification

**Plan Sections:** 9

**Files:**

- Modify: `tests/test_adapter.py`
- Create: `tests/fixtures/validation/` fixture files if existing tests need stable invalid/valid graph samples.

- [ ] Run Python tests.
- [ ] Run runtime build and tests.
- [ ] Run dashboard build and tests.
- [ ] Run manual AstrBot smoke test for local analysis, domain analysis, assistant actions and invalid output failure.

**Acceptance:**

- `python -m pytest tests -q` passes.
- `pnpm --dir understand-anything build` passes.
- `pnpm --dir understand-anything test` passes.
- `pnpm --dir understand-anything/packages/dashboard build` passes.
- `pnpm --dir understand-anything/packages/dashboard test` passes.
- Manual smoke evidence confirms dashboard, status machine, observations and validation artifacts work in AstrBot.

## 11. Approval Gate

Before implementation starts, confirm these choices:

1. Use the recommended split: AstrBot Python orchestrates, TypeScript runtime validates and compiles, React dashboard presents.
2. Use the Chinese hard language gate only for Chinese-resolved jobs; use schema/path/quality/non-empty gates for other locales.
3. Create `understand-anything/packages/assistant/` for assistant reuse rather than mixing all assistant code into root `src`.
4. Keep target job statuses compatible and add project status/observations as additional fields.

Implementation should start with Task 1 after approval and stop for review after Task 3, Task 6, Task 8, and Task 10.
