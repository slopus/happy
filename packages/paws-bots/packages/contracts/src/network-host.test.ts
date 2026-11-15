import { isIP } from "node:net";
import { describe, expect, it } from "vitest";
import {
  ipVersion,
  isCloudMetadataAddress,
  isCloudMetadataHost,
  isInternalHostname,
  isLinkLocalAddress,
  isLocalhostOrLoopbackIp,
  isLoopbackAddress,
  isLoopbackHost,
  isNonPublicAddress,
  isPrivateNetworkAddress,
  isPrivateNetworkHost,
  normalizeHost,
} from "./network-host.js";

describe("address classification (moved from the adapters SSRF guard)", () => {
  it.each([
    "169.254.1.1",
    "fe80::1",
    "::169.254.1.1",
    "::ffff:169.254.1.1",
    "::a9fe:101",
    "::ffff:a9fe:101",
  ])("classifies %s as link-local", (address) => {
    expect(isLinkLocalAddress(address)).toBe(true);
  });

  it.each(["127.0.0.1", "192.168.1.1", "::1", "fd00::1", "203.0.113.1"])(
    "does not classify %s as link-local",
    (address) => {
      expect(isLinkLocalAddress(address)).toBe(false);
    },
  );

  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "192.168.0.9",
    "169.254.169.254",
    "::1",
    "fe80::1",
    "fc00::1",
    "fd00:ec2::254",
    "::ffff:169.254.169.254",
    "::ffff:10.0.0.1",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b::169.254.169.254",
    "64:ff9b::10.1.2.3",
    "2002:a9fe:a9fe::1",
    "2002:0a01:0203::",
    "2002:c0a8:0001::1",
    "0.0.0.0",
    "0.1.2.3",
    "100.64.0.1",
    "100.127.255.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.8",
    "192.0.0.170",
    "192.88.99.1",
    "198.18.0.1",
    "198.19.255.255",
    "224.0.0.1",
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.254",
    "255.255.255.255",
    "::",
    "::ffff:192.0.0.8",
    "::ffff:ffff:ffff",
    "::ffff:c000:0008",
    "64:ff9b::240.0.0.1",
    "64:ff9b:1::8.8.8.8",
    "64:ff9b:1:ffff::1",
    "2002:c000:0001::1",
    "2002:ffff:ffff::1",
    "100::1",
    "100::ffff:ffff:ffff:ffff",
    "2001::1",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "2001:2::1",
    "2001:1ff:ffff::1",
    "fd7a:115c:a1e0::1",
    "febf::1",
    "fec0::1",
    "ff02::1",
  ])("classifies %s as non-public", (address) => {
    expect(isNonPublicAddress(address)).toBe(true);
  });

  it.each([
    "203.0.113.10",
    "8.8.8.8",
    "1.1.1.1",
    "100.63.255.255",
    "100.128.0.1",
    "172.15.255.255",
    "172.32.0.1",
    "192.0.1.1",
    "192.88.98.1",
    "198.17.255.255",
    "198.20.0.1",
    "223.255.255.255",
    "2606:4700:4700::1111",
    "2001:200::1",
    "2001:4860:4860::8888",
    "2a00:1450:4001::1",
    "64:ff9b::8.8.8.8",
    "64:ff9b::cb00:7101",
    "64:ff9b::203.0.113.10",
    "2002:cb00:7101::1",
    "::ffff:203.0.113.10",
  ])("classifies %s as public", (address) => {
    expect(isNonPublicAddress(address)).toBe(false);
  });

  it.each([
    "169.254.169.254",
    "169.254.170.2",
    "::ffff:169.254.170.2",
    "::ffff:a9fe:aa02",
    "100.100.100.200",
    "fd00:ec2::254",
    "fd00:0ec2:0000:0000:0000:0000:0000:0254",
    "::ffff:100.100.100.200",
    "64:ff9b::6464:64c8",
    "2002:6464:64c8::1",
  ])("classifies %s as a cloud metadata address", (address) => {
    expect(isCloudMetadataAddress(address)).toBe(true);
  });

  it.each(["10.0.0.1", "100.100.100.201", "fd00:ec2::255"])(
    "does not classify %s as a cloud metadata address",
    (address) => {
      expect(isCloudMetadataAddress(address)).toBe(false);
    },
  );

  it.each(["127.0.0.1", "127.255.255.255", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1"])(
    "classifies %s as loopback",
    (address) => {
      expect(isLoopbackAddress(address)).toBe(true);
    },
  );

  it.each([
    "10.1.2.3",
    "192.168.0.9",
    "169.254.169.254",
    "::",
    "fd00::1",
    "203.0.113.10",
    "::ffff:0a01:0203",
  ])("does not classify %s as loopback", (address) => {
    expect(isLoopbackAddress(address)).toBe(false);
  });
});

describe("ipVersion", () => {
  it.each([
    "127.0.0.1",
    "0.0.0.0",
    "255.255.255.255",
    "256.0.0.1",
    "01.2.3.4",
    "1.2.3",
    "1.2.3.4.5",
    "::",
    "::1",
    "[::1]",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "fe80::1%en0",
    "1:2:3:4:5:6:7:8",
    "1:2:3:4:5:6:7::",
    "1:2:3:4:5:6:7:8:9",
    "1::2::3",
    ":::",
    "12345::",
    "::1.2.3",
    "1.2.3.4::",
    "localhost",
    "example.test",
    "",
  ])("agrees with node:net isIP for %s", (value) => {
    expect(ipVersion(value)).toBe(isIP(value.replace(/^\[|\]$/g, "")));
  });
});

// Columns: host, isLocalhostOrLoopbackIp, isLoopbackHost, isPrivateNetworkHost,
// isInternalHostname, isCloudMetadataHost, isNonPublicAddress (IP literals only, else null).
const HOSTS: [string, boolean, boolean, boolean, boolean, boolean, boolean | null][] = [
  // Names
  ["localhost", true, true, true, true, false, null],
  ["LOCALHOST", true, true, true, true, false, null],
  ["localhost.", false, false, false, true, false, null],
  ["app.localhost", false, true, true, true, false, null],
  ["app.localhost.", false, false, false, true, false, null],
  ["localhost.example.test", false, false, false, false, false, null],
  ["printer.local", false, false, true, true, false, null],
  ["Printer.Local", false, false, true, true, false, null],
  ["printer.local.", false, false, false, true, false, null],
  ["db.internal", false, false, false, true, false, null],
  ["host.docker.internal", false, false, false, true, false, null],
  ["metadata.google.internal", false, false, false, true, true, null],
  ["metadata.google.internal.", false, false, false, true, true, null],
  ["metadata.goog", false, false, false, false, true, null],
  ["box.ts.net", false, false, false, false, false, null],
  ["example.test", false, false, false, false, false, null],
  // IPv4 loopback is the whole /8
  ["127.0.0.1", true, true, true, false, false, true],
  ["127.1.2.3", true, true, true, false, false, true],
  ["127.255.255.255", true, true, true, false, false, true],
  // Unspecified binds everywhere but is not a server address
  ["0.0.0.0", false, false, false, false, false, true],
  // RFC 1918
  ["10.0.0.1", false, false, true, false, false, true],
  ["172.16.0.1", false, false, true, false, false, true],
  ["172.31.255.255", false, false, true, false, false, true],
  ["172.15.0.1", false, false, false, false, false, false],
  ["172.32.0.1", false, false, false, false, false, false],
  ["192.168.1.10", false, false, true, false, false, true],
  ["192.169.0.1", false, false, false, false, false, false],
  // CGNAT / Tailscale
  ["100.64.0.1", false, false, true, false, false, true],
  ["100.127.255.254", false, false, true, false, false, true],
  ["100.63.255.255", false, false, false, false, false, false],
  ["100.128.0.1", false, false, false, false, false, false],
  ["100.100.100.200", false, false, false, false, true, true],
  // Link-local and metadata
  ["169.254.1.1", false, false, false, false, false, true],
  ["169.254.169.254", false, false, false, false, true, true],
  ["169.254.170.2", false, false, false, false, true, true],
  // Public
  ["8.8.8.8", false, false, false, false, false, false],
  ["203.0.113.10", false, false, false, false, false, false],
  // IPv6, bracketed as in URL.hostname and bare
  ["[::1]", true, true, true, false, false, true],
  ["::1", true, true, true, false, false, true],
  ["[::]", false, false, false, false, false, true],
  ["[0:0:0:0:0:0:0:1]", true, true, true, false, false, true],
  ["[fc00::1]", false, false, true, false, false, true],
  ["[fd12:3456::1]", false, false, true, false, false, true],
  ["[FD12:3456::1]", false, false, true, false, false, true],
  ["[fd7a:115c:a1e0::1]", false, false, true, false, false, true],
  ["[fd00:ec2::254]", false, false, false, false, true, true],
  ["[fe80::1]", false, false, false, false, false, true],
  ["fe80::1%en0", false, false, false, false, false, true],
  ["[febf::1]", false, false, false, false, false, true],
  ["[ff02::1]", false, false, false, false, false, true],
  ["[2606:4700:4700::1111]", false, false, false, false, false, false],
  // IPv4-mapped IPv6, dotted and as URL normalizes it. The SSRF and metadata checks see
  // through it; the allow predicates do not accept a second spelling of an address.
  ["[::ffff:127.0.0.1]", false, false, false, false, false, true],
  ["[::ffff:7f00:1]", false, false, false, false, false, true],
  ["[::ffff:192.168.1.10]", false, false, false, false, false, true],
  ["[::ffff:c0a8:10a]", false, false, false, false, false, true],
  ["[::ffff:169.254.169.254]", false, false, false, false, true, true],
  ["[::ffff:a9fe:a9fe]", false, false, false, false, true, true],
  ["[::ffff:a9fe:101]", false, false, false, false, false, true],
  ["[::ffff:8.8.8.8]", false, false, false, false, false, false],
  // NAT64 and 6to4 carry IPv4 too, but are not this machine or this LAN
  ["[64:ff9b::7f00:1]", false, false, false, false, false, true],
  ["[64:ff9b::a9fe:a9fe]", false, false, false, false, true, true],
  ["[2002:c0a8:101::1]", false, false, false, false, false, true],
];

describe.each(HOSTS)(
  "host %s",
  (host, localhostOrLoopbackIp, loopback, privateNetwork, internal, metadata, nonPublic) => {
    it("classifies it", () => {
      expect({
        localhostOrLoopbackIp: isLocalhostOrLoopbackIp(host),
        loopback: isLoopbackHost(host),
        privateNetwork: isPrivateNetworkHost(host),
        internal: isInternalHostname(host),
        metadata: isCloudMetadataHost(host),
        nonPublic: ipVersion(host) === 0 ? null : isNonPublicAddress(host),
      }).toEqual({
        localhostOrLoopbackIp,
        loopback,
        privateNetwork,
        internal,
        metadata,
        nonPublic,
      });
    });
  },
);

describe("predicate relationships", () => {
  it.each(HOSTS.map(([host]) => host))("%s nests loopback inside private network", (host) => {
    if (isLocalhostOrLoopbackIp(host)) expect(isLoopbackHost(host)).toBe(true);
    if (isLoopbackHost(host)) expect(isPrivateNetworkHost(host)).toBe(true);
  });

  it.each(HOSTS.map(([host]) => host).filter((host) => ipVersion(host) !== 0))(
    "%s is non-public whenever it is a private-network or metadata address",
    (host) => {
      if (isPrivateNetworkAddress(host) || isCloudMetadataAddress(host)) {
        expect(isNonPublicAddress(host)).toBe(true);
      }
    },
  );

  it("fails closed for values that are not IP literals", () => {
    expect(isNonPublicAddress("example.test")).toBe(true);
    expect(isNonPublicAddress("")).toBe(true);
    expect(isNonPublicAddress("1.2.3.4.5")).toBe(true);
    expect(isPrivateNetworkAddress("example.test")).toBe(false);
    expect(isLoopbackAddress("localhost")).toBe(false);
  });

  it("normalizes case, brackets, and one trailing dot", () => {
    expect(normalizeHost("[FE80::1]")).toBe("fe80::1");
    expect(normalizeHost("Example.Test.")).toBe("example.test");
  });
});
