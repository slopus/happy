#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// The person's own profile on one paired computer, as Settings' Profile
/// row and the Profile page show it: read when asked and whenever the
/// computer says it changed, with this phone's unconfirmed changes over it
/// (`ProfileState`). One per `Session`, so a name saved on the page is the
/// row's name too when the page goes.
///
/// Reads, writes and decoding happen off the main thread; the main thread
/// only takes their results.
@MainActor
final class ProfileSource {
    private let client: AgentClient
    private let engine: SyncEngine
    private(set) var state = ProfileState()
    /// The picture to show: one picked here, the computer's, or its
    /// ThumbHash until the bytes come.
    private(set) var photo: UIImage?
    /// The ThumbHash `photo` stands for, read or being read; nil while
    /// nothing from the computer is shown.
    private var photoHash: String?
    private var photoJob: Task<Void, Never>?
    /// Pictures picked here, by the id their upload holds, until answered.
    private var picked: [String: UIImage] = [:]
    private var watchers: [UUID: () -> Void] = [:]
    private var following: Task<Void, Never>?
    private var reading: Task<Void, Never>?
    private var readAgain = false

    init(client: AgentClient, engine: SyncEngine) {
        self.client = client
        self.engine = engine
    }

    /// Calls `watch` now and whenever what shows changes. The computer's
    /// `profile.updated` is followed while anyone watches.
    func watch(_ watch: @escaping () -> Void) -> Watch {
        let id = UUID()
        watchers[id] = watch
        if following == nil { follow() }
        watch()
        return Watch { [weak self] in
            guard let self else { return }
            watchers.removeValue(forKey: id)
            if watchers.isEmpty { following?.cancel(); following = nil }
        }
    }

    private func follow() {
        let engine = engine
        following = Task { [weak self] in
            for await _ in await engine.profileUpdates() {
                guard !Task.isCancelled, let self else { return }
                refresh()
            }
        }
    }

    private func publish() {
        for watcher in watchers.values { watcher() }
    }

    /// Reads the profile again; asked again while a read is out, it reads
    /// once more when that one lands.
    func refresh() {
        guard reading == nil else { readAgain = true; return }
        let client = client
        reading = Task { [weak self] in
            let profile = try? await client.profile()
            guard let self else { return }
            reading = nil
            if let profile {
                let before = state
                state.heard(profile)
                if state != before { publish() }
                loadPhoto()
            }
            if readAgain {
                readAgain = false
                refresh()
            }
        }
    }

    // MARK: Name

    /// Shows `name` at once and saves it over the version last read; the
    /// hold goes when the computer answers. A failure shows the computer's
    /// name again and is thrown from the task, for the page to say so.
    @discardableResult
    func rename(_ name: String) -> Task<Void, Error> {
        state.holdName(name)
        publish()
        let client = client
        let version = state.profile?.version
        return Task {
            do {
                let current: String
                if let version { current = version } else { current = try await client.profile().version }
                let saved = try await client.renameProfile(name, version: current)
                state.nameSaved(name, saved)
                publish()
            } catch {
                state.nameFailed(name)
                publish()
                throw error
            }
        }
    }

    // MARK: Photo

    /// `image` as it is sent: square and small (`prepare`), shown at once.
    @discardableResult
    func setPhoto(_ image: UIImage) -> Task<Void, Error> {
        let id = UUID().uuidString
        let hold = ProfileState.PendingPhoto.uploading(id)
        picked[id] = image
        state.holdPhoto(hold)
        showPhoto(image, hash: nil)
        publish()
        let client = client
        return Task {
            defer { picked[id] = nil }
            do {
                guard let data = await Task.detached(operation: { image.jpegData(compressionQuality: 0.85) }).value else { throw AgentClientError.invalidResponse }
                let saved = try await client.setProfilePhoto(data, contentType: "image/jpeg")
                // The bytes are the ones just sent: shown as they are, never read back.
                if state.pendingPhoto == hold { showPhoto(image, hash: saved.photo?.thumbhash) }
                state.photoSaved(hold, saved)
                publish()
            } catch {
                state.photoFailed(hold)
                loadPhoto()
                publish()
                throw error
            }
        }
    }

    @discardableResult
    func removePhoto() -> Task<Void, Error> {
        let hold = ProfileState.PendingPhoto.removing
        state.holdPhoto(hold)
        showPhoto(nil, hash: nil)
        publish()
        let client = client
        return Task {
            do {
                let saved = try await client.removeProfilePhoto()
                state.photoSaved(hold, saved)
                loadPhoto()
                publish()
            } catch {
                state.photoFailed(hold)
                loadPhoto()
                publish()
                throw error
            }
        }
    }

    private func showPhoto(_ image: UIImage?, hash: String?) {
        photoJob?.cancel()
        photoJob = nil
        photo = image
        photoHash = hash
    }

    /// The computer's picture, when it is not the one shown: its blur at
    /// once where nothing shows yet, then its bytes.
    private func loadPhoto() {
        switch state.pendingPhoto {
        case .uploading(let id): return showPhoto(picked[id], hash: nil)
        case .removing: return showPhoto(nil, hash: nil)
        case nil: break
        }
        guard let hash = state.thumbhash else {
            if photo != nil || photoHash != nil { showPhoto(nil, hash: nil); publish() }
            return
        }
        guard hash != photoHash else { return }
        let showing = photo != nil
        photoJob?.cancel()
        photoHash = hash
        let client = client
        photoJob = Task { [weak self] in
            if !showing, let blur = await Task.detached(operation: { AccountPictureImages.placeholder(hash)?.picture as? UIImage }).value {
                guard let self, !Task.isCancelled, photoHash == hash else { return }
                photo = blur
                publish()
            }
            guard let read = try? await client.profilePhoto(), !Task.isCancelled else { return }
            let image = await Task.detached(operation: { AccountPictureImages.decode(read.data)?.picture as? UIImage }).value
            guard let self, !Task.isCancelled, photoHash == hash, let image else { return }
            photo = image
            publish()
        }
    }

    /// A picked picture as it is sent: its middle square, at most
    /// `ProfilePhotoCrop.maxSide` pixels, upright. Call it off the main thread.
    nonisolated static func prepare(_ image: UIImage) -> UIImage {
        let pixels = CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale)
        let crop = ProfilePhotoCrop(size: pixels)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: CGSize(width: crop.side, height: crop.side), format: format).image { _ in
            image.draw(in: crop.draw)
        }
    }
}
#endif
