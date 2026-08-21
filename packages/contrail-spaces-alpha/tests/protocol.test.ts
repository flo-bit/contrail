import { describe, expect, it } from "vitest";
import {
  getRepoCar,
  type SpaceCredentialTransport,
} from "../src/protocol";

function transportFor(response: Response): SpaceCredentialTransport {
  return { fetch: async () => response } as unknown as SpaceCredentialTransport;
}

describe("bounded Space CAR download", () => {
  it("assembles a streamed CAR within the configured limit", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(1, 2, 3));
        controller.enqueue(Uint8Array.of(4, 5));
        controller.close();
      },
    }));
    const bytes = await getRepoCar(transportFor(response), "https://pds.example", {
      space: "at://did:plc:alice/space/garden.atmo.circle/self",
      repo: "did:plc:alice",
      maxBytes: 5,
    });
    expect([...bytes]).toEqual([1, 2, 3, 4, 5]);
  });

  it("cancels a chunked response as soon as it exceeds the limit", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(1, 2, 3, 4));
        controller.enqueue(Uint8Array.of(5, 6, 7, 8));
      },
      cancel() {
        cancelled = true;
      },
    }));
    await expect(getRepoCar(transportFor(response), "https://pds.example", {
      space: "at://did:plc:alice/space/garden.atmo.circle/self",
      repo: "did:plc:alice",
      maxBytes: 6,
    })).rejects.toMatchObject({
      status: 413,
      code: "RepoTooLarge",
    });
    expect(cancelled).toBe(true);
  });
});
