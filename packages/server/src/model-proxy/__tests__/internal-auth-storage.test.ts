import { describe, expect, it } from "vitest";
import { deriveOAuthBaseUrl } from "../internal-auth-storage.js";

describe("credential-specific OAuth base URL", () => {
  it("derives GitHub Copilot enterprise API host from proxy-ep", () => {
    expect(deriveOAuthBaseUrl(
      "github-copilot",
      "tid=abc;proxy-ep=proxy.enterprise.githubcopilot.com;exp=123",
    )).toBe("https://api.enterprise.githubcopilot.com");
  });

  it("does not invent a base URL for other providers or malformed tokens", () => {
    expect(deriveOAuthBaseUrl("anthropic", "token")).toBeUndefined();
    expect(deriveOAuthBaseUrl("github-copilot", "token")).toBeUndefined();
  });
});
