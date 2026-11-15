import dns from "node:dns";
import { describe, expect, it } from "vitest";
import { withPinnedDnsLookup } from "./network-address.js";

describe("pinned dns lookup", () => {
  it("returns the validated address for the pinned hostname", async () => {
    await withPinnedDnsLookup(
      "connectors.example.test",
      [{ address: "203.0.113.10", family: 4 }],
      async () => {
        const result = await new Promise<{ address: string; family?: number }>(
          (resolve, reject) => {
            dns.lookup("connectors.example.test", (error, address, family) => {
              if (error) reject(error);
              else resolve({ address: String(address), family });
            });
          },
        );
        expect(result).toEqual({ address: "203.0.113.10", family: 4 });
      },
    );
  });

  it("leaves lookups outside a pinned context to the system resolver", async () => {
    await withPinnedDnsLookup("connectors.example.test", [], async () => undefined);
    await expect(dns.promises.lookup("127.0.0.1")).resolves.toEqual({
      address: "127.0.0.1",
      family: 4,
    });
  });

  it("does not pin lookups for other hostnames", async () => {
    await withPinnedDnsLookup(
      "connectors.example.test",
      [{ address: "203.0.113.10", family: 4 }],
      async () => {
        const result = await new Promise<string>((resolve, reject) => {
          dns.lookup("127.0.0.1", (error, address) => {
            if (error) reject(error);
            else resolve(String(address));
          });
        });
        expect(result).toBe("127.0.0.1");
      },
    );
  });

  it("pins dns.promises.lookup for the same hostname", async () => {
    await withPinnedDnsLookup(
      "connectors.example.test",
      [{ address: "203.0.113.10", family: 4 }],
      async () => {
        await expect(dns.promises.lookup("connectors.example.test")).resolves.toEqual({
          address: "203.0.113.10",
          family: 4,
        });
      },
    );
  });

  it("filters all-results lookups to the requested family", async () => {
    const dualStack = [
      { address: "203.0.113.10", family: 4 as const },
      { address: "2606:4700:4700::1111", family: 6 as const },
    ];
    await withPinnedDnsLookup("connectors.example.test", dualStack, async () => {
      const result = await new Promise<dns.LookupAddress[]>((resolve, reject) => {
        dns.lookup("connectors.example.test", { all: true, family: 4 }, (error, addresses) => {
          if (error) reject(error);
          else resolve(addresses as dns.LookupAddress[]);
        });
      });
      expect(result).toEqual([{ address: "203.0.113.10", family: 4 }]);
      await expect(
        dns.promises.lookup("connectors.example.test", { all: true, family: 6 }),
      ).resolves.toEqual([{ address: "2606:4700:4700::1111", family: 6 }]);
    });
  });

  it("fails a family-filtered lookup when no matching address is pinned", async () => {
    await withPinnedDnsLookup(
      "connectors.example.test",
      [{ address: "203.0.113.10", family: 4 }],
      async () => {
        await expect(
          new Promise((resolve, reject) => {
            dns.lookup("connectors.example.test", { all: true, family: 6 }, (error, addresses) => {
              if (error) reject(error);
              else resolve(addresses);
            });
          }),
        ).rejects.toThrow("Endpoint did not resolve to an address");
      },
    );
  });
});
