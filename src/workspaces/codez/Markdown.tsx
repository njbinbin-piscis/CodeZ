import {
  Component,
  useEffect,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { unified } from "unified";
import rehypeParse from "rehype-parse";
import rehypeStringify from "rehype-stringify";
import "highlight.js/styles/github-dark.css";
import "katex/dist/katex.min.css";
import { editorApplyBus } from "./editorApplyBus";
import "./Markdown.css";

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    "details",
    "summary",
    "sub",
    "sup",
    "kbd",
    "mark",
    "abbr",
    "dl",
    "dt",
    "dd",
  ],
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "className", "id"],
    span: [...(defaultSchema.attributes?.span ?? []), "className", "style"],
    div: [...(defaultSchema.attributes?.div ?? []), "className"],
    code: [...(defaultSchema.attributes?.code ?? []), "className"],
    a: [...(defaultSchema.attributes?.a ?? []), "target", "rel"],
    img: [...(defaultSchema.attributes?.img ?? []), "loading"],
  },
};

let mermaidPromise: Promise<{
  parse: (code: string, options?: { suppressErrors?: boolean }) => Promise<unknown>;
  render: (id: string, code: string) => Promise<{ svg: string }>;
}> | null = null;

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "loose" });
      return mermaid;
    });
  }
  return mermaidPromise;
}

let mermaidIdCounter = 0;

class RenderErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[Markdown] render boundary caught error:", error, info);
  }

  componentDidUpdate(prevProps: { fallback: ReactNode; children: ReactNode }) {
    if (this.state.hasError && prevProps.children !== this.props.children) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

function MermaidBlock({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const idRef = useRef(`mermaid-${++mermaidIdCounter}`);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    let cancelled = false;
    const id = idRef.current;
    setError(null);
    ref.current.innerHTML = "";

    const render = async () => {
      try {
        const mermaid = await loadMermaid();
        await mermaid.parse(code, { suppressErrors: false });
        const { svg } = await mermaid.render(id, code);
        if (!cancelled && ref.current) {
          ref.current.innerHTML = svg;
        }
      } catch (e) {
        if (!cancelled) {
          console.warn("[Markdown] Mermaid render failed:", e);
          setError(String(e));
        }
      }
    };

    void render();
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error) {
    return (
      <div className="agentz-codeblock agentz-mermaid-error">
        <span className="agentz-code-lang">mermaid (parse error)</span>
        <pre>
          <code>{code}</code>
        </pre>
      </div>
    );
  }
  return <div ref={ref} className="agentz-mermaid-block" />;
}

function HtmlBlock({ code }: { code: string }) {
  const [html, setHtml] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const file = await unified()
          .use(rehypeParse, { fragment: true })
          .use(rehypeSanitize, sanitizeSchema)
          .use(rehypeStringify)
          .process(code);
        if (!cancelled) setHtml(String(file));
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error) {
    return (
      <div className="agentz-codeblock">
        <span className="agentz-code-lang">html (sanitize error)</span>
        <pre>
          <code>{code}</code>
        </pre>
      </div>
    );
  }
  return <div className="agentz-html-block" dangerouslySetInnerHTML={{ __html: html }} />;
}

function CodeBlock({
  children,
  lang,
  enableApply,
}: {
  children?: ReactNode;
  lang?: string;
  enableApply?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [applied, setApplied] = useState(false);
  const copy = () => {
    const text = extractText(children);
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  const apply = () => {
    const text = extractText(children);
    const ok = editorApplyBus.apply(text);
    if (ok) {
      setApplied(true);
      setTimeout(() => setApplied(false), 1200);
    }
  };
  return (
    <div className="agentz-codeblock">
      <div className="agentz-codeblock-actions">
        {enableApply && (
          <button className="agentz-codeblock-apply" onClick={apply} title="Apply to active editor">
            {applied ? "Applied" : "Apply"}
          </button>
        )}
        <button className="agentz-codeblock-copy" onClick={copy} title="Copy">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {lang && <span className="agentz-code-lang">{lang}</span>}
      <pre>{children}</pre>
    </div>
  );
}

function extractText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const props = (node as any)?.props;
  if (props && props.children !== undefined) return extractText(props.children);
  return "";
}

/** Renders assistant text as rich markdown (GFM, mermaid, HTML, KaTeX). */
export default function Markdown({
  content,
  enableApply,
  compact,
}: {
  content: string;
  /** Show an "Apply" button on code blocks (IDE chat only). */
  enableApply?: boolean;
  /** Tighter spacing for embedded surfaces (e.g. chat_ui text blocks). */
  compact?: boolean;
}) {
  const fallback = (
    <pre className="agentz-markdown-fallback">
      <code>{content}</code>
    </pre>
  );

  return (
    <div className={`agentz-markdown${compact ? " agentz-markdown-compact" : ""}`}>
      <RenderErrorBoundary fallback={fallback}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[
            rehypeRaw,
            [rehypeSanitize, sanitizeSchema],
            rehypeKatex,
            rehypeHighlight,
          ]}
          urlTransform={(url) =>
            url.startsWith("file://") ||
            url.startsWith("http://") ||
            url.startsWith("https://") ||
            url.startsWith("mailto:") ||
            url.startsWith("#") ||
            url.startsWith("/") ||
            !url.includes(":")
              ? url
              : ""
          }
          components={{
            pre: ({ children }) => <>{children}</>,
            code: ({ className, children, ...props }) => {
              const text = String(children).replace(/\n$/, "");
              const match = /language-(\w+)/.exec(className || "");
              const lang = match?.[1]?.toLowerCase();
              const isBlock = Boolean(className?.includes("language-") || text.includes("\n"));

              if (isBlock) {
                if (lang === "mermaid") {
                  return <MermaidBlock code={text.trimEnd()} />;
                }
                if (lang === "html") {
                  return <HtmlBlock code={text} />;
                }
                return (
                  <CodeBlock lang={lang} enableApply={enableApply}>
                    <code className={className} {...props}>
                      {children}
                    </code>
                  </CodeBlock>
                );
              }
              return (
                <code className="agentz-md-inline-code" {...props}>
                  {children}
                </code>
              );
            },
            a: ({ children, href }) => (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ),
            table: ({ children }) => (
              <div className="agentz-table-scroll">
                <table>{children}</table>
              </div>
            ),
            img: ({ src, alt }) => (
              <img
                src={src}
                alt={alt || "image"}
                className="agentz-md-image"
                loading="lazy"
                onClick={(e) => {
                  const w = window.open();
                  if (w && src) {
                    w.document.write(`<img src="${src}" style="max-width:100%">`);
                  }
                  e.stopPropagation();
                }}
              />
            ),
          }}
        >
          {content}
        </ReactMarkdown>
      </RenderErrorBoundary>
    </div>
  );
}
