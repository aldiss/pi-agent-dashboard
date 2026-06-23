import { describe, it, expect } from "vitest";
import { parseUnfurlDirective, domainFromHref } from "../unfurl-directive.js";

describe("parseUnfurlDirective", () => {
  describe("non-directive titles → null (graceful default)", () => {
    it("returns null for undefined title", () => {
      expect(parseUnfurlDirective(undefined)).toBeNull();
    });
    it("returns null for empty string", () => {
      expect(parseUnfurlDirective("")).toBeNull();
    });
    it("returns null for an ordinary title", () => {
      expect(parseUnfurlDirective("Architecture diagram")).toBeNull();
    });
    it("does not match a marker embedded in a longer word", () => {
      expect(parseUnfurlDirective("snapshotting the build")).toBeNull();
    });
  });

  describe("bare markers → card with no highlights", () => {
    it("parses bare 'snapshot'", () => {
      const d = parseUnfurlDirective("snapshot");
      expect(d).not.toBeNull();
      expect(d!.highlights).toEqual([]);
    });
    it("parses bare 'unfurl'", () => {
      expect(parseUnfurlDirective("unfurl")!.highlights).toEqual([]);
    });
    it("is case-insensitive", () => {
      expect(parseUnfurlDirective("SNAPSHOT")).not.toBeNull();
    });
    it("tolerates surrounding whitespace", () => {
      expect(parseUnfurlDirective("  snapshot  ")).not.toBeNull();
    });
  });

  describe("payload form", () => {
    it("parses metadata fields", () => {
      const d = parseUnfurlDirective(
        'snapshot:{"title":"NOS Map","desc":"two flags","ts":"12:47","domain":"host:9090","caption":"cap"}',
      );
      expect(d).toMatchObject({
        title: "NOS Map",
        desc: "two flags",
        ts: "12:47",
        domain: "host:9090",
        caption: "cap",
      });
    });

    it("parses highlights (verbose shape) and assigns 1-based pin numbers", () => {
      const d = parseUnfurlDirective(
        'snapshot:{"highlights":[{"top":57.3,"left":28,"width":28,"height":7.2,"label":"the seam"},{"top":82.3,"left":6,"width":88,"height":11.6}]}',
      );
      expect(d!.highlights).toHaveLength(2);
      expect(d!.highlights[0]).toEqual({ top: 57.3, left: 28, width: 28, height: 7.2, label: "the seam", n: 1 });
      expect(d!.highlights[1]).toEqual({ top: 82.3, left: 6, width: 88, height: 11.6, n: 2 });
    });

    it("parses highlights (terse shape t/l/w/h)", () => {
      const d = parseUnfurlDirective('unfurl:{"highlights":[{"t":10,"l":20,"w":30,"h":40,"lab":"x"}]}');
      expect(d!.highlights[0]).toEqual({ top: 10, left: 20, width: 30, height: 40, label: "x", n: 1 });
    });
  });

  describe("defensive bounds (hostile / malformed payloads)", () => {
    it("clamps geometry to [0,100]", () => {
      const d = parseUnfurlDirective('snapshot:{"highlights":[{"top":-50,"left":250,"width":80,"height":300}]}');
      expect(d!.highlights[0]).toMatchObject({ top: 0, left: 100, width: 80, height: 100 });
    });
    it("drops zero-area regions", () => {
      const d = parseUnfurlDirective('snapshot:{"highlights":[{"top":10,"left":10,"width":0,"height":40}]}');
      expect(d!.highlights).toEqual([]);
    });
    it("ignores non-finite geometry", () => {
      const d = parseUnfurlDirective('snapshot:{"highlights":[{"top":"NaN","left":10,"width":10,"height":10}]}');
      // top coerces to 0 (fallback), region still valid
      expect(d!.highlights[0]).toMatchObject({ top: 0, left: 10, width: 10, height: 10 });
    });
    it("caps the number of highlights at 16", () => {
      const many = Array.from({ length: 40 }, () => ({ top: 1, left: 1, width: 5, height: 5 }));
      const d = parseUnfurlDirective(`snapshot:${JSON.stringify({ highlights: many })}`);
      expect(d!.highlights).toHaveLength(16);
    });
    it("truncates an over-long label", () => {
      const long = "x".repeat(200);
      const d = parseUnfurlDirective(`snapshot:${JSON.stringify({ highlights: [{ top: 1, left: 1, width: 5, height: 5, label: long }] })}`);
      expect(d!.highlights[0].label!.length).toBe(80);
    });
    it("returns a card (no highlights) when JSON is malformed but marker present", () => {
      const d = parseUnfurlDirective("snapshot:{not valid json");
      expect(d).not.toBeNull();
      expect(d!.highlights).toEqual([]);
    });
    it("returns a card when payload is a non-object JSON", () => {
      const d = parseUnfurlDirective("snapshot:42");
      expect(d).not.toBeNull();
      expect(d!.highlights).toEqual([]);
    });
  });
});

describe("domainFromHref", () => {
  it("returns host:port for an absolute URL", () => {
    expect(domainFromHref("http://100.126.219.9:9090/page.html")).toBe("100.126.219.9:9090");
  });
  it("returns host for an https URL without explicit port", () => {
    expect(domainFromHref("https://example.com/a/b")).toBe("example.com");
  });
  it("returns empty string for undefined", () => {
    expect(domainFromHref(undefined)).toBe("");
  });
});
