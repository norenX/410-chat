import { BlockList, isIP } from "node:net";
import { Reader } from "@maxmind/geoip2-node";

export const UNKNOWN_COUNTRY = "UNKNOWN";

export interface GeoCountryResolver {
  countryFor(ipAddress: string): string;
}

interface GeoIpReader {
  country(ipAddress: string): { country?: { isoCode: string } };
}

export interface GeoCountryResolverOptions {
  logger?: Pick<Console, "warn">;
  openReader?: (filePath: string) => Promise<GeoIpReader>;
}

const nonPublicAddresses = new BlockList();

for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
] as const) nonPublicAddresses.addSubnet(address, prefix, "ipv4");

for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8]
] as const) nonPublicAddresses.addSubnet(address, prefix, "ipv6");

const warnedUnavailableFiles = new Set<string>();

function normalizedPublicIp(value: string): string | null {
  let address = value.trim();
  const zoneIndex = address.indexOf("%");
  if (zoneIndex >= 0) address = address.slice(0, zoneIndex);
  if (address.startsWith("[") && address.endsWith("]")) address = address.slice(1, -1);

  const mappedIpv4 = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)?.[1];
  if (mappedIpv4) address = mappedIpv4;

  const version = isIP(address);
  if (version === 4 && !nonPublicAddresses.check(address, "ipv4")) return address;
  if (version === 6 && !nonPublicAddresses.check(address, "ipv6")) return address;
  return null;
}

function validCountryCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z]{2}$/.test(value);
}

class MmdbCountryResolver implements GeoCountryResolver {
  private warnedLookupFailure = false;

  constructor(
    private readonly reader: GeoIpReader,
    private readonly logger: Pick<Console, "warn">
  ) {}

  countryFor(ipAddress: string): string {
    const publicIp = normalizedPublicIp(ipAddress);
    if (!publicIp) return UNKNOWN_COUNTRY;

    try {
      const countryCode = this.reader.country(publicIp).country?.isoCode?.toUpperCase();
      return validCountryCode(countryCode) ? countryCode : UNKNOWN_COUNTRY;
    } catch {
      if (!this.warnedLookupFailure) {
        this.warnedLookupFailure = true;
        this.logger.warn("[410] GeoIP lookup failed; affected page views use UNKNOWN");
      }
      return UNKNOWN_COUNTRY;
    }
  }
}

const unknownResolver: GeoCountryResolver = {
  countryFor: () => UNKNOWN_COUNTRY
};

export async function openGeoCountryResolver(
  filePath: string,
  options: GeoCountryResolverOptions = {}
): Promise<GeoCountryResolver> {
  const logger = options.logger ?? console;
  const openReader = options.openReader ?? ((path: string) => Reader.open(path));

  try {
    return new MmdbCountryResolver(await openReader(filePath), logger);
  } catch {
    if (!warnedUnavailableFiles.has(filePath)) {
      warnedUnavailableFiles.add(filePath);
      logger.warn("[410] GeoIP database is unavailable; country metrics use UNKNOWN");
    }
    return unknownResolver;
  }
}
