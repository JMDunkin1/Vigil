import CryptoKit
import Foundation
import NetworkExtension

struct URLFilterPrefilterMetadata: Codable, Sendable, Equatable {
    let formatVersion: Int
    let encoding: String
    let tag: String
    let snapshotHash: String
    let exactIndexPayloadSha256: String
    let exactDomainCount: Int
    let pirDatabaseRevision: String
    let bitCount: Int
    let hashCount: Int
    let murmurSeed: UInt32
    let bitsetSha256: String
    let bitsetBytes: Int
    let generatedAt: String
}

enum URLFilterPrefilterError: LocalizedError {
    case missingArtifact
    case missingExactIndex
    case invalidSignature
    case invalidMetadata
    case unsupportedFormat
    case invalidBitset
    case integrityFailure
    case exactIndexMismatch
    case sizeLimitExceeded

    var errorDescription: String? {
        switch self {
        case .missingArtifact: "The URL Filter prefilter artifact is missing."
        case .missingExactIndex: "The exact phone blocklist artifact is missing."
        case .invalidSignature: "The URL Filter prefilter signature is invalid."
        case .invalidMetadata: "The URL Filter prefilter metadata is invalid."
        case .unsupportedFormat: "The URL Filter prefilter format is unsupported."
        case .invalidBitset: "The URL Filter prefilter bitset is invalid."
        case .integrityFailure: "The URL Filter prefilter integrity check failed."
        case .exactIndexMismatch: "The URL Filter prefilter does not match the exact phone blocklist."
        case .sizeLimitExceeded: "The URL Filter prefilter exceeds the safe size limit."
        }
    }
}

/// An Apple-compatible Bloom prefilter generated in the same transaction as
/// the PIR database and linked to Vigil's exact `.sdi` index.
struct URLFilterPrefilterArtifact: Sendable {
    private static let magic = Data("VIGILUF1".utf8)
    private static let headerBytes = 12
    private static let maximumMetadataBytes = 64 * 1024
    private static let maximumArtifactBytes = 32 * 1024 * 1024

    let metadata: URLFilterPrefilterMetadata
    let bitset: Data

    static func loadBundled(
        resource: String = "url-filter-prefilter",
        extension fileExtension: String = "vuf",
        bundle: Bundle = .main
    ) throws -> URLFilterPrefilterArtifact {
        guard let url = bundle.url(forResource: resource, withExtension: fileExtension) else {
            throw URLFilterPrefilterError.missingArtifact
        }
        let artifact = try URLFilterPrefilterArtifact(contentsOf: url)
        guard let exactIndex = try PhoneBlocklistIndex.loadBundled(bundle: bundle) else {
            throw URLFilterPrefilterError.missingExactIndex
        }
        try artifact.validate(exactIndex: exactIndex)
        return artifact
    }

    init(contentsOf url: URL) throws {
        try self.init(data: Data(contentsOf: url, options: [.mappedIfSafe]))
    }

    init(data: Data) throws {
        guard data.count <= Self.maximumArtifactBytes else {
            throw URLFilterPrefilterError.sizeLimitExceeded
        }
        guard data.count >= Self.headerBytes, data.prefix(Self.magic.count) == Self.magic else {
            throw URLFilterPrefilterError.invalidSignature
        }
        let metadataLength = Int(Self.readUInt32LE(data, offset: Self.magic.count))
        let bitsetOffset = Self.headerBytes + metadataLength
        guard metadataLength > 0,
              metadataLength <= Self.maximumMetadataBytes,
              bitsetOffset <= data.count
        else { throw URLFilterPrefilterError.invalidMetadata }

        guard let decodedMetadata = try? JSONDecoder().decode(
            URLFilterPrefilterMetadata.self,
            from: data.subdata(in: Self.headerBytes..<bitsetOffset)
        ) else { throw URLFilterPrefilterError.invalidMetadata }
        let decodedBitset = data.subdata(in: bitsetOffset..<data.count)
        guard decodedMetadata.formatVersion == 1,
              decodedMetadata.encoding == "apple-neurlfilter-prefilter-bloom-v1",
              Self.isIdentifier(decodedMetadata.tag),
              Self.isSHA256(decodedMetadata.snapshotHash),
              Self.isSHA256(decodedMetadata.exactIndexPayloadSha256),
              decodedMetadata.exactDomainCount > 0,
              Self.isIdentifier(decodedMetadata.pirDatabaseRevision),
              decodedMetadata.bitCount > 0,
              decodedMetadata.hashCount > 0,
              decodedMetadata.hashCount <= 32,
              decodedMetadata.bitsetBytes == decodedBitset.count,
              decodedMetadata.bitsetBytes == (decodedMetadata.bitCount + 7) / 8,
              Self.isSHA256(decodedMetadata.bitsetSha256),
              ISO8601DateFormatter().date(from: decodedMetadata.generatedAt) != nil
        else { throw URLFilterPrefilterError.unsupportedFormat }

        let digest = SHA256.hash(data: decodedBitset).map { String(format: "%02x", $0) }.joined()
        guard digest == decodedMetadata.bitsetSha256.lowercased() else {
            throw URLFilterPrefilterError.integrityFailure
        }
        guard Self.hasZeroPaddingBits(decodedBitset, bitCount: decodedMetadata.bitCount) else {
            throw URLFilterPrefilterError.invalidBitset
        }
        metadata = decodedMetadata
        bitset = decodedBitset
    }

    func validate(exactIndex: PhoneBlocklistIndex) throws {
        guard metadata.snapshotHash.lowercased() == exactIndex.metadata.snapshotHash.lowercased(),
              metadata.exactIndexPayloadSha256.lowercased() == exactIndex.metadata.payloadSha256.lowercased(),
              metadata.exactDomainCount == exactIndex.metadata.domainCount
        else { throw URLFilterPrefilterError.exactIndexMismatch }
    }

    @available(iOS 26.0, macOS 26.0, macCatalyst 26.0, *)
    func systemPrefilter(stagedAt url: URL) throws -> NEURLFilterPrefilter {
        try bitset.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        return NEURLFilterPrefilter(
            data: .temporaryFilepath(url),
            tag: metadata.tag,
            bitCount: metadata.bitCount,
            hashCount: metadata.hashCount,
            murmurSeed: metadata.murmurSeed
        )
    }

    private static func isIdentifier(_ value: String) -> Bool {
        guard !value.isEmpty, value.count <= 128 else { return false }
        return value.unicodeScalars.allSatisfy { scalar in
            CharacterSet.alphanumerics.contains(scalar) || "._:-".unicodeScalars.contains(scalar)
        }
    }

    private static func isSHA256(_ value: String) -> Bool {
        value.count == 64 && value.utf8.allSatisfy { byte in
            (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 70) || (byte >= 97 && byte <= 102)
        }
    }

    private static func hasZeroPaddingBits(_ bitset: Data, bitCount: Int) -> Bool {
        let usedBits = bitCount % 8
        guard usedBits != 0, let last = bitset.last else { return true }
        let unusedMask = UInt8(truncatingIfNeeded: 0xff << usedBits)
        return last & unusedMask == 0
    }

    private static func readUInt32LE(_ data: Data, offset: Int) -> UInt32 {
        UInt32(data[offset])
            | UInt32(data[offset + 1]) << 8
            | UInt32(data[offset + 2]) << 16
            | UInt32(data[offset + 3]) << 24
    }
}
