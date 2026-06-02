import {
  Children,
  isValidElement,
  useMemo,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import ReactMarkdown, { defaultUrlTransform, type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Highlight, themes, type Language } from "prism-react-renderer";
import { remarkAssistantReferences } from "./remarkAssistantReferences";
import type { AssistantReferenceIndex } from "./assistantReferenceIndex";
import { isAssistantInternalHref } from "./assistantReferenceNavigation";

interface AssistantMarkdownRendererProps {
  children?: string;
  referenceIndex?: AssistantReferenceIndex | null;
  className?: string;
}

interface CodeElementProps {
  className?: string;
  children?: ReactNode;
}

const LANGUAGE_ALIASES: Record<string, Language> = {
  bash: "bash",
  c: "c",
  cpp: "cpp",
  cs: "csharp",
  csharp: "csharp",
  css: "css",
  diff: "diff",
  go: "go",
  html: "markup",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "jsx",
  md: "markdown",
  py: "python",
  python: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  sql: "sql",
  ts: "typescript",
  tsx: "tsx",
  txt: "text",
  xml: "markup",
  yaml: "yaml",
  yml: "yaml",
};

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}

function languageFromClassName(className: string | undefined): { raw: string; prism: Language } | null {
  const match = /language-([A-Za-z0-9_-]+)/u.exec(className ?? "");
  if (!match) return null;
  const raw = match[1].toLowerCase();
  const prism = LANGUAGE_ALIASES[raw];
  return prism ? { raw, prism } : null;
}

function dispatchAssistantReference(href: string): void {
  window.dispatchEvent(new CustomEvent("ua-assistant-reference", { detail: href }));
}

function MarkdownLink({
  href,
  children,
  node: _node,
  ...props
}: ComponentPropsWithoutRef<"a"> & { node?: unknown }) {
  if (isAssistantInternalHref(href)) {
    return (
      <button
        type="button"
        className="ua-markdown-reference"
        data-ua-reference={href}
        onClick={() => dispatchAssistantReference(href)}
      >
        {children}
      </button>
    );
  }

  return (
    <a href={href} target="_blank" rel="noreferrer" {...props}>
      {children}
    </a>
  );
}

function MarkdownPre({ children }: ComponentPropsWithoutRef<"pre">) {
  const child = Children.toArray(children)[0];
  if (!isValidElement<CodeElementProps>(child)) {
    return <pre className="ua-markdown-pre">{children}</pre>;
  }

  const className = child.props.className;
  const code = nodeText(child.props.children).replace(/\n$/u, "");
  const language = languageFromClassName(className);

  if (!language) {
    return (
      <pre className="ua-markdown-pre">
        <code className={className}>{code}</code>
      </pre>
    );
  }

  return (
    <Highlight code={code} language={language.prism} theme={themes.nightOwl}>
      {({ className: prismClassName, style, tokens, getLineProps, getTokenProps }) => (
        <pre
          className={`ua-markdown-pre ${prismClassName} language-${language.raw}`}
          style={style}
        >
          <code className={`language-${language.raw}`}>
            {tokens.map((line, lineIndex) => (
              <span key={lineIndex} {...getLineProps({ line })}>
                {line.map((token, tokenIndex) => (
                  <span key={tokenIndex} {...getTokenProps({ token })} />
                ))}
                {lineIndex < tokens.length - 1 ? "\n" : null}
              </span>
            ))}
          </code>
        </pre>
      )}
    </Highlight>
  );
}

const markdownComponents: Components = {
  a: MarkdownLink,
  code: ({ className, children }) => <code className={className}>{children}</code>,
  pre: MarkdownPre,
  table: ({ children }) => (
    <div className="ua-markdown-table-scroll">
      <table>{children}</table>
    </div>
  ),
};

export function AssistantMarkdownRenderer({
  children,
  referenceIndex,
  className = "",
}: AssistantMarkdownRendererProps) {
  const remarkPlugins = useMemo<NonNullable<Options["remarkPlugins"]>>(
    () => [
      remarkGfm,
      [remarkAssistantReferences, { referenceIndex }],
    ],
    [referenceIndex],
  );

  return (
    <div className={`ua-markdown ${className}`}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        components={markdownComponents}
        urlTransform={(url) => (isAssistantInternalHref(url) ? url : defaultUrlTransform(url))}
      >
        {children || " "}
      </ReactMarkdown>
    </div>
  );
}
