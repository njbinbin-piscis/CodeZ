import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import "./Markdown.css";

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const text = extractText(children);
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <div className="codez-codeblock">
      <button className="codez-codeblock-copy" onClick={copy} title="Copy">
        {copied ? "Copied" : "Copy"}
      </button>
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

/** Renders assistant text as GitHub-flavored markdown with code highlighting. */
export default function Markdown({ content }: { content: string }) {
  return (
    <div className="codez-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
