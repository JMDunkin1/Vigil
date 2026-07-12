import CryptoKit
import Foundation

public struct PhoneBlocklistSource: Codable, Sendable, Equatable {
    public let id: String
    public let label: String
    public let url: String
    public let homepage: String
    public let license: String
}

public struct PhoneBlocklistMetadata: Codable, Sendable, Equatable {
    public let formatVersion: Int
    public let encoding: String
    public let blockSize: Int
    public let domainCount: Int
    public let snapshotHash: String
    public let payloadSha256: String
    public let payloadBytes: Int
    public let generatedAt: String
    public let source: PhoneBlocklistSource
}

public enum PhoneBlocklistError: LocalizedError {
    case invalidSignature
    case invalidMetadata
    case unsupportedFormat
    case invalidPayload
    case integrityFailure
    case sizeLimitExceeded

    public var errorDescription: String? {
        switch self {
        case .invalidSignature: "The phone blocklist signature is invalid."
        case .invalidMetadata: "The phone blocklist metadata is invalid."
        case .unsupportedFormat: "The phone blocklist format is unsupported."
        case .invalidPayload: "The phone blocklist payload is invalid."
        case .integrityFailure: "The phone blocklist integrity check failed."
        case .sizeLimitExceeded: "The phone blocklist exceeds the safe size limit."
        }
    }
}

/// Exact domain/suffix lookup over Vigil's compressed `.sdi` artifact.
///
/// Loading validates the format and SHA-256 payload digest. The sparse block
/// index avoids expanding the full list into a Set, while each lookup decodes
/// at most 64 short front-coded rows.
public final class PhoneBlocklistIndex: @unchecked Sendable {
    private static let magic = Data("SNTLIDX1".utf8)
    private static let headerBytes = 12
    private static let supportedBlockSize = 64
    private static let maximumArtifactBytes = 32 * 1024 * 1024

    private struct Block: Sendable {
        let payloadOffset: Int
        let firstDomain: String
        let entryCount: Int
    }

    public let metadata: PhoneBlocklistMetadata
    private let payload: Data
    private let blocks: [Block]

    public static func loadBundled(
        resource: String = "adult-blocklist",
        extension fileExtension: String = "sdi",
        bundle: Bundle = .main
    ) throws -> PhoneBlocklistIndex? {
        guard let url = bundle.url(forResource: resource, withExtension: fileExtension) else { return nil }
        return try PhoneBlocklistIndex(contentsOf: url)
    }

    public convenience init(contentsOf url: URL) throws {
        let data = try Data(contentsOf: url, options: [.mappedIfSafe])
        try self.init(data: data)
    }

    public init(data: Data) throws {
        guard data.count <= Self.maximumArtifactBytes else { throw PhoneBlocklistError.sizeLimitExceeded }
        guard data.count >= Self.headerBytes, data.prefix(Self.magic.count) == Self.magic else {
            throw PhoneBlocklistError.invalidSignature
        }
        let metadataLength = Int(Self.readUInt32LE(data, offset: Self.magic.count))
        let payloadOffset = Self.headerBytes + metadataLength
        guard metadataLength > 0, payloadOffset <= data.count else { throw PhoneBlocklistError.invalidMetadata }

        let decoder = JSONDecoder()
        guard let decodedMetadata = try? decoder.decode(
            PhoneBlocklistMetadata.self,
            from: data.subdata(in: Self.headerBytes..<payloadOffset)
        ) else { throw PhoneBlocklistError.invalidMetadata }
        guard decodedMetadata.formatVersion == 1,
              decodedMetadata.encoding == "blocked-reversed-domain-front-coding-v1",
              decodedMetadata.blockSize == Self.supportedBlockSize,
              decodedMetadata.domainCount > 0,
              decodedMetadata.domainCount <= 1_000_000,
              decodedMetadata.payloadBytes == data.count - payloadOffset,
              decodedMetadata.source.id.isEmpty == false,
              decodedMetadata.source.label.isEmpty == false,
              decodedMetadata.source.license.isEmpty == false
        else { throw PhoneBlocklistError.unsupportedFormat }

        let decodedPayload = data.subdata(in: payloadOffset..<data.count)
        let digest = SHA256.hash(data: decodedPayload).map { String(format: "%02x", $0) }.joined()
        guard digest == decodedMetadata.payloadSha256.lowercased() else {
            throw PhoneBlocklistError.integrityFailure
        }
        let decodedBlocks = try Self.makeSparseIndex(
            payload: decodedPayload,
            domainCount: decodedMetadata.domainCount,
            blockSize: decodedMetadata.blockSize
        )
        metadata = decodedMetadata
        payload = decodedPayload
        blocks = decodedBlocks
    }

    /// Returns the exact listed parent domain, or nil when the host is allowed.
    public func matchingDomain(for host: String) -> String? {
        guard let hostname = Self.normalizedHostname(host) else { return nil }
        let labels = hostname.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.count >= 2 else { return nil }
        for offset in 0..<(labels.count - 1) {
            let candidate = labels[offset...].joined(separator: ".")
            let reversed = labels[offset...].reversed().joined(separator: ".")
            if containsReversedDomain(reversed) { return candidate }
        }
        return nil
    }

    private func containsReversedDomain(_ target: String) -> Bool {
        var low = 0
        var high = blocks.count - 1
        var selected = -1
        while low <= high {
            let middle = low + (high - low) / 2
            if blocks[middle].firstDomain <= target {
                selected = middle
                low = middle + 1
            } else {
                high = middle - 1
            }
        }
        guard selected >= 0 else { return false }
        let block = blocks[selected]
        var cursor = block.payloadOffset
        var previous = ""
        for _ in 0..<block.entryCount {
            guard let row = Self.decodeRow(payload, cursor: &cursor, previous: previous) else { return false }
            if row == target { return true }
            if row > target { return false }
            previous = row
        }
        return false
    }

    private static func makeSparseIndex(payload: Data, domainCount: Int, blockSize: Int) throws -> [Block] {
        var output: [Block] = []
        output.reserveCapacity((domainCount + blockSize - 1) / blockSize)
        var cursor = 0
        var previous = ""
        var firstDomain = ""
        var blockOffset = 0
        for entry in 0..<domainCount {
            if entry % blockSize == 0 {
                blockOffset = cursor
                previous = ""
            }
            guard let row = decodeRow(payload, cursor: &cursor, previous: previous),
                  previous.isEmpty || previous < row
            else { throw PhoneBlocklistError.invalidPayload }
            if entry % blockSize == 0 {
                firstDomain = row
                let remaining = domainCount - entry
                output.append(Block(payloadOffset: blockOffset, firstDomain: firstDomain, entryCount: min(blockSize, remaining)))
            }
            previous = row
        }
        guard cursor == payload.count, output.isEmpty == false else { throw PhoneBlocklistError.invalidPayload }
        return output
    }

    private static func decodeRow(_ payload: Data, cursor: inout Int, previous: String) -> String? {
        guard cursor + 2 <= payload.count else { return nil }
        let prefixLength = Int(payload[cursor])
        let suffixLength = Int(payload[cursor + 1])
        cursor += 2
        guard prefixLength <= previous.utf8.count, cursor + suffixLength <= payload.count else { return nil }
        let prefix = previous.utf8.prefix(prefixLength)
        let suffix = payload[cursor..<(cursor + suffixLength)]
        cursor += suffixLength
        return String(decoding: prefix, as: UTF8.self) + String(decoding: suffix, as: UTF8.self)
    }

    private static func normalizedHostname(_ value: String) -> String? {
        let hostname = value.trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .trimmingCharacters(in: CharacterSet(charactersIn: "."))
        guard hostname.count <= 253, hostname.contains("."), hostname.utf8.allSatisfy({ byte in
            (byte >= 97 && byte <= 122) || (byte >= 48 && byte <= 57) || byte == 45 || byte == 46
        }) else { return nil }
        let labels = hostname.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.allSatisfy({ !$0.isEmpty && $0.count <= 63 && !$0.hasPrefix("-") && !$0.hasSuffix("-") }) else {
            return nil
        }
        return hostname
    }

    private static func readUInt32LE(_ data: Data, offset: Int) -> UInt32 {
        UInt32(data[offset])
            | UInt32(data[offset + 1]) << 8
            | UInt32(data[offset + 2]) << 16
            | UInt32(data[offset + 3]) << 24
    }
}
