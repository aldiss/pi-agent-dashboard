import Foundation

public enum CredentialDecision: Equatable, Sendable {
    case attach(String)
    case omit(OmitReason)
}

public enum OmitReason: Equatable, Sendable {
    case none
    case foreignOrigin
    case insecureTransport
    case expired
}

public enum CredentialPolicy {
    public static func decide(
        target: CredentialOrigin,
        stored: (origin: CredentialOrigin, jwt: String)?,
        now: Date
    ) -> CredentialDecision {
        guard target.allowsCredential else { return .omit(.insecureTransport) }
        guard let stored else { return .omit(.none) }
        guard stored.origin == target else { return .omit(.foreignOrigin) }
        if let expiry = AuthToken.decodeExpiry(stored.jwt), expiry <= now {
            return .omit(.expired)
        }
        return .attach(stored.jwt)
    }
}
