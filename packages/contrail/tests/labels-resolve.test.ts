import { describe, it, expect, vi } from "vitest";
import {
  CompositeDidDocumentResolver,
  PlcDidDocumentResolver,
  WebDidDocumentResolver,
  type DidDocumentResolver,
} from "@atcute/identity-resolver";
import {
  resolveLabelerEndpoint,
  validateEndpointUrl,
} from "../src/index";

describe("validateEndpointUrl additionalAllowedHosts", () => {
  it("rejects pds.dev.svc.cluster.local without override (HTTP + private hostname)", () => {
    expect(validateEndpointUrl("http://pds.dev.svc.cluster.local:2583")).toBe(false);
  });

  it("accepts pds.dev.svc.cluster.local when listed in additionalAllowedHosts (case-insensitive)", () => {
    expect(
      validateEndpointUrl("http://PDS.dev.svc.cluster.local:2583", [
        "pds.dev.svc.cluster.local",
      ]),
    ).toBe(true);
  });

  it("does not relax HTTPS requirement for non-listed hosts when override is present", () => {
    expect(
      validateEndpointUrl("http://attacker.com", ["pds.dev.svc.cluster.local"]),
    ).toBe(false);
  });

  it("ignores port differences (host-only match)", () => {
    expect(
      validateEndpointUrl("http://pds.dev.svc.cluster.local:9999", [
        "pds.dev.svc.cluster.local",
      ]),
    ).toBe(true);
  });
});

describe("resolveLabelerEndpoint resolver injection", () => {
  it("uses networkOverrides.resolver when provided", async () => {
    const mockResolver = {
      resolve: vi.fn().mockResolvedValue({
        service: [
          { id: "#atproto_labeler", serviceEndpoint: "https://labeler.test" },
        ],
      }),
    };
    const endpoint = await resolveLabelerEndpoint("did:plc:abc123", {
      resolver: mockResolver as unknown as DidDocumentResolver,
    });
    expect(endpoint).toBe("https://labeler.test");
    expect(mockResolver.resolve).toHaveBeenCalledOnce();
  });

  it("applies additionalAllowedHosts to resolved labeler endpoint", async () => {
    const mockResolver = {
      resolve: vi.fn().mockResolvedValue({
        service: [
          {
            id: "#atproto_labeler",
            serviceEndpoint: "http://labeler.dev.svc.cluster.local:2583",
          },
        ],
      }),
    };
    // Without override the http endpoint should be rejected
    const rejected = await resolveLabelerEndpoint("did:plc:abc123", {
      resolver: mockResolver as unknown as DidDocumentResolver,
    });
    expect(rejected).toBeNull();

    // With override it should pass
    const accepted = await resolveLabelerEndpoint("did:plc:abc123", {
      resolver: mockResolver as unknown as DidDocumentResolver,
      additionalAllowedHosts: ["labeler.dev.svc.cluster.local"],
    });
    expect(accepted).toBe("http://labeler.dev.svc.cluster.local:2583");
  });
});
