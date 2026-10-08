import Foundation

/// Format-preserving scanner for the subset of TOML that Habitab edits.
///
/// It does not build a document model. It records every key/value pair with
/// its full key path and the exact byte range of the value, so an edit can
/// replace one value and leave all other bytes of the file unchanged.
public struct TOMLScanner {
    public enum Value: Equatable {
        case string(String)
        case array([Value])
        case inlineTable
        case other(String)

        public var string: String? { if case .string(let s) = self { return s }; return nil }
        public var stringArray: [String]? {
            guard case .array(let items) = self else { return nil }
            let strings = items.compactMap(\.string)
            return strings.count == items.count ? strings : nil
        }
    }

    public struct Pair: Equatable {
        /// Table header path + dotted key, for example ["mcp_servers", "x", "args"].
        public var path: [String]
        /// Path of the `[table]` header the pair is under.
        public var table: [String]
        /// Number of key components written on the line itself.
        public var keyCount: Int
        public var value: Value
        public var valueRange: Range<Int>
        /// Range of the whole line including the newline.
        public var lineRange: Range<Int>
    }

    public struct Header: Equatable {
        public var path: [String]
        public var isArray: Bool
        public var lineRange: Range<Int>
    }

    public enum ScanError: Error, CustomStringConvertible {
        case syntax(String, Int)
        public var description: String {
            if case .syntax(let msg, let line) = self { return "TOML error on line \(line): \(msg)" }
            return "TOML error"
        }
    }

    public let bytes: [UInt8]
    public private(set) var pairs: [Pair] = []
    public private(set) var headers: [Header] = []
    private var i = 0

    public init(_ text: String) throws {
        bytes = Array(text.utf8)
        try scan()
    }

    private var line: Int { bytes[0..<min(i, bytes.count)].filter { $0 == 0x0A }.count + 1 }
    private func peek(_ offset: Int = 0) -> UInt8? { i + offset < bytes.count ? bytes[i + offset] : nil }

    private mutating func skipSpaces() {
        while let c = peek(), c == 0x20 || c == 0x09 { i += 1 }
    }

    private mutating func skipComment() {
        if peek() == UInt8(ascii: "#") { while let c = peek(), c != 0x0A { i += 1 } }
    }

    private mutating func skipLineEnd() throws {
        skipSpaces(); skipComment()
        if peek() == 0x0D { i += 1 }
        if let c = peek() {
            guard c == 0x0A else { throw ScanError.syntax("unexpected character", line) }
            i += 1
        }
    }

    /// Whitespace, newlines and comments inside arrays.
    private mutating func skipBlank() {
        while let c = peek() {
            if c == 0x20 || c == 0x09 || c == 0x0A || c == 0x0D { i += 1 }
            else if c == UInt8(ascii: "#") { skipComment() }
            else { break }
        }
    }

    private mutating func scan() throws {
        var table: [String] = []
        while i < bytes.count {
            let lineStart = i
            skipBlank()
            guard let c = peek() else { break }
            let start = i
            if c == UInt8(ascii: "[") {
                let isArray = peek(1) == UInt8(ascii: "[")
                i += isArray ? 2 : 1
                skipSpaces()
                let path = try keyPath(until: UInt8(ascii: "]"))
                i += isArray ? 2 : 1
                try skipLineEnd()
                table = path
                headers.append(Header(path: path, isArray: isArray, lineRange: start..<i))
                _ = lineStart
                continue
            }
            let key = try keyPath(until: UInt8(ascii: "="))
            i += 1
            skipSpaces()
            let valueStart = i
            let value = try parseValue()
            let valueEnd = i
            try skipLineEnd()
            pairs.append(Pair(path: table + key, table: table, keyCount: key.count, value: value,
                              valueRange: valueStart..<valueEnd, lineRange: start..<i))
        }
    }

    private mutating func keyPath(until terminator: UInt8) throws -> [String] {
        var parts: [String] = []
        while true {
            skipSpaces()
            guard let c = peek() else { throw ScanError.syntax("incomplete key", line) }
            if c == UInt8(ascii: "\"") || c == UInt8(ascii: "'") {
                guard case .string(let s) = try parseString() else { throw ScanError.syntax("key", line) }
                parts.append(s)
            } else {
                let start = i
                while let ch = peek(), isBareKey(ch) { i += 1 }
                guard i > start else { throw ScanError.syntax("invalid key", line) }
                parts.append(String(decoding: bytes[start..<i], as: UTF8.self))
            }
            skipSpaces()
            if peek() == UInt8(ascii: ".") { i += 1; continue }
            if peek() == terminator { return parts }
            throw ScanError.syntax("expected \(Character(UnicodeScalar(terminator)))", line)
        }
    }

    private func isBareKey(_ c: UInt8) -> Bool {
        (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || c == 0x2D || c == 0x5F
    }

    private mutating func parseValue() throws -> Value {
        guard let c = peek() else { throw ScanError.syntax("missing value", line) }
        switch c {
        case UInt8(ascii: "\""), UInt8(ascii: "'"):
            return try parseString()
        case UInt8(ascii: "["):
            i += 1
            var items: [Value] = []
            while true {
                skipBlank()
                if peek() == UInt8(ascii: "]") { i += 1; return .array(items) }
                items.append(try parseValue())
                skipBlank()
                if peek() == UInt8(ascii: ",") { i += 1; continue }
                skipBlank()
                if peek() == UInt8(ascii: "]") { i += 1; return .array(items) }
                throw ScanError.syntax("unclosed array", line)
            }
        case UInt8(ascii: "{"):
            var depth = 0
            while let ch = peek() {
                if ch == UInt8(ascii: "\"") || ch == UInt8(ascii: "'") { _ = try parseString(); continue }
                if ch == UInt8(ascii: "{") { depth += 1 }
                if ch == UInt8(ascii: "}") { depth -= 1; if depth == 0 { i += 1; return .inlineTable } }
                i += 1
            }
            throw ScanError.syntax("unclosed inline table", line)
        default:
            let start = i
            while let ch = peek(), ch != 0x0A, ch != UInt8(ascii: ","), ch != UInt8(ascii: "]"),
                  ch != UInt8(ascii: "}"), ch != UInt8(ascii: "#") { i += 1 }
            var end = i
            while end > start, bytes[end - 1] == 0x20 || bytes[end - 1] == 0x09 || bytes[end - 1] == 0x0D { end -= 1 }
            i = end
            return .other(String(decoding: bytes[start..<end], as: UTF8.self))
        }
    }

    private mutating func parseString() throws -> Value {
        let quote = bytes[i]
        let multi = peek(1) == quote && peek(2) == quote
        i += multi ? 3 : 1
        if multi, peek() == 0x0A { i += 1 } else if multi, peek() == 0x0D, peek(1) == 0x0A { i += 2 }
        var out: [UInt8] = []
        let literal = quote == UInt8(ascii: "'")
        while let c = peek() {
            if c == quote && (!multi || (peek(1) == quote && peek(2) == quote)) {
                if multi {
                    i += 3
                    // Up to two extra quotes belong to the content.
                    while peek() == quote { out.append(quote); i += 1 }
                } else { i += 1 }
                return .string(String(decoding: out, as: UTF8.self))
            }
            if c == 0x0A && !multi { throw ScanError.syntax("unclosed string", line) }
            if c == UInt8(ascii: "\\") && !literal {
                i += 1
                guard let e = peek() else { break }
                i += 1
                switch e {
                case UInt8(ascii: "n"): out.append(0x0A)
                case UInt8(ascii: "t"): out.append(0x09)
                case UInt8(ascii: "r"): out.append(0x0D)
                case UInt8(ascii: "b"): out.append(0x08)
                case UInt8(ascii: "f"): out.append(0x0C)
                case UInt8(ascii: "e"): out.append(0x1B)
                case UInt8(ascii: "\""): out.append(0x22)
                case UInt8(ascii: "\\"): out.append(0x5C)
                case UInt8(ascii: "u"), UInt8(ascii: "U"):
                    let len = e == UInt8(ascii: "u") ? 4 : 8
                    guard i + len <= bytes.count,
                          let code = UInt32(String(decoding: bytes[i..<(i + len)], as: UTF8.self), radix: 16),
                          let scalar = UnicodeScalar(code) else { throw ScanError.syntax("Escape", line) }
                    out.append(contentsOf: Array(String(Character(scalar)).utf8))
                    i += len
                case 0x0A where multi, 0x20 where multi, 0x09 where multi, 0x0D where multi:
                    // Line ending backslash: trim whitespace up to next content.
                    while let w = peek(), w == 0x20 || w == 0x09 || w == 0x0A || w == 0x0D { i += 1 }
                default: throw ScanError.syntax("unknown escape", line)
                }
                continue
            }
            out.append(c)
            i += 1
        }
        throw ScanError.syntax("unclosed string", line)
    }

    public func text(_ range: Range<Int>) -> String {
        String(decoding: bytes[range], as: UTF8.self)
    }

    // MARK: Formatting

    public static func quote(_ s: String) -> String {
        var out = "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\t": out += "\\t"
            case "\r": out += "\\r"
            default:
                if scalar.value < 0x20 || scalar.value == 0x7F {
                    out += String(format: "\\u%04X", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        return out + "\""
    }

    public static func array(_ items: [String]) -> String {
        "[" + items.map(quote).joined(separator: ", ") + "]"
    }

    /// Key as written in a header, quoted when it is not a bare key.
    public static func key(_ s: String) -> String {
        let bare = !s.isEmpty && s.utf8.allSatisfy { c in
            (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || c == 0x2D || c == 0x5F
        }
        return bare ? s : quote(s)
    }
}

public struct TextEdit: Equatable, Codable, Sendable {
    public var start: Int
    public var end: Int
    public var replacement: String

    public init(start: Int, end: Int, replacement: String) {
        self.start = start
        self.end = end
        self.replacement = replacement
    }

    /// Applies edits to UTF-8 bytes; edits must not overlap.
    public static func apply(_ edits: [TextEdit], to text: String) -> String {
        var bytes = Array(text.utf8)
        for edit in edits.sorted(by: { $0.start > $1.start }) {
            bytes.replaceSubrange(edit.start..<edit.end, with: Array(edit.replacement.utf8))
        }
        return String(decoding: bytes, as: UTF8.self)
    }
}
