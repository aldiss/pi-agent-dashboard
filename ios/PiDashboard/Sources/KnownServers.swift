import Foundation

/// A persisted known dashboard server (mirrors the PWA's `KnownServer`). MVP
/// persistence is UserDefaults (brief §2.1) — host shown, full URL reconnected.
struct KnownServer: Codable, Identifiable, Equatable {
    var url: String
    var token: String?
    var id: String { url }
    /// host[:port] label for the row id / display.
    var host: String {
        guard let u = URL(string: url), let h = u.host else { return url }
        if let port = u.port { return "\(h):\(port)" }
        return h
    }
}

/// UserDefaults-backed known-server list. Most-recent-first; dedup by URL.
enum KnownServersStore {
    private static let key = "pi.dashboard.knownServers"

    static func load() -> [KnownServer] {
        guard let data = UserDefaults.standard.data(forKey: key),
              let list = try? JSONDecoder().decode([KnownServer].self, from: data) else { return [] }
        return list
    }

    static func remember(_ server: KnownServer) {
        var list = load().filter { $0.url != server.url }
        list.insert(server, at: 0)
        if let data = try? JSONEncoder().encode(Array(list.prefix(10))) {
            UserDefaults.standard.set(data, forKey: key)
        }
    }

    static func remove(_ url: String) {
        let list = load().filter { $0.url != url }
        if let data = try? JSONEncoder().encode(list) {
            UserDefaults.standard.set(data, forKey: key)
        }
    }
}
