import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, act, fireEvent, cleanup, waitFor } from "@testing-library/react";
import React, { useState } from "react";
import { MarkdownContent, tableToMarkdown, tableToTsv } from "../MarkdownContent.js";
import { ThemeProvider } from "../ThemeProvider.js";
import { SessionAssetsProvider } from "../../lib/SessionAssetsContext.js";

// Each test renders a MarkdownContent into the document; the lightbox
// portals to document.body. Cleanup unmounts both, removing any open
// modal so cross-test backdrop queries are unambiguous.
// See change: add-lightbox-to-markdown-images.
afterEach(() => {
  cleanup();
});

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(prefers-color-scheme: dark)",
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

function renderMd(content: string) {
  return render(<ThemeProvider><MarkdownContent content={content} /></ThemeProvider>);
}

describe("MarkdownContent", () => {
  it("renders plain text as a paragraph", () => {
    const { container } = renderMd("Hello world");
    expect(container.querySelector("p")?.textContent).toBe("Hello world");
  });

  it("renders inline code with monospace styling", () => {
    const { container } = render(
      <ThemeProvider><MarkdownContent content="Use `npm install` here" /></ThemeProvider>
    );
    const code = container.querySelector("code");
    expect(code).not.toBeNull();
    expect(code?.textContent).toBe("npm install");
    expect(code?.className).toContain("font-mono");
  });

  it("renders fenced code block with syntax highlighter", async () => {
    const content = "```javascript\nconst x = 42;\n```";
    const { container } = render(<ThemeProvider><MarkdownContent content={content} /></ThemeProvider>);
    // SyntaxHighlighter is now lazy (HighlightedCode Suspense): the highlighted
    // markup with the language- class appears once the dynamic import resolves.
    await waitFor(() => {
      const highlighted = container.querySelector('[class*="language-"]');
      expect(highlighted).not.toBeNull();
    });
    expect(container.textContent).toContain("const x = 42;");
  });

  it("renders fenced code block without language", () => {
    const content = "```\nsome code\n```";
    const { container } = render(<ThemeProvider><MarkdownContent content={content} /></ThemeProvider>);
    expect(container.textContent).toContain("some code");
  });

  it("renders headings", () => {
    const { container } = renderMd("## My Heading");
    const h2 = container.querySelector("h2");
    expect(h2?.textContent).toBe("My Heading");
  });

  it("renders bold and italic", () => {
    const { container } = render(
      <ThemeProvider><MarkdownContent content="**bold** and *italic*" /></ThemeProvider>
    );
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("italic");
  });

  it("renders unordered lists", () => {
    const content = "- item one\n- item two";
    const { container } = render(<ThemeProvider><MarkdownContent content={content} /></ThemeProvider>);
    const items = container.querySelectorAll("li");
    expect(items.length).toBe(2);
    expect(items[0].textContent).toBe("item one");
  });

  it("renders links", () => {
    const { container } = render(
      <ThemeProvider><MarkdownContent content="[click here](https://example.com)" /></ThemeProvider>
    );
    const link = container.querySelector("a");
    expect(link?.textContent).toBe("click here");
    expect(link?.getAttribute("href")).toBe("https://example.com");
  });

  it("uses div as root element to avoid nested p tags", () => {
    const { container } = renderMd("Hello world");
    const root = container.firstElementChild;
    expect(root?.tagName).toBe("DIV");
    expect(root?.className).toContain("markdown-content");
  });

  it("renders fenced code block with copy button", () => {
    const content = "```javascript\nconst x = 42;\n```";
    const { container } = render(<ThemeProvider><MarkdownContent content={content} /></ThemeProvider>);
    const copyBtn = container.querySelector('button[title="Copy code"]');
    expect(copyBtn).not.toBeNull();
    expect(copyBtn?.querySelector("svg")).not.toBeNull();
  });

  it("does not render copy button on inline code", () => {
    const { container } = render(
      <ThemeProvider><MarkdownContent content="Use `npm install` here" /></ThemeProvider>
    );
    const copyBtn = container.querySelector('button[title="Copy code"]');
    expect(copyBtn).toBeNull();
  });

  it("renders GFM table as HTML table", () => {
    const content = [
      "| Name | Age |",
      "| --- | --- |",
      "| Alice | 30 |",
      "| Bob | 25 |",
    ].join("\n");

    const { container } = render(<ThemeProvider><MarkdownContent content={content} /></ThemeProvider>);
    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    const headers = container.querySelectorAll("th");
    expect(headers.length).toBe(2);
    expect(headers[0].textContent).toBe("Name");
    expect(headers[1].textContent).toBe("Age");
    const cells = container.querySelectorAll("td");
    expect(cells.length).toBe(4);
    expect(cells[0].textContent).toBe("Alice");
  });

  it("renders table with copy buttons", () => {
    const content = "| Name | Age |\n| --- | --- |\n| Alice | 30 |";
    const { container } = render(<ThemeProvider><MarkdownContent content={content} /></ThemeProvider>);
    const mdBtn = container.querySelector('button[title="Copy as Markdown"]');
    const tsvBtn = container.querySelector('button[title="Copy as TSV"]');
    expect(mdBtn).not.toBeNull();
    expect(mdBtn?.querySelector("svg")).not.toBeNull();
    expect(tsvBtn).not.toBeNull();
    expect(tsvBtn?.querySelector("svg")).not.toBeNull();
  });

  it("tableToMarkdown produces correct output", () => {
    const doc = document.createElement("div");
    doc.innerHTML = "<table><tr><th>Name</th><th>Age</th></tr><tr><td>Alice</td><td>30</td></tr></table>";
    const table = doc.querySelector("table") as HTMLTableElement;
    const md = tableToMarkdown(table);
    expect(md).toBe("| Name | Age |\n| --- | --- |\n| Alice | 30 |");
  });

  it("tableToTsv produces correct output", () => {
    const doc = document.createElement("div");
    doc.innerHTML = "<table><tr><th>Name</th><th>Age</th></tr><tr><td>Alice</td><td>30</td></tr></table>";
    const table = doc.querySelector("table") as HTMLTableElement;
    const tsv = tableToTsv(table);
    expect(tsv).toBe("Name\tAge\nAlice\t30");
  });

  it("renders mixed markdown content", () => {
    const content = [
      "# Title",
      "",
      "Some **bold** text with `inline code`.",
      "",
      "```typescript",
      "const x = 1;",
      "```",
      "",
      "- list item",
    ].join("\n");

    const { container } = render(<ThemeProvider><MarkdownContent content={content} /></ThemeProvider>);
    expect(container.querySelector("h1")).not.toBeNull();
    expect(container.querySelector("strong")).not.toBeNull();
    expect(container.querySelector("code")).not.toBeNull();
    expect(container.querySelector("li")).not.toBeNull();
  });

  it("strips raw HTML ref attributes before rendering", () => {
    const { container } = renderMd('<section ref="bad"><publiccheckoutpanel ref="bad">Pay</publiccheckoutpanel></section>');

    expect(container.textContent).toContain("Pay");
    expect(container.querySelector("section")?.getAttribute("ref")).toBeNull();
    expect(container.querySelector("publiccheckoutpanel")?.getAttribute("ref")).toBeNull();
  });

  it("renders mermaid code block as MermaidBlock instead of syntax highlighter", () => {
    const content = "```mermaid\ngraph TD; A-->B\n```";
    const { container } = render(<ThemeProvider><MarkdownContent content={content} /></ThemeProvider>);
    // Should NOT have syntax highlighter
    const highlighted = container.querySelector('[class*="language-"]');
    expect(highlighted).toBeNull();
    // Should have mermaid-related content (loading state or rendered)
    const text = container.textContent || "";
    expect(text).toMatch(/loading diagram|graph TD/i);
  });

  // ASCII table fixer disabled pending refinement
  it.skip("renders ASCII box-drawing table in monospace code block", () => {
    const content = [
      "Here is a table:",
      "┌──────┬──────┐",
      "│ Name │ Type │",
      "├──────┼──────┤",
      "│ foo  │ str  │",
      "└──────┴──────┘",
    ].join("\n");

    const { container } = render(<ThemeProvider><MarkdownContent content={content} /></ThemeProvider>);
    // The table should be rendered inside a code/pre block (monospace)
    const codeBlock = container.querySelector("code");
    expect(codeBlock).not.toBeNull();
    expect(codeBlock!.textContent).toContain("┌──────┬──────┐");
    expect(codeBlock!.textContent).toContain("│ Name │ Type │");
  });

  it("does not re-render when content prop is unchanged (React.memo)", () => {
    const renderSpy = vi.fn();

    // A wrapper that forces re-renders via state, passing same content prop
    function Wrapper() {
      const [tick, setTick] = useState(0);
      renderSpy();
      return (
        <ThemeProvider>
          <MarkdownContent content="static content" />
          <button data-testid="rerender" onClick={() => setTick((t) => t + 1)}>tick</button>
        </ThemeProvider>
      );
    }

    const { getByTestId, container } = render(<Wrapper />);
    const initialHtml = container.innerHTML;
    expect(renderSpy).toHaveBeenCalledTimes(1);

    // Force parent re-render
    act(() => { getByTestId("rerender").click(); });
    expect(renderSpy).toHaveBeenCalledTimes(2); // parent re-rendered

    // Content should be identical — MarkdownContent should have been skipped by memo
    expect(container.innerHTML).toBe(initialHtml);
  });

  describe("anchor target handling", () => {
    it("renders external absolute URL with target=_blank and rel=noopener noreferrer", () => {
      const { container } = render(
        <ThemeProvider><MarkdownContent content="See [docs](https://example.com)" /></ThemeProvider>
      );
      const link = container.querySelector("a");
      expect(link).not.toBeNull();
      expect(link!.getAttribute("href")).toBe("https://example.com");
      expect(link!.getAttribute("target")).toBe("_blank");
      expect(link!.getAttribute("rel")).toBe("noopener noreferrer");
    });

    it("renders GFM autolink with target=_blank", () => {
      const { container } = render(
        <ThemeProvider><MarkdownContent content="Visit https://example.com for more." /></ThemeProvider>
      );
      const link = container.querySelector("a");
      expect(link).not.toBeNull();
      expect(link!.getAttribute("href")).toBe("https://example.com");
      expect(link!.getAttribute("target")).toBe("_blank");
      expect(link!.getAttribute("rel")).toBe("noopener noreferrer");
    });

    it("renders fragment-only link without target attribute", () => {
      const { container } = render(
        <ThemeProvider><MarkdownContent content="[top](#top)" /></ThemeProvider>
      );
      const link = container.querySelector("a");
      expect(link).not.toBeNull();
      expect(link!.getAttribute("href")).toBe("#top");
      expect(link!.getAttribute("target")).toBeNull();
    });

    it("renders same-origin relative path without target attribute", () => {
      const { container } = render(
        <ThemeProvider><MarkdownContent content="[settings](/settings)" /></ThemeProvider>
      );
      const link = container.querySelector("a");
      expect(link).not.toBeNull();
      expect(link!.getAttribute("href")).toBe("/settings");
      expect(link!.getAttribute("target")).toBeNull();
    });

    it("renders same-origin absolute URL without target attribute", () => {
      // When the href matches window.location.origin, no target should be set
      const sameOrigin = `${window.location.origin}/auth/login?return=/`;
      const { container } = render(
        <ThemeProvider><MarkdownContent content={`[login](${sameOrigin})`} /></ThemeProvider>
      );
      const link = container.querySelector("a");
      expect(link).not.toBeNull();
      expect(link!.getAttribute("href")).toBe(sameOrigin);
      expect(link!.getAttribute("target")).toBeNull();
    });

    it("preserves external-link blue styling", () => {
      const { container } = render(
        <ThemeProvider><MarkdownContent content="[docs](https://example.com)" /></ThemeProvider>
      );
      const link = container.querySelector("a");
      expect(link?.className).toContain("text-blue-400");
      expect(link?.className).toContain("hover:underline");
    });
  });

  // chat-markdown-local-images-and-math: math + image rendering
  describe("LaTeX math", () => {
    it("renders inline single-dollar math as a KaTeX node", () => {
      const { container } = renderMd("Pythagoras: $a^2 + b^2 = c^2$.");
      expect(container.querySelector(".katex")).not.toBeNull();
    });

    it("renders display double-dollar math as katex-display when on its own line", () => {
      // remark-math treats `$$…$$` as DISPLAY math only when it's a
      // block-level construct (preceded/followed by blank lines or at
      // the start/end of input). Inline `$$…$$` is treated as inline.
      const { container } = renderMd("$$\n\\sum_{i=0}^{n} i\n$$");
      expect(container.querySelector(".katex-display")).not.toBeNull();
    });

    it("renders \\beta as the beta glyph", () => {
      const { container } = renderMd("$x = \\beta$");
      const katex = container.querySelector(".katex");
      expect(katex).not.toBeNull();
      // The actual rendered text should contain a beta glyph (β) somewhere
      expect(container.textContent).toMatch(/β/);
    });

    it("does NOT throw on half-formed math (throwOnError:false)", () => {
      // Half-formed `$x = 10 +` simulates a streaming chunk before the
      // closing dollar arrives. Pre-fix this would throw a ParseError;
      // post-fix it must render without crashing.
      expect(() => renderMd("Working: $x = 10 +")).not.toThrow();
    });
  });

  describe("pi-asset image resolution", () => {
    function renderWithAssets(
      content: string,
      assets: Record<string, { data: string; mimeType: string }>,
    ) {
      return render(
        <ThemeProvider>
          <SessionAssetsProvider assets={assets}>
            <MarkdownContent content={content} />
          </SessionAssetsProvider>
        </ThemeProvider>,
      );
    }

    it("resolves pi-asset:<hash> against the session asset map to a data: URL", () => {
      const { container } = renderWithAssets(
        "![pic](pi-asset:abc1234567890123)",
        { abc1234567890123: { data: "AAAA", mimeType: "image/png" } },
      );
      const img = container.querySelector("img");
      expect(img).not.toBeNull();
      expect(img!.getAttribute("src")).toBe("data:image/png;base64,AAAA");
      expect(img!.getAttribute("alt")).toBe("pic");
    });

    it("renders a visible placeholder when the hash is not in the map", () => {
      const { container } = renderWithAssets("![pic](pi-asset:zzz)", {});
      // The placeholder is a <span>, not an <img>. The original alt should
      // appear in the placeholder text.
      expect(container.querySelector("img")).toBeNull();
      expect(container.textContent).toContain("pic");
      expect(container.textContent).toMatch(/loading/i);
    });

    it("falls through to default <img> for external https URLs", () => {
      const { container } = renderMd("![logo](https://example.com/logo.png)");
      const img = container.querySelector("img");
      expect(img).not.toBeNull();
      expect(img!.getAttribute("src")).toBe("https://example.com/logo.png");
    });

    it("falls through to default <img> for data: URLs", () => {
      const { container } = renderMd("![](data:image/png;base64,XXX)");
      const img = container.querySelector("img");
      expect(img).not.toBeNull();
      expect(img!.getAttribute("src")).toBe("data:image/png;base64,XXX");
    });

    it("placeholder swaps to resolved image when assets context updates", () => {
      // Re-render with the same MarkdownContent instance but a populated
      // asset map; the resolver should reactively render the image.
      const content = "![pic](pi-asset:hhh)";
      const { container, rerender } = render(
        <ThemeProvider>
          <SessionAssetsProvider assets={{}}>
            <MarkdownContent content={content} />
          </SessionAssetsProvider>
        </ThemeProvider>,
      );
      expect(container.querySelector("img")).toBeNull();
      rerender(
        <ThemeProvider>
          <SessionAssetsProvider assets={{ hhh: { data: "BBBB", mimeType: "image/jpeg" } }}>
            <MarkdownContent content={content} />
          </SessionAssetsProvider>
        </ThemeProvider>,
      );
      const img = container.querySelector("img");
      expect(img).not.toBeNull();
      expect(img!.getAttribute("src")).toBe("data:image/jpeg;base64,BBBB");
    });
  });

  // chat-markdown-local-images-and-math → add-lightbox-to-markdown-images:
  // every successfully-rendered <img> should be clickable to open the
  // shared <ImageLightbox> with the same src/alt.
  describe("click-to-open lightbox on markdown images", () => {
    function findLightboxBackdrop(): HTMLElement | null {
      // ImageLightbox renders the backdrop with data-testid="lightbox-backdrop"
      // via DialogPortal at document.body, NOT inside our render container.
      return document.querySelector('[data-testid="lightbox-backdrop"]');
    }

    function expectNoLightbox() {
      expect(findLightboxBackdrop()).toBeNull();
    }

    afterEachCleanupOpenLightboxes();

    it("clicking a resolved pi-asset image opens the lightbox", () => {
      const { container } = render(
        <ThemeProvider>
          <SessionAssetsProvider assets={{ abc: { data: "AAAA", mimeType: "image/png" } }}>
            <MarkdownContent content="![pic](pi-asset:abc)" />
          </SessionAssetsProvider>
        </ThemeProvider>,
      );
      expectNoLightbox();
      const img = container.querySelector("img")!;
      expect(img.className).toMatch(/cursor-pointer/);
      fireEvent.click(img);
      const backdrop = findLightboxBackdrop();
      expect(backdrop).not.toBeNull();
      const modalImg = backdrop!.querySelector("img");
      expect(modalImg).not.toBeNull();
      expect(modalImg!.getAttribute("src")).toBe("data:image/png;base64,AAAA");
      expect(modalImg!.getAttribute("alt")).toBe("pic");
    });

    it("clicking an external URL image opens the lightbox with the URL verbatim", () => {
      const { container } = renderMd("![logo](https://example.com/logo.png)");
      expectNoLightbox();
      const img = container.querySelector("img")!;
      expect(img.className).toMatch(/cursor-pointer/);
      fireEvent.click(img);
      const modalImg = findLightboxBackdrop()!.querySelector("img")!;
      expect(modalImg.getAttribute("src")).toBe("https://example.com/logo.png");
      expect(modalImg.getAttribute("alt")).toBe("logo");
    });

    it("clicking an inline data: image opens the lightbox with the data URL verbatim", () => {
      const { container } = renderMd("![inline](data:image/png;base64,XXX)");
      const img = container.querySelector("img")!;
      fireEvent.click(img);
      const modalImg = findLightboxBackdrop()!.querySelector("img")!;
      expect(modalImg.getAttribute("src")).toBe("data:image/png;base64,XXX");
    });

    it("unresolved pi-asset placeholder is NOT clickable / does not open the lightbox", () => {
      const { container } = render(
        <ThemeProvider>
          <SessionAssetsProvider assets={{}}>
            <MarkdownContent content="![pic](pi-asset:zzz)" />
          </SessionAssetsProvider>
        </ThemeProvider>,
      );
      // No <img> at all on the unresolved branch (it renders a <span>).
      expect(container.querySelector("img")).toBeNull();
      const placeholder = container.querySelector("span");
      expect(placeholder).not.toBeNull();
      // Clicking the placeholder is a no-op for the lightbox machinery.
      fireEvent.click(placeholder!);
      expectNoLightbox();
    });

    it("click stops propagation so a wrapping link does not navigate", () => {
      // [![alt](src)](href) — markdown image inside a link.
      const parentClick = vi.fn();
      const { container } = render(
        <ThemeProvider>
          <div onClick={parentClick}>
            <MarkdownContent content="[![logo](https://example.com/x.png)](https://example.com/page)" />
          </div>
        </ThemeProvider>,
      );
      const img = container.querySelector("img")!;
      fireEvent.click(img);
      // The lightbox opened…
      expect(findLightboxBackdrop()).not.toBeNull();
      // …and the parent click handler was NOT invoked because of
      // stopPropagation in PiAssetImg's onClick.
      expect(parentClick).not.toHaveBeenCalled();
    });
  });

  /** Close any open lightbox modals between tests so backdrop queries from
   *  the previous test don't bleed into the next. */
  function afterEachCleanupOpenLightboxes() {
    return undefined; // afterEach is registered at module-load below
  }

  // ASCII table fixer disabled pending refinement
  it.skip("renders mixed ASCII table and normal markdown correctly", () => {
    const content = [
      "Some **bold** text.",
      "",
      "┌───┬───┐",
      "│ A │ B │",
      "└───┴───┘",
      "",
      "More text.",
    ].join("\n");

    const { container } = render(<ThemeProvider><MarkdownContent content={content} /></ThemeProvider>);
    expect(container.querySelector("strong")).not.toBeNull();
    const codeBlock = container.querySelector("code");
    expect(codeBlock).not.toBeNull();
    expect(codeBlock!.textContent).toContain("│ A │ B │");
  });
});

// Render-verify for the message-render bug (event-store byte-cap clipped a long
// orchestrator message to 200 chars, ending mid-`**bold**`). The RENDERER is
// innocent: react-markdown renders an unclosed `**` literally (correct
// CommonMark) — the literal `**` the operator saw was the symptom of upstream
// truncation, not a renderer fault. These tests pin both halves: full content
// renders as <strong> (the fixed path), and the truncated input is exactly what
// produces the literal `**` (the bug), plus a full stress message renders every
// block construct correctly. See change: event-store-bytecap-preserve-chat.
describe("message-render: literal ** + mid-bold truncation (renderer innocence)", () => {
  const prefix =
    "This is the most important thing you've said tonight — and you're right. " +
    "Let me reflect it back sharp, because getting the framing right IS the work:\n\n";
  const boldSpan = "**We've been building fragile, then patching the fragility instead of curing it**";
  const tail = "\n\nYour two steps are exactly right. Let me lock them in and dispatch Step 1 now.";

  it("renders the FULL message with <strong> bold — no literal ** (the fixed path)", () => {
    const { container } = renderMd(prefix + boldSpan + tail);
    const strong = container.querySelector("strong");
    expect(strong).not.toBeNull();
    expect(strong!.textContent).toBe(
      "We've been building fragile, then patching the fragility instead of curing it",
    );
    // The full message text is present (not cut at ~4 lines) …
    expect(container.textContent).toContain("dispatch Step 1 now.");
    // … and no raw asterisks leak into the rendered output.
    expect(container.textContent).not.toContain("**");
  });

  it("renders the 200-char-CLIPPED input with a LITERAL ** (documents the bug + renderer innocence)", () => {
    // Exactly what the buggy byte-cap summary served: prose sliced at 200 chars,
    // mid-bold, so the closing ** is gone. react-markdown CORRECTLY renders the
    // unclosed opener as literal text — proving the renderer is not at fault.
    const clipped = (prefix + boldSpan).slice(0, 200);
    expect(clipped).not.toContain("curing it**"); // closing marker was lost
    const { container } = renderMd(clipped);
    expect(container.querySelector("strong")).toBeNull(); // no bold rendered
    expect(container.textContent).toContain("**"); // literal asterisks shown
    expect(container.textContent).toContain("patching the"); // ends mid-sentence
  });

  it("renders a full STRESS message (## + > + --- + lists + **bold** + long) correctly across constructs", () => {
    const stress = [
      "## Framing",
      "",
      "> We've been building fragile, then patching the fragility.",
      "",
      "**The cure is to fix the cause, not the symptom.** " + "Long tail. ".repeat(40),
      "",
      "---",
      "",
      "- Step 1: find the root cause",
      "- Step 2: fix the **cause**",
      "- Step 3: add a regression test",
      "",
      "Closing line after the list.",
    ].join("\n");
    const { container } = renderMd(stress);
    expect(container.querySelector("h2")?.textContent).toBe("Framing");
    expect(container.querySelector("blockquote")).not.toBeNull();
    expect(container.querySelector("hr")).not.toBeNull();
    const items = container.querySelectorAll("ul li");
    expect(items.length).toBe(3);
    expect(container.querySelectorAll("strong").length).toBeGreaterThanOrEqual(2);
    // Full content rendered (the long tail + closing line both present) …
    expect(container.textContent).toContain("Closing line after the list.");
    // … and zero raw `**` leaks anywhere in the output.
    expect(container.textContent).not.toContain("**");
  });
});
