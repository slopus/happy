import Foundation
import HappyWire

extension AgentWire {
    /// The person this installation belongs to, as they named themselves
    /// (`GET /v0/profile`, happy-agent `protocol/profile.ts`). Display
    /// fields start out nil; `photo` is only its ThumbHash, the bytes come
    /// from `GET /v0/profile/photo`.
    public struct Profile: Codable, Equatable, Sendable {
        public struct Photo: Codable, Equatable, Sendable {
            public var thumbhash: String
            public init(thumbhash: String) { self.thumbhash = thumbhash }
        }

        public var email: String?
        public var name: String?
        public var photo: Photo?
        /// The team user, nil outside team mode; absent on older daemons.
        public var userId: String?
        public var updatedAt: Double
        /// A UUIDv7: a later version sorts after an earlier one as text.
        public var version: String

        public init(email: String? = nil, name: String? = nil, photo: Photo? = nil, userId: String? = nil, updatedAt: Double = 0, version: String) {
            self.email = email
            self.name = name
            self.photo = photo
            self.userId = userId
            self.updatedAt = updatedAt
            self.version = version
        }
    }
}

/// What the Profile page and its Settings row show: the newest profile
/// heard from the computer, with this phone's unconfirmed changes over it.
/// A change shows at once and stays until the computer answers it, so an
/// older read landing meanwhile never flickers the old name or picture back.
public struct ProfileState: Equatable, Sendable {
    /// A picture change sent and not yet answered.
    public enum PendingPhoto: Equatable, Sendable {
        /// A new picture, by the id the page keeps its bytes under.
        case uploading(String)
        case removing
    }

    public private(set) var profile: AgentWire.Profile?
    public private(set) var pendingName: String?
    public private(set) var pendingPhoto: PendingPhoto?

    public init() {}

    /// The name to show: the one being saved, else the computer's.
    public var name: String { pendingName ?? profile?.name ?? "" }

    /// Whether a picture shows: one being sent, or the computer's unless
    /// it is being removed.
    public var hasPhoto: Bool {
        switch pendingPhoto {
        case .uploading: true
        case .removing: false
        case nil: profile?.photo != nil
        }
    }

    /// The computer's picture, while nothing sent here stands over it.
    public var thumbhash: String? { pendingPhoto == nil ? profile?.photo?.thumbhash : nil }

    /// A read or an answer. Versions only move forward: a read that left
    /// before a save and lands after its answer is the older one, and is
    /// dropped.
    public mutating func heard(_ profile: AgentWire.Profile) {
        if let current = self.profile, profile.version < current.version { return }
        self.profile = profile
    }

    public mutating func holdName(_ name: String) { pendingName = name }

    /// `name`'s save answered: what the computer now says replaces the
    /// hold, unless a later name is already on its way.
    public mutating func nameSaved(_ name: String, _ profile: AgentWire.Profile) {
        heard(profile)
        if pendingName == name { pendingName = nil }
    }

    /// `name`'s save failed: the computer's name shows again.
    public mutating func nameFailed(_ name: String) {
        if pendingName == name { pendingName = nil }
    }

    public mutating func holdPhoto(_ photo: PendingPhoto) { pendingPhoto = photo }

    public mutating func photoSaved(_ photo: PendingPhoto, _ profile: AgentWire.Profile) {
        heard(profile)
        if pendingPhoto == photo { pendingPhoto = nil }
    }

    public mutating func photoFailed(_ photo: PendingPhoto) {
        if pendingPhoto == photo { pendingPhoto = nil }
    }
}

extension AgentClient {
    private struct ProfileResponse: Decodable { let profile: AgentWire.Profile }

    private func profile(from response: HTTP1Response) throws -> AgentWire.Profile {
        do { return try JSONDecoder().decode(ProfileResponse.self, from: response.body).profile }
        catch { throw AgentClientError.invalidResponse }
    }

    /// `GET /v0/profile`. Always answers; an untouched profile is all nil.
    public func profile() async throws -> AgentWire.Profile {
        try await decode(ProfileResponse.self, "GET", "/v0/profile").profile
    }

    /// `PATCH /v0/profile` with the name, naming `version` (`If-Match`).
    /// One that lost a race reads the newer version and saves over that,
    /// once, as a rename does.
    public func renameProfile(_ name: String, version: String) async throws -> AgentWire.Profile {
        let body: JSONValue = .object(["name": .string(name), "mutationId": .string(ClientID.make())])
        var version = version
        for attempt in 0..<2 {
            do {
                return try profile(from: await send("PATCH", "/v0/profile", json: body, headers: ["If-Match": version]))
            } catch AgentClientError.status(409, _, _) where attempt == 0 {
                version = try await profile().version
            }
        }
        throw AgentClientError.invalidResponse
    }

    /// `PUT /v0/profile/photo`: the image itself; the daemon works out its ThumbHash.
    public func setProfilePhoto(_ data: Data, contentType: String) async throws -> AgentWire.Profile {
        try profile(from: await send("PUT", "/v0/profile/photo", raw: data, headers: ["Content-Type": contentType]))
    }

    /// `DELETE /v0/profile/photo`.
    public func removeProfilePhoto() async throws -> AgentWire.Profile {
        try profile(from: await send("DELETE", "/v0/profile/photo"))
    }

    /// `GET /v0/profile/photo`: the bytes and their ETag, or nil when they
    /// are still `etag`'s (`304`).
    public func profilePhoto(etag: String? = nil) async throws -> (data: Data, etag: String?)? {
        let response = try await send("GET", "/v0/profile/photo", headers: etag.map { ["If-None-Match": $0] } ?? [:])
        if response.status == 304 { return nil }
        return (response.body, response.headers["etag"])
    }
}
