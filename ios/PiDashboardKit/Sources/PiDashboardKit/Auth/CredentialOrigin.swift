import Foundation

public struct CredentialOrigin: Hashable, Sendable {
    public let scheme: String
    public let host: String
    public let port: Int

    public init?(url: URL) {
        guard let rawScheme = url.scheme?.lowercased(),
              rawScheme == "http" || rawScheme == "https",
              var rawHost = url.host?.lowercased(),
              !rawHost.isEmpty else { return nil }

        while rawHost.hasSuffix(".") { rawHost.removeLast() }
        guard !rawHost.isEmpty else { return nil }

        scheme = rawScheme
        host = rawHost
        port = url.port ?? (rawScheme == "https" ? 443 : 80)
    }

    public var isLoopback: Bool {
        if host == "localhost" || host == "::1" { return true }
        let octets = host.split(separator: ".", omittingEmptySubsequences: false)
        guard octets.count == 4,
              octets.allSatisfy({ UInt8($0) != nil }) else { return false }
        return octets[0] == "127"
    }

    public var storageKey: String {
        let renderedHost = host.contains(":") ? "[\(host)]" : host
        return "\(scheme)://\(renderedHost):\(port)"
    }

    public var allowsCredential: Bool {
        scheme == "https" || isLoopback
    }
}
