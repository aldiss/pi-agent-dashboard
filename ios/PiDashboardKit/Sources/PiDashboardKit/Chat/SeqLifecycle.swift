import Foundation

/// Pure decision helpers for the event-replay / seq lifecycle (Cluster 1, the P0
/// data-integrity blocker). Keeping the RULES here — not tangled into the
/// `@MainActor` store — makes them `swift test`-able with no socket, and single-
/// sources the "did I already see this seq?" / "what lastSeq do I resume from?"
/// decisions the store applies.
///
/// The contract with the dashboard server:
///  - `subscribe(lastSeq: nil)` → the server sends a FULL replay (all history). The
///    client must RESET session state before reducing so history can't duplicate.
///  - `subscribe(lastSeq: N)`  → the server sends only events AFTER `N` (an
///    incremental resume). The client must NOT reset — it appends the gap.
///  - live `event{seq}` → apply only when `seq` is newer than the last applied
///    (dedup + out-of-order protection).
public enum SeqLifecycle {

    /// The `lastSeq` to subscribe with. `nil` last-seen (first open / after an evict)
    /// → `nil` = request a full replay. Otherwise resume from the last applied seq.
    public static func subscribeLastSeq(lastSeen: Int?) -> Int? { lastSeen }

    /// Whether a full replay (reset-before-reduce) is expected for this subscribe —
    /// true exactly when we asked for one (`lastSeq == nil`).
    public static func expectsFullReplay(lastSeq: Int?) -> Bool { lastSeq == nil }

    /// Whether a live event carrying `seq` should be applied: only if strictly newer
    /// than the last applied seq. `lastSeen == nil` (nothing applied yet) → apply.
    /// This is the dedup + out-of-order guard: a duplicate (`seq == lastSeen`) or a
    /// late/reordered frame (`seq < lastSeen`) is dropped.
    public static func shouldApply(seq: Int, lastSeen: Int?) -> Bool {
        guard let lastSeen else { return true }
        return seq > lastSeen
    }

    /// Filter an incremental replay through the same monotonic guard used for live
    /// events. Servers normally send only events after `lastSeq`, but reconnect races
    /// can overlap batches; applying that overlap duplicates transcript rows.
    public static func acceptNew(
        events: [SequencedEvent], lastSeen: Int?
    ) -> (events: [SequencedEvent], lastSeen: Int?) {
        var cursor = lastSeen
        var accepted: [SequencedEvent] = []
        for event in events where shouldApply(seq: event.seq, lastSeen: cursor) {
            accepted.append(event)
            cursor = advance(lastSeen: cursor, appliedSeq: event.seq)
        }
        return (accepted, cursor)
    }

    /// The new last-seen seq after considering `seq` — monotonic max, never rewinds.
    public static func advance(lastSeen: Int?, appliedSeq seq: Int) -> Int {
        max(lastSeen ?? Int.min, seq)
    }

    /// The last-seen seq to adopt from a replay batch: the max `seq` across the batch
    /// merged with the current value (nil batch → unchanged). Monotonic.
    public static func advance(lastSeen: Int?, batchMaxSeq: Int?) -> Int? {
        switch (lastSeen, batchMaxSeq) {
        case let (l?, b?): return max(l, b)
        case let (nil, b?): return b
        case let (l?, nil): return l
        case (nil, nil): return nil
        }
    }
}
