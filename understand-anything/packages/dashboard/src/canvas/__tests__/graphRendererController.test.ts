import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphSceneEdge, GraphSceneModel, GraphSceneNode } from "../../graph-scene/graphSceneTypes";

const leaferMocks = vi.hoisted(() => {
  const pathProps: Array<Record<string, unknown> | undefined> = [];

  class FakeLeaferNode {
    children: unknown[] = [];
    visible = true;
    removed = false;
    destroyed = false;

    constructor(props?: Record<string, unknown>) {
      Object.assign(this, props);
    }

    add(child: unknown): void {
      this.children.push(child);
    }

    set(props: Record<string, unknown>): void {
      Object.assign(this, props);
    }

    remove(): void {
      this.removed = true;
    }

    removeAll(): void {
      this.children = [];
    }

    destroy(): void {
      this.destroyed = true;
    }
  }

  class FakePathNode extends FakeLeaferNode {
    constructor(props?: Record<string, unknown>) {
      super(props);
      pathProps.push(props);
    }
  }

  return { FakeLeaferNode, FakePathNode, pathProps };
});

vi.mock("leafer-ui", () => ({
  Ellipse: leaferMocks.FakeLeaferNode,
  Group: leaferMocks.FakeLeaferNode,
  Leafer: leaferMocks.FakeLeaferNode,
  Path: leaferMocks.FakePathNode,
  Rect: leaferMocks.FakeLeaferNode,
  Text: leaferMocks.FakeLeaferNode,
}));

import { createGraphRendererController } from "../graphRendererController";

function sceneNode(
  id: string,
  state: Partial<GraphSceneNode["state"]> = {},
): GraphSceneNode {
  return {
    id,
    kind: "custom",
    x: id === "a" ? 20 : 260,
    y: id === "a" ? 40 : 180,
    width: 120,
    height: 80,
    data: {
      label: id,
      nodeType: "file",
      summary: `${id} summary`,
      complexity: "simple",
    },
    state: {
      selected: false,
      highlighted: false,
      searchMatched: false,
      diffChanged: false,
      diffAffected: false,
      faded: false,
      focused: false,
      ...state,
    },
  };
}

function scene(
  nodes: readonly GraphSceneNode[],
  edges: readonly GraphSceneEdge[] = [],
): GraphSceneModel {
  return {
    level: "layer-detail",
    nodes: [...nodes],
    edges: [...edges],
  };
}

function edge(source: string, target: string): GraphSceneEdge {
  return {
    id: `${source}-${target}`,
    source,
    target,
    style: {
      stroke: "#d4a574",
      strokeWidth: 1.25,
    },
    state: {
      selected: false,
      faded: false,
      highlighted: false,
    },
  };
}

function host(): HTMLElement & {
  __listeners: Map<string, EventListenerOrEventListenerObject>;
} {
  const listeners = new Map<string, EventListenerOrEventListenerObject>();
  return {
    __listeners: listeners,
    clientWidth: 800,
    clientHeight: 600,
    style: { cursor: "" },
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 800,
      height: 600,
      right: 800,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
    addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.set(type, listener);
    }),
    removeEventListener: vi.fn((type: string) => {
      listeners.delete(type);
    }),
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
  } as unknown as HTMLElement & { __listeners: Map<string, EventListenerOrEventListenerObject> };
}

describe("graph renderer controller", () => {
  beforeEach(() => {
    leaferMocks.pathProps.length = 0;
    vi.stubGlobal("document", { documentElement: {} });
    vi.stubGlobal("getComputedStyle", () => ({
      getPropertyValue: () => "",
    }));
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        disconnect(): void {}
      },
    );
    vi.stubGlobal("window", {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
      cancelAnimationFrame: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("updates scene visual state without resetting the current viewport", () => {
    const initialScene = scene([sceneNode("a"), sceneNode("b")]);
    const nextScene = scene([sceneNode("a", { selected: true }), sceneNode("b")]);
    const controller = createGraphRendererController({
      host: host(),
      sceneModel: initialScene,
      callbacks: {
        onNodeClick: vi.fn(),
        onPaneClick: vi.fn(),
      },
    });

    controller.setCenter(320, 240, { zoom: 1.4 });
    const viewportBeforeUpdate = controller.getViewport();

    controller.updateScene(nextScene);

    expect(controller.getViewport()).toEqual(viewportBeforeUpdate);
    expect(controller.getSceneSnapshot()).toBe(nextScene);

    controller.destroy();
  });

  it("draws edge paths without a fill layer", () => {
    const controller = createGraphRendererController({
      host: host(),
      sceneModel: scene([sceneNode("a"), sceneNode("b")], [edge("a", "b")]),
      callbacks: {
        onNodeClick: vi.fn(),
        onPaneClick: vi.fn(),
      },
    });

    expect(leaferMocks.pathProps[0]).toMatchObject({
      stroke: "#d4a574",
      strokeWidth: 1.25,
      strokeScaleFixed: true,
      hittable: false,
    });
    expect(leaferMocks.pathProps[0]).not.toHaveProperty("fill");

    controller.destroy();
  });

  it("prevents the browser context menu and reports right-clicked nodes", () => {
    const hostElement = host();
    const onNodeContextMenu = vi.fn();
    const controller = createGraphRendererController({
      host: hostElement,
      sceneModel: scene([sceneNode("a"), sceneNode("b")]),
      callbacks: {
        onNodeClick: vi.fn(),
        onPaneClick: vi.fn(),
        onNodeContextMenu,
      },
    });

    controller.setCenter(80, 80, { zoom: 1 });
    const listener = hostElement.__listeners.get("contextmenu");
    expect(listener).toBeTypeOf("function");
    const event = {
      clientX: 400,
      clientY: 300,
      preventDefault: vi.fn(),
    } as unknown as MouseEvent;

    (listener as EventListener)(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(onNodeContextMenu).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a" }),
      400,
      300,
    );

    controller.destroy();
  });
});
