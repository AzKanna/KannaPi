import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function normalizeAgentMarkdown(value: string): string {
  return value
    .replace(/^(\s{0,3}#{1,6})(?=[^#\s])/gm, "$1 ")
    .replace(/\*\*([^*\n]*?\S)\s+\*\*/g, "**$1**");
}

export function MarkdownBody({ children }: { children: string }) {
  return (
    <div className="markdown-body">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children: linkText }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {linkText}
            </a>
          ),
          img: ({ alt }) => <span className="blocked-image">[Image: {alt || "remote image"}]</span>,
        }}
      >
        {normalizeAgentMarkdown(children)}
      </Markdown>
    </div>
  );
}
