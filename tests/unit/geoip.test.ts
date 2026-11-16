import { describe, expect, it, vi } from "vitest";
import { openGeoCountryResolver } from "../../server/geoip.js";

describe("GeoCountryResolver", () => {
  it("maps a known public IP through the local reader and rejects non-public addresses", async () => {
    const lookups: string[] = [];
    const resolver = await openGeoCountryResolver("test-country.mmdb", {
      openReader: async () => ({
        country: (ipAddress) => {
          lookups.push(ipAddress);
          return { country: { isoCode: ipAddress === "1.1.1.1" ? "AU" : "US" } };
        }
      })
    });

    expect(resolver.countryFor("1.1.1.1")).toBe("AU");
    expect(resolver.countryFor("127.0.0.1")).toBe("UNKNOWN");
    expect(resolver.countryFor("::ffff:192.168.1.10")).toBe("UNKNOWN");
    expect(resolver.countryFor("2001:db8::1")).toBe("UNKNOWN");
    expect(resolver.countryFor("not-an-ip")).toBe("UNKNOWN");
    expect(lookups).toEqual(["1.1.1.1"]);
  });

  it("fails open to UNKNOWN and never includes the IP in warnings", async () => {
    const warn = vi.fn();
    const rawIp = "8.8.8.8";
    const resolver = await openGeoCountryResolver("lookup-error.mmdb", {
      logger: { warn },
      openReader: async () => ({ country: () => { throw new Error("lookup failed"); } })
    });

    expect(resolver.countryFor(rawIp)).toBe("UNKNOWN");
    expect(resolver.countryFor(rawIp)).toBe("UNKNOWN");
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(rawIp);
  });

  it("keeps serving UNKNOWN when the local database is unavailable", async () => {
    const warn = vi.fn();
    const resolver = await openGeoCountryResolver("missing-test-country.mmdb", {
      logger: { warn },
      openReader: async () => { throw new Error("missing"); }
    });

    expect(resolver.countryFor("1.1.1.1")).toBe("UNKNOWN");
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("1.1.1.1");
  });
});
