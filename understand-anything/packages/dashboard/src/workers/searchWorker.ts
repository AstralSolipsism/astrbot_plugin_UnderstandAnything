import { SearchEngine } from "@understand-anything/core/search";
import type { SearchOptions, SearchResult } from "@understand-anything/core/search";
import type { GraphNode } from "@understand-anything/core/types";

type SearchWorkerRequest =
  | {
      type: "build";
      version: number;
      nodes: GraphNode[];
      query?: string;
    }
  | {
      type: "search";
      version: number;
      requestId: number;
      query: string;
      options?: SearchOptions;
    };

type SearchWorkerResponse =
  | {
      type: "ready";
      version: number;
    }
  | {
      type: "results";
      version: number;
      requestId: number;
      query: string;
      results: SearchResult[];
    }
  | {
      type: "error";
      version: number;
      requestId?: number;
      message: string;
    };

interface SearchWorkerScope {
  onmessage: ((event: MessageEvent<SearchWorkerRequest>) => void) | null;
  postMessage: (message: SearchWorkerResponse) => void;
}

const ctx = self as unknown as SearchWorkerScope;

let engine: SearchEngine | null = null;
let currentVersion = 0;

function post(response: SearchWorkerResponse): void {
  ctx.postMessage(response);
}

ctx.onmessage = (event: MessageEvent<SearchWorkerRequest>) => {
  const message = event.data;

  try {
    if (message.type === "build") {
      currentVersion = message.version;
      engine = new SearchEngine(message.nodes);
      post({ type: "ready", version: currentVersion });
      if (message.query?.trim()) {
        post({
          type: "results",
          version: currentVersion,
          requestId: 0,
          query: message.query,
          results: engine.search(message.query),
        });
      }
      return;
    }

    if (message.type === "search") {
      if (!engine || message.version !== currentVersion) {
        post({
          type: "error",
          version: message.version,
          requestId: message.requestId,
          message: "搜索索引尚未就绪",
        });
        return;
      }
      post({
        type: "results",
        version: message.version,
        requestId: message.requestId,
        query: message.query,
        results: engine.search(message.query, message.options),
      });
    }
  } catch (error) {
    post({
      type: "error",
      version: "version" in message ? message.version : currentVersion,
      requestId: "requestId" in message ? message.requestId : undefined,
      message: error instanceof Error ? error.message : "搜索 Worker 执行失败",
    });
  }
};

export {};
