import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [rootArg, action, payloadPath] = process.argv.slice(2);

if (!rootArg || !action || !payloadPath) {
  console.error("Usage: node bridge.mjs <runtime-root> <action> <payload-json>");
  process.exit(2);
}

const runtimeRoot = path.resolve(rootArg);
const payload = JSON.parse(fs.readFileSync(payloadPath, "utf-8"));
const distUrl = pathToFileURL(path.join(runtimeRoot, "dist", "index.js")).href;
const skill = await import(distUrl);

function write(payload) {
  process.stdout.write(JSON.stringify(payload));
}

switch (action) {
  case "chat_prompt": {
    write({ markdown: skill.buildChatPrompt(payload.graph, payload.query) });
    break;
  }
  case "explain_prompt": {
    const ctx = skill.buildExplainContext(payload.graph, payload.path);
    write({ markdown: skill.formatExplainPrompt(ctx), found: Boolean(ctx.targetNode) });
    break;
  }
  case "diff_markdown": {
    const ctx = skill.buildDiffContext(payload.graph, payload.changedFiles ?? []);
    write({
      markdown: skill.formatDiffAnalysis(ctx),
      changedNodeIds: ctx.changedNodes.map((node) => node.id),
      affectedNodeIds: ctx.affectedNodes.map((node) => node.id),
      unmappedFiles: ctx.unmappedFiles,
    });
    break;
  }
  case "onboard_markdown": {
    write({ markdown: skill.buildOnboardingGuide(payload.graph) });
    break;
  }
  case "chat_context": {
    const ctx = skill.buildChatContext(payload.graph, payload.query, payload.maxNodes);
    write({ markdown: skill.formatContextForPrompt(ctx), context: ctx });
    break;
  }
  default:
    throw new Error(`Unsupported Understand Anything bridge action: ${action}`);
}
