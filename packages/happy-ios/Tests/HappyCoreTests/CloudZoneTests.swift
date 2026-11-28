import Foundation
import XCTest
@testable import HappyCore

/// Settings › Zones' zones as `GET /v0/zones` lists them (happy-cluster
/// docs/zones.md, Zones v2): open or restricted to people and teams, with
/// their internet and compute; a server from before Zones v2 still reads.
final class CloudZoneTests: XCTestCase {
    private func zones(_ json: String) throws -> [CloudZone] {
        try JSONDecoder().decode([String: [Lossy<CloudZone>]].self, from: Data(json.utf8))["zones"]!.compactMap(\.value)
    }

    func testZonesV2AreReadAsTheClusterWritesThem() throws {
        let read = try zones(#"""
        {"zones":[
          {"id":"z1","name":"Finance","description":"Books stay here.","restricted":true,"color":"red","image":null,
           "members":[{"kind":"user","id":"ada"},{"kind":"team","id":"owners"},{"kind":"robot","id":"r2"},"bo"],
           "bots":["b1"],"owner":"ada","settings":{"internet":"off","compute":"listed"},"agentCount":3,"version":"v","createdAt":0,"updatedAt":0},
          {"id":"z2","name":"Lab","description":"","restricted":false,"color":"teal","members":null,"bots":[],"settings":{"internet":"on","compute":"any"}},
          {"id":"z3","name":"Vault","restricted":true,"members":[],"settings":{"internet":"on","compute":"none"}},
          {"name":"No ID"}]}
        """#)
        XCTAssertEqual(read, [
            CloudZone(id: "z1", name: "Finance", description: "Books stay here.", color: "red", restricted: true,
                      members: [ZonePrincipal(kind: .user, id: "ada"), ZonePrincipal(kind: .team, id: "owners"), ZonePrincipal(kind: .user, id: "bo")],
                      internet: .off, compute: .listed),
            CloudZone(id: "z2", name: "Lab", color: "teal", internet: .on, compute: .any),
            CloudZone(id: "z3", name: "Vault", restricted: true, internet: .on, compute: CloudZone.Compute.none),
        ], "a principal of a kind it doesn't know, and a zone it can't read, are left out; a bare ID is a person")
    }

    /// Before Zones v2: `critical` for restricted, any members list
    /// restricting the zone to its bare user IDs, a default zone, and no
    /// settings.
    func testAZoneFromBeforeZonesV2StillReads() throws {
        let read = try zones(#"""
        {"zones":[
          {"id":"d","name":"Default","description":"","color":"gray","critical":false,"isDefault":true,"members":null},
          {"id":"c","name":"Critical","description":"","color":"red","critical":true,"isDefault":false,"members":["ada"]},
          {"id":"l","name":"Listed","color":"blue","critical":false,"isDefault":false,"members":["bo"]}]}
        """#)
        XCTAssertEqual(read, [
            CloudZone(id: "d", name: "Default"),
            CloudZone(id: "c", name: "Critical", color: "red", restricted: true, members: [ZonePrincipal(kind: .user, id: "ada")]),
            CloudZone(id: "l", name: "Listed", color: "blue", restricted: true, members: [ZonePrincipal(kind: .user, id: "bo")]),
        ])
    }

    func testSettingsItDoesntKnowAreLeftOut() throws {
        let read = try zones(#"{"zones":[{"id":"z","name":"Z","restricted":false,"settings":{"internet":"sometimes","compute":7}}]}"#)
        XCTAssertNil(read.first?.internet)
        XCTAssertNil(read.first?.compute)
    }
}
