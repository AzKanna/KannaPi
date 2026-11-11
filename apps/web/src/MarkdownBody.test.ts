import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { MarkdownBody, normalizeAgentMarkdown } from "./MarkdownBody.js";

function render(markdown: string): string {
  return renderToStaticMarkup(createElement(MarkdownBody, { children: markdown }));
}

describe("Agent Markdown", () => {
  test("repairs common model formatting mistakes", () => {
    expect(normalizeAgentMarkdown("## Correct\n###Title\n**done **")).toBe(
      "## Correct\n### Title\n**done**",
    );
  });

  test("renders headings, lists and fenced code without executing HTML", () => {
    const html = render(
      "## Result\n\n- one\n- two\n\n~~~\nFLAG: example\n~~~\n<script>alert(1)</script>",
    );
    expect(html).toContain("<h2>Result</h2>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<pre><code>FLAG: example");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("alert(1)");
  });

  test("does not load remote images from Agent output", () => {
    const html = render("![tracker](https://example.test/pixel.png)");
    expect(html).toContain("[Image: tracker]");
    expect(html).not.toContain("<img");
  });
});
