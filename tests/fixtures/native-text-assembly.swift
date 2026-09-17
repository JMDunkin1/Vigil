import Foundation

@main
struct NativeTextAssemblyRegression {
    static func main() {
        var buffer = BrowserTextInspectionBuffer()
        func receive(_ frame: String = "frame", _ revision: String = "1", _ index: Int = 0, _ total: Int = 2, _ text: String = "hello", _ truncated: Bool = false, _ now: TimeInterval = 0) -> BrowserTextInspectionBuffer.Result {
            buffer.receive(frameID: frame, revision: revision, index: index, total: total, text: text, wasTruncated: truncated, now: now)
        }
        precondition(receive("frame", "1", 1, 2, "world", true) == .pending)
        precondition(receive("frame", "1", 1, 2, "world", true) == .pending)
        precondition(buffer.pendingBytes == 5)
        precondition(receive("frame", "1", 0, 2, "hello ") == .complete(text: "hello world", wasTruncated: true))
        precondition(buffer.pendingBytes == 0)
        precondition(receive() == .ignored, "completed revisions must not restart")
        precondition(receive("frame", "3") == .pending)
        precondition(receive("frame", "2") == .ignored)
        precondition(buffer.pendingBytes == 5)
        precondition(receive("frame", "4", 0, 2, "new") == .pending)
        precondition(buffer.pendingBytes == 3, "a superseding revision must release old chunks")
        precondition(receive("frame", "4", 1, 2, " page") == .complete(text: "new page", wasTruncated: false))
        buffer.reset()
        precondition(buffer.pendingBytes == 0 && buffer.trackedFrameCount == 0)

        precondition(receive("frame", "1", 0, 2, "original") == .pending)
        precondition(receive("frame", "1", 0, 2, "x") == .pending)
        precondition(buffer.pendingBytes == 1)
        precondition(receive("frame", "1", 1, 3) == .rejected(retry: false))
        precondition(buffer.pendingBytes == 0)
        precondition(receive("frame", "1", 0, 1, "retry") == .complete(text: "retry", wasTruncated: false))
        precondition(receive("oversize", "1", 0, 1, String(repeating: "a", count: BrowserTextInspectionBuffer.maximumChunkBytes + 1)) == .rejected(retry: false))
        precondition(receive("bad", "0") == .rejected(retry: false))
        precondition(receive("bad", "1", -1) == .rejected(retry: false))
        precondition(receive("bad", "1", 0, 33) == .rejected(retry: false))
        buffer.reset()

        for index in 0..<BrowserTextInspectionBuffer.maximumFrames {
            precondition(receive("frame\(index)") == .pending)
        }
        precondition(receive("overflow") == .rejected(retry: true))
        precondition(buffer.trackedFrameCount == BrowserTextInspectionBuffer.maximumFrames)
        precondition(receive("frame0", "1", 1, 2, " late", false, 6) == .rejected(retry: true))
        precondition(buffer.pendingBytes == 0)
        precondition(receive("overflow", "2", 0, 1, "retry", false, 6) == .complete(text: "retry", wasTruncated: false))
        buffer.reset()
        for index in 0..<100 {
            precondition(receive("frame\(index)", "1", 0, 1) == .complete(text: "hello", wasTruncated: false))
        }
        precondition(buffer.trackedFrameCount == BrowserTextInspectionBuffer.maximumFrames)
        precondition(buffer.pendingBytes == 0)
        buffer.reset()

        // The real scanner uses JS UTF-16 lengths; CJK can consume three UTF-8
        // bytes per code unit. Full valid Unicode pages must still assemble.
        let unicodeChunk = String(repeating: "漢", count: 24_000)
        for index in 0..<22 {
            let result = receive("unicode", "1", index, 22, unicodeChunk)
            if index < 21 { precondition(result == .pending) }
            else { precondition(result == .complete(text: String(repeating: unicodeChunk, count: 22), wasTruncated: false)) }
        }
        precondition(buffer.pendingBytes == 0)
        buffer.reset()
        let maximumChunk = String(repeating: "a", count: BrowserTextInspectionBuffer.maximumChunkBytes)
        for frame in ["a", "b"] {
            for index in 0..<21 { precondition(receive(frame, "1", index, 32, maximumChunk) == .pending) }
        }
        precondition(receive("c", "1", 0, 2, maximumChunk) == .pending)
        precondition(receive("d", "1", 0, 2, maximumChunk) == .rejected(retry: true))
        precondition(buffer.pendingBytes <= BrowserTextInspectionBuffer.maximumPendingBytes)
        precondition(receive("a", "2", 0, 1, "superseding releases memory") == .complete(text: "superseding releases memory", wasTruncated: false))
        precondition(receive("d", "1", 0, 1, "valid retry") == .complete(text: "valid retry", wasTruncated: false))
        buffer.reset()
        for index in 0..<21 { precondition(receive("large", "1", index, 32, maximumChunk) == .pending) }
        precondition(receive("large", "1", 21, 32, maximumChunk) == .rejected(retry: false))
        precondition(buffer.pendingBytes == 0)
        print("Native text assembly regressions passed")
    }
}
