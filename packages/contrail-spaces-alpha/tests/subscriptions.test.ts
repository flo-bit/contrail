import { describe, expect, it, vi } from "vitest";
import { SpaceSubscriptionHub } from "../src/worker";

function stateFor(sockets: Array<{ send: (value: string) => void }> = []) {
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    values,
    state: {
      storage: {
        put: async (key: string, value: unknown) => void values.set(key, value),
        get: async (key: string) => values.get(key),
        delete: async (key: string | string[]) => {
          for (const item of Array.isArray(key) ? key : [key]) values.delete(item);
          return true;
        },
        list: async ({ prefix }: { prefix: string }) => new Map(
          [...values].filter(([key]) => key.startsWith(prefix)),
        ),
        getAlarm: async () => alarm,
        setAlarm: async (value: number) => void (alarm = value),
      },
      getWebSockets: () => sockets,
    } as unknown as DurableObjectState,
  };
}

describe("Space subscription hub", () => {
  it("stores short-lived one-time connection tickets", async () => {
    const { state, values } = stateFor();
    const hub = new SpaceSubscriptionHub(state);
    const expiresAt = Date.now() + 30_000;
    const response = await hub.fetch(new Request("https://internal/issue", {
      method: "POST",
      body: JSON.stringify({ ticket: "ticket-abcdefghijkl", expiresAt }),
    }));
    expect(response.status).toBe(200);
    expect(values.get("ticket:ticket-abcdefghijkl")).toEqual({ expiresAt });
  });

  it("broadcasts only an invalidation payload to connected clients", async () => {
    const send = vi.fn();
    const { state } = stateFor([{ send }]);
    const hub = new SpaceSubscriptionHub(state);
    const payload = JSON.stringify({ type: "invalidate", space: "at://did:plc:a/space/x/self" });
    const response = await hub.fetch(new Request("https://internal/broadcast", {
      method: "POST",
      body: payload,
    }));
    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledWith(payload);
  });
});
