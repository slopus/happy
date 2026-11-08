import Foundation

/// Decimal fractional order keys, compared as plain strings: happy-agent's
/// `orderKeyBetween` (`packages/happy-agent-modules/sources/utils/orderKeyBetween.ts`),
/// the one its tasks, subtasks, projects, workspaces, connections and
/// Surfaces are ordered by. A key is digits that never end in 0; trailing
/// zeros don't change a key's value, so nothing lies between `1` and `10`.
/// Android's `OrderKey` is the same port.
public enum OrderKey {
    /// A key between `before` and `after`, either nil for that end; nil when
    /// they are out of order. Between two keys it is the shortest key near
    /// their middle. At an open end it steps one unit past the neighbour,
    /// so placing first or last again and again grows keys with the
    /// logarithm of the count, not by a digit every few placements.
    public static func between(_ before: String?, _ after: String?) -> String? {
        guard let after else { return before.map(justAfter) ?? "5" }
        guard let before else { return justBefore(nil, after) }
        guard trimmed(before) < trimmed(after) else { return nil }
        return midpoint(before, after)
    }

    /// The shortest key near the middle of `before` and `after`, or of
    /// `before` and the end of the list.
    static func midpoint(_ before: String, _ after: String?) -> String {
        let lower = digits(before)
        let upper = after.map(digits)
        var prefix = ""
        var index = 0
        while true {
            let low = index < lower.count ? lower[index] : 0
            let high = upper.map { index < $0.count ? $0[index] : 10 } ?? 10
            if high - low > 1 { return prefix + String(low + (high - low) / 2) }
            if high - low == 1 { return prefix + String(low) + above(Array(lower.dropFirst(index + 1))) }
            prefix += String(low)
            index += 1
        }
    }

    /// A key between `before` and `after`, as close below `after` as it
    /// can be, so the room left above `before` stays large. Steps are taken
    /// at the narrowest power-of-two width that fits; nil when nothing lies
    /// between them.
    public static func justBefore(_ before: String?, _ after: String) -> String? {
        let floor = trimmed(before ?? "")
        let ceiling = trimmed(after)
        guard floor < ceiling else { return nil }
        var width = 1
        while true {
            let truncated = padded(ceiling, width)
            // Shorter than the width, the key is its first digits less one unit.
            if let value = ceiling.count > width ? truncated : decremented(truncated), value.contains(where: { $0 != "0" }) {
                let key = trimmed(value)
                if key > floor { return key }
            }
            width *= 2
        }
    }

    /// A key after `before`, one step past it at the narrowest power-of-two
    /// width that fits.
    static func justAfter(_ before: String) -> String {
        let floor = trimmed(before)
        var width = 1
        while true {
            if let value = incremented(padded(floor, width)) { return trimmed(value) }
            width *= 2
        }
    }

    /// The key's first `width` digits, padded with zeros when it is shorter.
    private static func padded(_ key: String, _ width: Int) -> String {
        let head = String(key.prefix(width))
        return head + String(repeating: "0", count: width - head.count)
    }

    /// `digits` plus one, as many digits; nil when it would take one more.
    private static func incremented(_ value: String) -> String? {
        var digits = digits(value)
        var index = digits.count - 1
        while index >= 0 {
            if digits[index] < 9 {
                digits[index] += 1
                return digits.map(String.init).joined()
            }
            digits[index] = 0
            index -= 1
        }
        return nil
    }

    /// `digits` less one, as many digits; nil below zero.
    private static func decremented(_ value: String) -> String? {
        var digits = digits(value)
        var index = digits.count - 1
        while index >= 0 {
            if digits[index] > 0 {
                digits[index] -= 1
                return digits.map(String.init).joined()
            }
            digits[index] = 9
            index -= 1
        }
        return nil
    }

    private static func trimmed(_ key: String) -> String {
        var key = key
        while key.hasSuffix("0") { key.removeLast() }
        return key
    }

    private static func above(_ rest: [Int]) -> String {
        var prefix = ""
        var index = 0
        while true {
            let digit = index < rest.count ? rest[index] : 0
            if digit < 9 { return prefix + String(digit + (10 - digit) / 2) }
            prefix += "9"
            index += 1
        }
    }

    private static func digits(_ key: String) -> [Int] {
        key.unicodeScalars.map { Int($0.value) - 48 }
    }
}
