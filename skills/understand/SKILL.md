---
name: understand
description: Analyze a codebase to produce an interactive knowledge graph for understanding architecture, components, and relationships
argument-hint: ["[path] [--full|--auto-update|--no-auto-update|--review]"]
---

# /understand

Analyze the current codebase and produce a `knowledge-graph.json` file in the configured Understand Anything graph output root. This file powers the interactive dashboard for exploring the project's architecture.

## Options

- `$ARGUMENTS` may contain:
  - `--full` — Force a full rebuild, ignoring any existing graph
  - `--auto-update` — Enable automatic graph updates on commit (writes `autoUpdate: true` to the graph output config)
  - `--no-auto-update` — Disable automatic graph updates (writes `autoUpdate: false` to the graph output config)
  - `--review` — Run full LLM graph-reviewer instead of inline deterministic validation
  - A directory path (e.g. `/path/to/repo` or `../other-project`) — Analyze the given directory instead of the current working directory

---

## AstrBot SubAgent Dispatch

This skill runs inside AstrBot as a supervisor. Do not perform worker roles directly in the supervisor context.

- For one worker role, call `ua_run_subagent_role(role, input, expected_output_path)`.
- For repeated file batches, call `ua_run_subagent_batches(role="file-analyzer", batches=[...], max_concurrency=<AstrBot host configured file-agent concurrency, default 5>, continue_on_error=true)`.
- Each batch object must include `id`, `input`, and `expected_output_path`.
- Continue only after the SubAgent tool returns. Treat `failed` or `missing_output` results as phase warnings unless the phase explicitly requires stopping.

## Phase 0 — Pre-flight

Determine whether to run a full analysis or incremental update.

1. **Resolve `PROJECT_ROOT`:**
   - Parse `$ARGUMENTS` for a non-flag token (any argument that does not start with `--`). If found, treat it as the target directory path.
     - If the path is relative, resolve it against the current working directory.
     - Verify the resolved path exists and is a directory (run `test -d <path>`). If it does not exist or is not a directory, report an error to the user and **STOP**.
     - Set `PROJECT_ROOT` to the resolved absolute path.
   - If no directory path argument is found, set `PROJECT_ROOT` to the current working directory.
   - **Worktree redirect.** If `PROJECT_ROOT` is inside a git worktree (not the main checkout), redirect output to the main repository root. Ephemeral tool-managed worktrees can be removed after a session, so `.understand-anything/` written there is destroyed when the session ends, taking the knowledge graph with it (issue #133). Detect a worktree by comparing `git rev-parse --git-dir` against `git rev-parse --git-common-dir`; in a normal checkout or submodule they resolve to the same path, in a worktree they differ and the parent of `--git-common-dir` is the main repo root.

     ```bash
     COMMON_DIR=$(git -C "$PROJECT_ROOT" rev-parse --git-common-dir 2>/dev/null)
     GIT_DIR=$(git -C "$PROJECT_ROOT" rev-parse --git-dir 2>/dev/null)
     if [ -n "$COMMON_DIR" ] && [ -n "$GIT_DIR" ]; then
       COMMON_ABS=$(cd "$PROJECT_ROOT" && cd "$COMMON_DIR" 2>/dev/null && pwd -P)
       GIT_ABS=$(cd "$PROJECT_ROOT" && cd "$GIT_DIR" 2>/dev/null && pwd -P)
       if [ -n "$COMMON_ABS" ] && [ "$COMMON_ABS" != "$GIT_ABS" ]; then
         MAIN_ROOT=$(dirname "$COMMON_ABS")
         if [ -d "$MAIN_ROOT" ] && [ "${UNDERSTAND_NO_WORKTREE_REDIRECT:-0}" != "1" ]; then
           echo "[understand] Detected git worktree at $PROJECT_ROOT"
           echo "[understand] Redirecting output to main repo root: $MAIN_ROOT"
           echo "[understand] (Set UNDERSTAND_NO_WORKTREE_REDIRECT=1 to keep PROJECT_ROOT as the worktree.)"
           PROJECT_ROOT="$MAIN_ROOT"
         fi
       fi
     fi
     ```

     Set `UNDERSTAND_NO_WORKTREE_REDIRECT=1` if you intentionally want a per-worktree graph (rare — most users want the redirect).

1.2. **Resolve `UA_GRAPH_ROOT`:**
   - If the AstrBot host prompt provides `UA_GRAPH_ROOT`, use it exactly as the graph output root.
   - If no host value is available, set `UA_GRAPH_ROOT="$PROJECT_ROOT/.understand-anything"`.
   - Use `$PROJECT_ROOT` only for source files and git state.
   - Use `$UA_GRAPH_ROOT` for every Understand Anything artifact: `knowledge-graph.json`, `domain-graph.json`, `meta.json`, `fingerprints.json`, `config.json`, `intermediate/`, `tmp/`, reviews, and batch outputs.
1.5. **Verify the bundled runtime is ready.** The AstrBot host adapter checks and repairs the runtime before starting this workflow. Later phases invoke Node scripts that import `@understand-anything/core`. In AstrBot, the plugin root is the `astrbot_plugin_UnderstandAnything` directory and the bundled runtime is always at `<PLUGIN_ROOT>/understand-anything`.

   Resolve paths from the AstrBot plugin layout:

   ```bash
   PLUGIN_ROOT="<ASTRBOT_PLUGIN_ROOT>"
   RUNTIME_ROOT="$PLUGIN_ROOT/understand-anything"
   SKILL_DIR="$PLUGIN_ROOT/skills/understand"
   AGENT_PROMPTS_DIR="$PLUGIN_ROOT/astrbot_adapter/prompts/agents"

   if [ ! -f "$RUNTIME_ROOT/package.json" ] || [ ! -f "$RUNTIME_ROOT/pnpm-lock.yaml" ]; then
     echo "Error: Cannot find bundled Understand Anything runtime at $RUNTIME_ROOT"
     exit 1
   fi

   if [ ! -d "$RUNTIME_ROOT/node_modules" ] || [ ! -f "$RUNTIME_ROOT/packages/core/dist/index.js" ] || [ ! -f "$RUNTIME_ROOT/dist/index.js" ]; then
     echo "Error: Understand Anything runtime is incomplete. Use the plugin Dashboard runtime repair action, then retry."
     exit 1
   fi
   ```

2. Get the current git commit hash:
   ```bash
   git rev-parse HEAD
   ```
3. Create the intermediate and temp output directories:
   ```bash
   mkdir -p $UA_GRAPH_ROOT/intermediate
   mkdir -p $UA_GRAPH_ROOT/tmp
   ```
3.5. **Auto-update configuration:**
   - If `--auto-update` is in `$ARGUMENTS`: write `{"autoUpdate": true}` to `$UA_GRAPH_ROOT/config.json`
   - If `--no-auto-update` is in `$ARGUMENTS`: write `{"autoUpdate": false}` to `$UA_GRAPH_ROOT/config.json`
   - These flags only set the config — analysis proceeds normally regardless.

4. **Check for subdomain knowledge graphs to merge:**
   List all `*knowledge-graph*.json` files in `$UA_GRAPH_ROOT/` **excluding** `knowledge-graph.json` itself (e.g. `frontend-knowledge-graph.json`, `backend-knowledge-graph.json`). If any subdomain graphs exist, run the merge script bundled with this skill (located next to this SKILL.md file — use the skill directory path, not the project root):
   ```bash
   python <SKILL_DIR>/merge-subdomain-graphs.py "$PROJECT_ROOT" --graph-root "$UA_GRAPH_ROOT"
   ```
   The script discovers subdomain graphs, loads the existing `knowledge-graph.json` as a base (if present), and merges everything into `knowledge-graph.json` (deduplicating nodes and edges). Report the merge summary to the user, then continue with the merged graph.

5. Check if `$UA_GRAPH_ROOT/knowledge-graph.json` exists. If it does, read it.
6. Check if `$UA_GRAPH_ROOT/meta.json` exists. If it does, read it to get `gitCommitHash`.
7. **Decision logic:**

   | Condition | Action |
   |---|---|
   | `--full` flag in `$ARGUMENTS` | Full analysis (all phases) |
   | No existing graph or meta | Full analysis (all phases) |
   | `--review` flag + existing graph + unchanged commit hash | Skip to Phase 6 (review-only — reuse existing assembled graph) |
   | Existing graph + unchanged commit hash | Ask the user: "The graph is up to date at this commit. Would you like to: **(a)** run a full rebuild (`--full`), **(b)** run the LLM graph reviewer (`--review`), or **(c)** do nothing?" Then follow their choice. If they pick (c), STOP. |
   | Existing graph + changed files | Incremental update (re-analyze changed files only) |

   **Review-only path:** Copy the existing `knowledge-graph.json` to `$UA_GRAPH_ROOT/intermediate/assembled-graph.json`, then jump directly to Phase 6 step 3.

   For incremental updates, get the changed file list:
   ```bash
   git diff <lastCommitHash>..HEAD --name-only
   ```
   If this returns no files, report "Graph is up to date" and STOP.

8. **Collect project context for agent prompt injection:**
   - Read `README.md` (or `README.rst`, `readme.md`) from `$PROJECT_ROOT` if it exists. Store as `$README_CONTENT` (first 3000 characters).
   - Read the primary package manifest (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`) if it exists. Store as `$MANIFEST_CONTENT`.
   - Capture the top-level directory tree:
     ```bash
     find $PROJECT_ROOT -maxdepth 2 -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' | head -100
     ```
     Store as `$DIR_TREE`.
   - Detect the project entry point by checking for common patterns (in order): `src/index.ts`, `src/main.ts`, `src/App.tsx`, `index.js`, `main.py`, `manage.py`, `app.py`, `wsgi.py`, `asgi.py`, `run.py`, `__main__.py`, `main.go`, `cmd/*/main.go`, `src/main.rs`, `src/lib.rs`, `src/main/java/**/Application.java`, `Program.cs`, `config.ru`, `index.php`. Store first match as `$ENTRY_POINT`.

---

## Phase 0.5 — Ignore Configuration

The AstrBot host adapter handles `.understandignore` generation, review, and user confirmation before this skill workflow starts.

1. Use the existing `$UA_GRAPH_ROOT/.understandignore` as the confirmed scan scope.
2. Do not ask the user to review `.understandignore` inside this skill.
3. Proceed directly to Phase 1.

---

## Phase 1 — SCAN (Full analysis only)

Call `ua_run_subagent_role` with `role="project-scanner"`. Build the `input` from the project-scanner prompt context below and set `expected_output_path` to `$UA_GRAPH_ROOT/intermediate/scan-result.json`.

> **Additional context from main session:**
>
> Project README (first 3000 chars):
> ```
> $README_CONTENT
> ```
>
> Package manifest:
> ```
> $MANIFEST_CONTENT
> ```
>
> Use this context to produce more accurate project name, description, and framework detection. The README and manifest are authoritative — prefer their information over heuristics.

Include these parameters in the SubAgent input:

> Scan this project directory to discover all project files (including non-code files like configs, docs, infrastructure), detect languages and frameworks.
> Project root: `$PROJECT_ROOT`
> Write output to: `$UA_GRAPH_ROOT/intermediate/scan-result.json`

After the SubAgent tool completes, read `$UA_GRAPH_ROOT/intermediate/scan-result.json` to get:
- Project name, description
- Languages, frameworks
- File list with line counts and `fileCategory` per file (`code`, `config`, `docs`, `infra`, `data`, `script`, `markup`)
- Complexity estimate
- Import map (`importMap`): pre-resolved project-internal imports per file (non-code files have empty arrays)

Store `importMap` in memory as `$IMPORT_MAP` for use in Phase 2 batch construction.
Store the file list as `$FILE_LIST` with `fileCategory` metadata for use in Phase 2 batch construction.

**Gate check:** If >100 files, inform the user and suggest scoping with a subdirectory argument. Proceed only if user confirms or add guidance that this may take a while.

If the scan result includes `filteredByIgnore > 0`, report:
> Excluded {filteredByIgnore} files via `.understandignore`.

---

## Phase 2 — ANALYZE

### Full analysis path

Batch the file list from Phase 1 into groups of **20-30 files each** (aim for ~25 files per batch for balanced sizes).

**Batching strategy for non-code files:**
- Group related non-code files together in the same batch when possible:
  - Dockerfile + docker-compose.yml + .dockerignore → same batch
  - SQL migration files → same batch (ordered by filename)
  - CI/CD config files (.github/workflows/*) → same batch
  - Documentation files (docs/*.md) → same batch
- This allows the file-analyzer to create cross-file edges (e.g., docker-compose `depends_on` Dockerfile)
- Non-code files can be mixed with code files in the same batch if batch sizes are small
- Each file's `fileCategory` from Phase 1 must be included in the batch file list

For the file-analyzer phase, build one batch object per batch and call `ua_run_subagent_batches` with `role="file-analyzer"`, the `max_concurrency` value from AstrBot host rules, and `continue_on_error=true`. Each batch `input` must include the file-analyzer prompt context below and each `expected_output_path` must be `$UA_GRAPH_ROOT/intermediate/batch-<batchIndex>.json`.

> **Additional context from main session:**
>
> Project: `<projectName>` — `<projectDescription>`
> Languages: `<languages from Phase 1>`

Before running each batch, construct `batchImportData` from `$IMPORT_MAP`:
```json
batchImportData = {}
for each file in this batch:
  batchImportData[file.path] = $IMPORT_MAP[file.path] ?? []
```

Fill in batch-specific parameters below inside each batch input:

> Analyze these files and produce GraphNode and GraphEdge objects.
> Project root: `$PROJECT_ROOT`
> Project: `<projectName>`
> Languages: `<languages>`
> Batch index: `<batchIndex>`
> Skill directory (for bundled scripts): `<SKILL_DIR>`
> Write output to: `$UA_GRAPH_ROOT/intermediate/batch-<batchIndex>.json`
>
> Pre-resolved import data for this batch (use this for all import edge creation — do NOT re-resolve imports from source):
> ```json
> <batchImportData JSON>
> ```
>
> Files to analyze in this batch (every entry MUST be passed through to `batchFiles` with all four fields — `path`, `language`, `sizeLines`, `fileCategory`):
> 1. `<path>` (<sizeLines> lines, language: `<language>`, fileCategory: `<fileCategory>`)
> 2. `<path>` (<sizeLines> lines, language: `<language>`, fileCategory: `<fileCategory>`)
> ...

After ALL batches complete, run the merge-and-normalize script bundled with this skill (located next to this SKILL.md file — use the skill directory path, not the project root):
```bash
python <SKILL_DIR>/merge-batch-graphs.py "$PROJECT_ROOT" "$UA_GRAPH_ROOT"
```

This script reads all `batch-*.json` files from `$UA_GRAPH_ROOT/intermediate/`, then in one pass:
- Combines all nodes and edges across batches
- Normalizes node IDs (strips double prefixes, project-name prefixes, adds missing prefixes)
- Normalizes complexity values (`low`→`simple`, `medium`→`moderate`, `high`→`complex`, etc.)
- Rewrites edge references to match corrected node IDs
- Deduplicates nodes by ID (keeps last occurrence) and edges by `(source, target, type)`
- Drops dangling edges referencing missing nodes
- Logs all corrections and dropped items to stderr

The merge script also runs a `tested_by` linker that canonicalizes test-coverage edges in two passes. **Pass 1** walks LLM-emitted `tested_by` edges and flips inverted ones in place (the LLM systematically emits `test → production` because it sees the import only when analyzing the test file); semantically broken edges (test↔test, prod↔prod, orphan endpoints) are dropped. **Pass 2** supplements with path-convention pairings (`X.ts` ↔ `X.test.ts`, JS/TS `__tests__/` and `<dir>/test/` walk-out, Python in-package `tests/`, Go `_test.go` sibling, Maven/Gradle `src/test/...` ↔ `src/main/...`, .NET `<svc>/tests/` ↔ `<svc>/src/...` and `<App>.Tests/` ↔ `<App>/`). Production nodes that end up sourcing any `tested_by` edge get a `"tested"` tag. All resulting edges run `production → test`.

Output: `$UA_GRAPH_ROOT/intermediate/assembled-graph.json`

Include the script's warnings in `$PHASE_WARNINGS` for the reviewer.

### Incremental update path

Use the changed files list from Phase 0. Batch and call `ua_run_subagent_batches` using the same process as above (20-30 files per batch, host-configured file-agent concurrency, with batchImportData constructed from $IMPORT_MAP), but only for changed files.

After batches complete:
1. Remove old nodes whose `filePath` matches any changed file from the existing graph
2. Remove old edges whose `source` or `target` references a removed node
3. Write the pruned existing nodes/edges as `batch-existing.json` in the intermediate directory
4. Run the same merge script — it will combine `batch-existing.json` with the fresh `batch-*.json` files:
   ```bash
   python <SKILL_DIR>/merge-batch-graphs.py "$PROJECT_ROOT" "$UA_GRAPH_ROOT"
   ```

---

## Phase 3 — ASSEMBLE REVIEW

Call `ua_run_subagent_role` with `role="assemble-reviewer"` and `expected_output_path="$UA_GRAPH_ROOT/intermediate/assemble-review.json"`.

Include these parameters in the SubAgent input:

> Review the assembled graph at `$UA_GRAPH_ROOT/intermediate/assembled-graph.json`.
> Project root: `$PROJECT_ROOT`
> Batch files are at: `$UA_GRAPH_ROOT/intermediate/batch-*.json`
> Write review output to: `$UA_GRAPH_ROOT/intermediate/assemble-review.json`
>
> **Merge script report:**
> ```
> <paste the full stderr output from merge-batch-graphs.py>
> ```
>
> **Import map for cross-batch edge verification:**
> ```json
> $IMPORT_MAP
> ```

After the SubAgent tool completes, read `$UA_GRAPH_ROOT/intermediate/assemble-review.json` and add any notes to `$PHASE_WARNINGS`.

---

## Phase 4 — ARCHITECTURE

**Build the combined prompt template:**
1. Build a `ua_run_subagent_role` input for `role="architecture-analyzer"` from the architecture-analyzer prompt at `astrbot_adapter/prompts/agents/architecture-analyzer.md`.
2. **Language context injection:** For each language detected in Phase 1 (e.g., `python`, `markdown`, `dockerfile`, `yaml`, `sql`, `terraform`, `graphql`, `protobuf`, `shell`, `html`, `css`), read the file at `./languages/<language-id>.md` (e.g., `./languages/python.md`, `./languages/dockerfile.md`) and append its content after the base template under a `## Language Context` header. If the file does not exist for a detected language, skip it silently and continue. These files are in the `languages/` subdirectory next to this SKILL.md file. **Include non-code language snippets** — they provide edge patterns and summary styles for non-code files.
3. **Framework addendum injection:** For each framework detected in Phase 1 (e.g., `Django`), read the file at `./frameworks/<framework-id-lowercase>.md` (e.g., `./frameworks/django.md`) and append its full content after the language context. If the file does not exist for a detected framework, skip it silently and continue. These files are in the `frameworks/` subdirectory next to this SKILL.md file.

Append the language/framework context and the following additional context to the agent's prompt:

> **Additional context from main session:**
>
> Frameworks detected: `<frameworks from Phase 1>`
>
> Directory tree (top 2 levels):
> ```
> $DIR_TREE
> ```
>
> Use the directory tree, language context, and framework addendums (appended above) to inform layer assignments. Directory structure is strong evidence for layer boundaries. Non-code files (config, docs, infrastructure, data) should be assigned to appropriate layers — see the prompt template for guidance.

Include these parameters in the SubAgent input:

> Analyze this codebase's structure to identify architectural layers.
> Project root: `$PROJECT_ROOT`
> Write output to: `$UA_GRAPH_ROOT/intermediate/layers.json`
> Project: `<projectName>` — `<projectDescription>`
>
> File nodes (all node types — includes code files, config, document, service, pipeline, table, schema, resource, endpoint):
> ```json
> [list of {id, type, name, filePath, summary, tags} for ALL file-level nodes — omit complexity, languageNotes]
> ```
>
> Import edges:
> ```json
> [list of edges with type "imports"]
> ```
>
> All edges (for cross-category analysis — includes configures, documents, deploys, triggers, etc.):
> ```json
> [list of ALL edges — include all edge types]
> ```

After the SubAgent tool completes, read `$UA_GRAPH_ROOT/intermediate/layers.json` and normalize it into a final `layers` array. Apply these steps **in order**:

1. **Unwrap envelope:** If the file contains `{ "layers": [...] }` instead of a plain array, extract the inner array. (The prompt requests a plain array, but LLMs may still produce an envelope.)
2. **Rename legacy fields:** If any layer object has a `nodes` field instead of `nodeIds`, rename `nodes` → `nodeIds`. If `nodes` entries are objects with an `id` field rather than plain strings, extract just the `id` values into `nodeIds`.
3. **Synthesize missing IDs:** If any layer is missing an `id`, generate one as `layer:<kebab-case-name>`.
4. **Convert file paths:** If `nodeIds` entries are raw file paths without a known prefix (`file:`, `config:`, `document:`, `service:`, `pipeline:`, `table:`, `schema:`, `resource:`, `endpoint:`), convert them to `file:<relative-path>`.
5. **Drop dangling refs:** Remove any `nodeIds` entries that do not exist in the merged node set.

Each element of the final `layers` array MUST have this shape:

```json
[
  {
    "id": "layer:<kebab-case-name>",
    "name": "<layer name>",
    "description": "<what belongs in this layer>",
    "nodeIds": ["file:src/App.tsx", "config:tsconfig.json", "document:README.md"]
  }
]
```

All four fields (`id`, `name`, `description`, `nodeIds`) are required.

**For incremental updates:** Always re-run architecture analysis on the full merged node set, since layer assignments may shift when files change.

**Context for incremental updates:** When re-running architecture analysis, also inject the previous layer definitions:

> Previous layer definitions (for naming consistency):
> ```json
> [previous layers from existing graph]
> ```
>
> Maintain the same layer names and IDs where possible. Only add/remove layers if the file structure has materially changed.

---

## Phase 5 — TOUR

Call `ua_run_subagent_role` with `role="tour-builder"`. Build the input from the tour-builder prompt context below and set `expected_output_path` to `$UA_GRAPH_ROOT/intermediate/tour.json`.

> **Additional context from main session:**
>
> Project README (first 3000 chars):
> ```
> $README_CONTENT
> ```
>
> Project entry point: `$ENTRY_POINT`
>
> Use the README to align the tour narrative with the project's own documentation. Start the tour from the entry point if one was detected. The tour should tell the same story the README tells, but through the lens of actual code structure.

Include these parameters in the SubAgent input:

> Create a guided learning tour for this codebase.
> Project root: `$PROJECT_ROOT`
> Write output to: `$UA_GRAPH_ROOT/intermediate/tour.json`
> Project: `<projectName>` — `<projectDescription>`
> Languages: `<languages>`
>
> Nodes (all file-level nodes — includes code files, config, document, service, pipeline, table, schema, resource, endpoint):
> ```json
> [list of {id, name, filePath, summary, type} for ALL file-level nodes — do NOT include function or class nodes]
> ```
>
> Layers:
> ```json
> [list of {id, name, description} for each layer — omit nodeIds]
> ```
>
> Edges (all types — includes imports, calls, configures, documents, deploys, triggers, etc.):
> ```json
> [list of ALL edges — include all edge types for complete graph topology analysis]
> ```

After the SubAgent tool completes, read `$UA_GRAPH_ROOT/intermediate/tour.json` and normalize it into a final `tour` array. Apply these steps **in order**:

1. **Unwrap envelope:** If the file contains `{ "steps": [...] }` instead of a plain array, extract the inner array. (The prompt requests a plain array, but LLMs may still produce an envelope.)
2. **Rename legacy fields:** If any step has `nodesToInspect` instead of `nodeIds`, rename it → `nodeIds`. If any step has `whyItMatters` instead of `description`, rename it → `description`.
3. **Convert file paths:** If `nodeIds` entries are raw file paths without a known prefix (`file:`, `config:`, `document:`, `service:`, `pipeline:`, `table:`, `schema:`, `resource:`, `endpoint:`), convert them to `file:<relative-path>`.
4. **Drop dangling refs:** Remove any `nodeIds` entries that do not exist in the merged node set.
5. **Sort** by `order` before saving.

Each element of the final `tour` array MUST have this shape:

```json
[
  {
    "order": 1,
    "title": "Project Overview",
    "description": "Start with the README to understand the project's purpose and architecture.",
    "nodeIds": ["document:README.md"]
  },
  {
    "order": 2,
    "title": "Application Entry Point",
    "description": "This step explains how the frontend boots and mounts.",
    "nodeIds": ["file:src/main.tsx", "file:src/App.tsx"]
  }
]
```

Required fields: `order`, `title`, `description`, `nodeIds`. Preserve optional `languageLesson` when present.

---

## Phase 6 — REVIEW

Assemble the full KnowledgeGraph JSON object:

```json
{
  "version": "1.0.0",
  "project": {
    "name": "<projectName>",
    "languages": ["<languages>"],
    "frameworks": ["<frameworks>"],
    "description": "<projectDescription>",
    "analyzedAt": "<ISO 8601 timestamp>",
    "gitCommitHash": "<commit hash from Phase 0>"
  },
  "nodes": [<all nodes from assembled-graph.json after Phase 3 review>],
  "edges": [<all edges from assembled-graph.json after Phase 3 review>],
  "layers": [<layers from Phase 4>],
  "tour": [<steps from Phase 5>]
}
```

1. Before writing the assembled graph, validate that:
   - `layers` is an array of objects with these required fields: `id`, `name`, `description`, `nodeIds`
   - `tour` is an array of objects with these required fields: `order`, `title`, `description`, `nodeIds`
   - `tour[*].languageLesson` is allowed as an optional string field
   - Every `layers[*].nodeIds` entry exists in the merged node set
   - Every `tour[*].nodeIds` entry exists in the merged node set

   If validation fails, automatically normalize and rewrite the graph into this shape before saving. If the graph still fails final validation after the normalization pass, save it with warnings but mark dashboard auto-launch as skipped.

2. Write the assembled graph to `$UA_GRAPH_ROOT/intermediate/assembled-graph.json`.

3. **Check `$ARGUMENTS` for `--review` flag.** Then run the appropriate validation path:

---

#### Default path (no `--review`): inline deterministic validation

Write the following Node.js script to `$UA_GRAPH_ROOT/tmp/ua-inline-validate.cjs`:

```javascript
#!/usr/bin/env node
const fs = require('fs');
const graphPath = process.argv[2];
const outputPath = process.argv[3];
try {
  const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
  const issues = [], warnings = [];
  if (!Array.isArray(graph.nodes)) { issues.push('graph.nodes is missing or not an array'); graph.nodes = []; }
  if (!Array.isArray(graph.edges)) { issues.push('graph.edges is missing or not an array'); graph.edges = []; }
  const nodeIds = new Set();
  const seen = new Map();
  graph.nodes.forEach((n, i) => {
    if (!n.id) { issues.push(`Node[${i}] missing id`); return; }
    if (!n.type) issues.push(`Node[${i}] '${n.id}' missing type`);
    if (!n.name) issues.push(`Node[${i}] '${n.id}' missing name`);
    if (!n.summary) issues.push(`Node[${i}] '${n.id}' missing summary`);
    if (!n.tags || !n.tags.length) issues.push(`Node[${i}] '${n.id}' missing tags`);
    if (seen.has(n.id)) issues.push(`Duplicate node ID '${n.id}' at indices ${seen.get(n.id)} and ${i}`);
    else seen.set(n.id, i);
    nodeIds.add(n.id);
  });
  graph.edges.forEach((e, i) => {
    if (!nodeIds.has(e.source)) issues.push(`Edge[${i}] source '${e.source}' not found`);
    if (!nodeIds.has(e.target)) issues.push(`Edge[${i}] target '${e.target}' not found`);
  });
  const fileLevelTypes = new Set(['file', 'config', 'document', 'service', 'pipeline', 'table', 'schema', 'resource', 'endpoint']);
  const fileNodes = graph.nodes.filter(n => fileLevelTypes.has(n.type)).map(n => n.id);
  const assigned = new Map();
  if (!Array.isArray(graph.layers)) { if (graph.layers) warnings.push('graph.layers is not an array'); graph.layers = []; }
  if (!Array.isArray(graph.tour)) { if (graph.tour) warnings.push('graph.tour is not an array'); graph.tour = []; }
  graph.layers.forEach(layer => {
    (layer.nodeIds || []).forEach(id => {
      if (!nodeIds.has(id)) issues.push(`Layer '${layer.id}' refs missing node '${id}'`);
      if (assigned.has(id)) issues.push(`Node '${id}' appears in multiple layers`);
      assigned.set(id, layer.id);
    });
  });
  fileNodes.forEach(id => {
    if (!assigned.has(id)) issues.push(`File node '${id}' not in any layer`);
  });
  graph.tour.forEach((step, i) => {
    (step.nodeIds || []).forEach(id => {
      if (!nodeIds.has(id)) issues.push(`Tour step[${i}] refs missing node '${id}'`);
    });
  });
  const withEdges = new Set([
    ...graph.edges.map(e => e.source),
    ...graph.edges.map(e => e.target)
  ]);
  graph.nodes.forEach(n => {
    if (!withEdges.has(n.id)) warnings.push(`Node '${n.id}' has no edges (orphan)`);
  });
  const stats = {
    totalNodes: graph.nodes.length,
    totalEdges: graph.edges.length,
    totalLayers: graph.layers.length,
    tourSteps: graph.tour.length,
    nodeTypes: graph.nodes.reduce((a, n) => { a[n.type] = (a[n.type]||0)+1; return a; }, {}),
    edgeTypes: graph.edges.reduce((a, e) => { a[e.type] = (a[e.type]||0)+1; return a; }, {})
  };
  fs.writeFileSync(outputPath, JSON.stringify({ issues, warnings, stats }, null, 2));
  process.exit(0);
} catch (err) { process.stderr.write(err.message + '\n'); process.exit(1); }
```

Execute it:
```bash
node $UA_GRAPH_ROOT/tmp/ua-inline-validate.cjs \
  "$UA_GRAPH_ROOT/intermediate/assembled-graph.json" \
  "$UA_GRAPH_ROOT/intermediate/review.json"
```

If the script exits non-zero, read stderr, fix the script, and retry once.

---

#### `--review` path: full LLM reviewer

If `--review` IS in `$ARGUMENTS`, run the LLM graph-reviewer SubAgent as follows:

Call `ua_run_subagent_role` with `role="graph-reviewer"`. Build the input from the graph-reviewer prompt context below and set `expected_output_path` to `$UA_GRAPH_ROOT/intermediate/review.json`.

> **Additional context from main session:**
>
> Phase 1 scan results (file inventory):
> ```json
> [list of {path, sizeLines} from scan-result.json]
> ```
>
> Phase warnings/errors accumulated during analysis:
> - [list any batch failures, skipped files, or warnings from Phases 2-5]
>
> Cross-validate: every file in the scan inventory should have a corresponding node in the graph (node types may vary: `file:`, `config:`, `document:`, `service:`, `pipeline:`, `table:`, `schema:`, `resource:`, `endpoint:`). Flag any missing files. Also flag any graph nodes whose `filePath` doesn't appear in the scan inventory.

Include these parameters in the SubAgent input:

> Validate the knowledge graph at `$UA_GRAPH_ROOT/intermediate/assembled-graph.json`.
> Project root: `$PROJECT_ROOT`
> Read the file and validate it for completeness and correctness.
> Write output to: `$UA_GRAPH_ROOT/intermediate/review.json`

---

4. Read `$UA_GRAPH_ROOT/intermediate/review.json`.

5. **If `issues` array is non-empty:**
   - Review the `issues` list
   - Apply automated fixes where possible:
     - Remove edges with dangling references
     - Fill missing required fields with sensible defaults (e.g., empty `tags` -> `["untagged"]`, empty `summary` -> `"No summary available"`)
     - Remove nodes with invalid types
   - Re-run the final graph validation after automated fixes
   - If critical issues remain after one fix attempt, save the graph anyway but include the warnings in the final report and mark dashboard auto-launch as skipped

6. **If `issues` array is empty:** Proceed to Phase 7.

---

## Phase 7 — SAVE

1. Write the final knowledge graph to `$UA_GRAPH_ROOT/knowledge-graph.json`.

2. Write metadata to `$UA_GRAPH_ROOT/meta.json`:
   ```json
   {
     "lastAnalyzedAt": "<ISO 8601 timestamp>",
     "gitCommitHash": "<commit hash>",
     "version": "1.0.0",
     "analyzedFiles": <number of files analyzed>
   }
   ```

2.5. **Generate structural fingerprints** for all analyzed files and save to `$UA_GRAPH_ROOT/fingerprints.json`. This creates the baseline for future automatic incremental updates.

   Write and execute a Node.js script that uses the core fingerprint module (tree-sitter-based, not regex):
   ```javascript
   import { buildFingerprintStore } from '@understand-anything/core';

   const store = await buildFingerprintStore('<PROJECT_ROOT>', sourceFilePaths);
   const fs = await import('node:fs');
   const path = await import('node:path');
   const graphRoot = '<UA_GRAPH_ROOT>';
   fs.mkdirSync(graphRoot, { recursive: true });
   fs.writeFileSync(path.join(graphRoot, 'fingerprints.json'), JSON.stringify(store, null, 2), 'utf-8');
   ```
   Where `sourceFilePaths` is the list of all analyzed source file paths from Phase 1. This uses the same tree-sitter analysis pipeline as the main fingerprint engine, ensuring the baseline matches the comparison logic used during auto-updates.

3. Clean up intermediate files:
   ```bash
   rm -rf $UA_GRAPH_ROOT/intermediate
   rm -rf $UA_GRAPH_ROOT/tmp
   ```

4. Report a summary to the user containing:
   - Project name and description
   - Files analyzed / total files (with breakdown by fileCategory: code, config, docs, infra, data, script, markup)
   - Nodes created (broken down by type: file, function, class, config, document, service, table, endpoint, pipeline, schema, resource)
   - Edges created (broken down by type)
   - Layers identified (with names)
   - Tour steps generated (count)
   - Any warnings from the reviewer
   - Path to the output file: `$UA_GRAPH_ROOT/knowledge-graph.json`

5. Only automatically launch the dashboard by invoking the `/understand-dashboard` skill if final graph validation passed after normalization/review fixes.
   If final validation did not pass, report that the graph was saved with warnings and dashboard launch was skipped.

---

## Error Handling

- If any SubAgent tool run fails, retry **once** with the same prompt plus additional context about the failure.
- Track all warnings and errors from each phase in a `$PHASE_WARNINGS` list. When using `--review`, pass this list to the graph-reviewer in Phase 6. On the default path, include accumulated warnings in the Phase 7 final report.
- If it fails a second time, skip that phase and continue with partial results.
- ALWAYS save partial results — a partial graph is better than no graph.
- Report any skipped phases or errors in the final summary so the user knows what happened.
- NEVER silently drop errors. Every failure must be visible in the final report.

---

## Reference: KnowledgeGraph Schema

### Node Types (13 total)
| Type | Description | ID Convention |
|---|---|---|
| `file` | Source code file | `file:<relative-path>` |
| `function` | Function or method | `function:<relative-path>:<name>` |
| `class` | Class, interface, or type | `class:<relative-path>:<name>` |
| `module` | Logical module or package | `module:<name>` |
| `concept` | Abstract concept or pattern | `concept:<name>` |
| `config` | Configuration file (YAML, JSON, TOML, env) | `config:<relative-path>` |
| `document` | Documentation file (Markdown, RST, TXT) | `document:<relative-path>` |
| `service` | Deployable service definition (Dockerfile, K8s) | `service:<relative-path>` |
| `table` | Database table or migration | `table:<relative-path>:<table-name>` |
| `endpoint` | API endpoint or route definition | `endpoint:<relative-path>:<endpoint-name>` |
| `pipeline` | CI/CD pipeline configuration | `pipeline:<relative-path>` |
| `schema` | Schema definition (GraphQL, Protobuf, Prisma) | `schema:<relative-path>` |
| `resource` | Infrastructure resource (Terraform, CloudFormation) | `resource:<relative-path>` |

### Edge Types (26 total)
| Category | Types |
|---|---|
| Structural | `imports`, `exports`, `contains`, `inherits`, `implements` |
| Behavioral | `calls`, `subscribes`, `publishes`, `middleware` |
| Data flow | `reads_from`, `writes_to`, `transforms`, `validates` |
| Dependencies | `depends_on`, `tested_by`, `configures` |
| Semantic | `related`, `similar_to` |
| Infrastructure | `deploys`, `serves`, `provisions`, `triggers` |
| Schema/Data | `migrates`, `documents`, `routes`, `defines_schema` |

### Edge Weight Conventions
| Edge Type | Weight |
|---|---|
| `contains` | 1.0 |
| `inherits`, `implements` | 0.9 |
| `calls`, `exports`, `defines_schema` | 0.8 |
| `imports`, `deploys`, `migrates` | 0.7 |
| `depends_on`, `configures`, `triggers` | 0.6 |
| `tested_by`, `documents`, `provisions`, `serves`, `routes` | 0.5 |
| All others | 0.5 (default) |

