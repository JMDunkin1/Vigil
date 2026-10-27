@preconcurrency import AVFoundation
import CoreImage
import Foundation
import UIKit
import WebKit

struct SnapchatCameraFrame: Sendable {
    let token: String
    let jpeg: Data
    let width: Int
    let height: Int
}

// All capture state lives on one queue. Every selection creates a new session
// after stopping its predecessor; callbacks from old outputs cannot affect it.
final class SnapchatCameraCapture: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    private let queue = DispatchQueue(label: "tech.caseline.vigil.snapchat-camera", qos: .userInitiated)
    private let context = CIContext(options: [.cacheIntermediates: false])
    private let colorSpace = CGColorSpaceCreateDeviceRGB()
    private var session: AVCaptureSession?
    private var output: AVCaptureVideoDataOutput?
    private var token: String?
    private var lastFrameTime: CFTimeInterval = 0
    private var frameInFlight = false
    private var previousCenterStageMode: AVCaptureDevice.CenterStageControlMode?
    private var previousCenterStageEnabled = false
    var onFrame: (@Sendable (SnapchatCameraFrame) -> Void)?

    func start(device: AVCaptureDevice, token: String, rotation: CGFloat) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async { [self] in
                stopOnQueue()
                do {
                    let next = AVCaptureSession()
                    next.automaticallyConfiguresApplicationAudioSession = false
                    next.beginConfiguration()
                    if next.canSetSessionPreset(.photo) { next.sessionPreset = .photo }
                    let input = try AVCaptureDeviceInput(device: device)
                    guard next.canAddInput(input) else { throw CameraError.unavailable }
                    next.addInput(input)
                    let frames = AVCaptureVideoDataOutput()
                    frames.alwaysDiscardsLateVideoFrames = true
                    frames.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
                    guard next.canAddOutput(frames) else { throw CameraError.unavailable }
                    next.addOutput(frames)
                    next.commitConfiguration()
                    previousCenterStageMode = AVCaptureDevice.centerStageControlMode
                    previousCenterStageEnabled = AVCaptureDevice.isCenterStageEnabled
                    AVCaptureDevice.centerStageControlMode = .app
                    AVCaptureDevice.isCenterStageEnabled = false
                    try device.lockForConfiguration()
                    // A physical camera at 1x keeps its full field of view.
                    // No automatic zoom/Center Stage reframing or virtual lens substitution.
                    device.videoZoomFactor = max(1, device.minAvailableVideoZoomFactor)
                    if #available(iOS 26.0, *),
                       device.activeFormat.supportedDynamicAspectRatios.contains(.ratio3x4) {
                        device.setDynamicAspectRatio(.ratio3x4, completionHandler: nil)
                    }
                    device.unlockForConfiguration()
                    guard let connection = frames.connection(with: .video),
                          connection.isVideoRotationAngleSupported(rotation) else { throw CameraError.orientation }
                    // RotationCoordinator accounts for the iPhone 17's changed
                    // front sensor orientation. Data-output buffers rotate physically.
                    connection.videoRotationAngle = rotation
                    if connection.isVideoMirroringSupported {
                        connection.automaticallyAdjustsVideoMirroring = false
                        connection.isVideoMirrored = false
                    }
                    connection.preferredVideoStabilizationMode = .off
                    self.token = token
                    output = frames
                    session = next
                    frames.setSampleBufferDelegate(self, queue: queue)
                    next.startRunning()
                    guard next.isRunning else { throw CameraError.unavailable }
                    continuation.resume()
                } catch {
                    stopOnQueue()
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    func stop(token: String? = nil) {
        queue.async { [self] in
            guard token == nil || self.token == token else { return }
            stopOnQueue()
        }
    }

    private func stopOnQueue() {
        output?.setSampleBufferDelegate(nil, queue: nil)
        if session?.isRunning == true { session?.stopRunning() }
        session = nil; output = nil; token = nil
        frameInFlight = false; lastFrameTime = 0
        if let mode = previousCenterStageMode {
            AVCaptureDevice.isCenterStageEnabled = previousCenterStageEnabled
            AVCaptureDevice.centerStageControlMode = mode
            previousCenterStageMode = nil
        }
    }

    func releaseFrame(token: String) {
        queue.async { [self] in
            if self.token == token { frameInFlight = false }
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        guard output === self.output, let token, !frameInFlight,
              CACurrentMediaTime() - lastFrameTime >= 1.0 / 20,
              let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let image = CIImage(cvPixelBuffer: buffer)
        // A dynamic-aspect-ratio update can settle over the first few buffers.
        // Wait for portrait pixels; never turn a square/landscape buffer into
        // a cropped portrait or publish it as an apparently ready camera.
        guard image.extent.height > image.extent.width else { return }
        let scale = min(1, 1440 / max(image.extent.width, image.extent.height))
        let scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        guard let jpeg = context.jpegRepresentation(of: scaled, colorSpace: colorSpace,
            options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.9]) else { return }
        lastFrameTime = CACurrentMediaTime(); frameInFlight = true
        onFrame?(SnapchatCameraFrame(token: token, jpeg: jpeg,
            width: Int(scaled.extent.width.rounded()), height: Int(scaled.extent.height.rounded())))
    }

    enum CameraError: Error { case unavailable, orientation }
}

struct SnapchatCameraSelection {
    private(set) var token: String?
    mutating func select(_ next: String) { token = next }
    mutating func stop(_ candidate: String? = nil) -> String? {
        guard candidate == nil || candidate == token else { return nil }
        let old = token; token = nil; return old
    }
    func accepts(_ candidate: String) -> Bool { token == candidate }
    static func index(requestedID: String?, facing: AVCaptureDevice.Position,
                      cameras: [(id: String, position: AVCaptureDevice.Position, ultraWide: Bool)]) -> Int? {
        if let requestedID { return cameras.firstIndex { $0.id == requestedID } }
        return cameras.firstIndex { $0.position == facing && $0.ultraWide }
            ?? cameras.firstIndex { $0.position == facing }
    }
}

@MainActor
final class SnapchatCameraBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let handlerName = "vigilSnapchatCamera"
    weak var webView: WKWebView?
    var isAllowed: ((String) -> Bool)?
    private let capture = SnapchatCameraCapture()
    private var selection = SnapchatCameraSelection()
    private var documentID: String?
    private var devices: [(id: String, device: AVCaptureDevice)] = []
    private var coordinator: AVCaptureDevice.RotationCoordinator?

    override init() {
        super.init()
        capture.onFrame = { [weak self] frame in
            Task { @MainActor [weak self] in await self?.deliver(frame) }
        }
    }

    deinit { capture.stop() }

    private func discover() {
        guard devices.isEmpty else { return }
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInUltraWideCamera, .builtInWideAngleCamera, .builtInTelephotoCamera],
            mediaType: .video, position: .unspecified)
        devices = discovery.devices.filter { !$0.isVirtualDevice }.map {
            ("vigil-native-" + UUID().uuidString, $0)
        }
    }

    private func descriptors() -> [[String: Any]] {
        discover()
        return devices.map { entry in
            let direction = entry.device.position == .front ? "Front" : "Back"
            let lens = entry.device.deviceType == .builtInUltraWideCamera ? "Ultra Wide"
                : entry.device.deviceType == .builtInTelephotoCamera ? "Telephoto" : "Wide"
            return ["deviceId": entry.id, "kind": "videoinput", "groupId": "",
                    "label": direction + " " + lens,
                    "facingMode": entry.device.position == .front ? "user" : "environment"]
        }
    }

    func userContentController(_ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any],
              let action = body["action"] as? String,
              let identity = body["documentID"] as? String,
              message.frameInfo.isMainFrame,
              SnapchatMediaPolicy.isTrustedCapture(originHost: message.frameInfo.securityOrigin.host,
                frameURL: message.frameInfo.request.url, topURL: message.webView?.url),
              message.frameInfo.securityOrigin.protocol == "https",
              message.frameInfo.securityOrigin.port == 0 || message.frameInfo.securityOrigin.port == 443 else {
            replyHandler(nil, "NotAllowedError"); return
        }
        if action == "stop", let token = body["token"] as? String {
            if documentID == identity, selection.accepts(token) { suspend() }
            replyHandler(["stopped": true], nil); return
        }
        guard isAllowed?(identity) == true else { replyHandler(nil, "NotAllowedError"); return }
        if action == "devices" { replyHandler(descriptors(), nil); return }
        guard action == "start", let token = body["token"] as? String, UUID(uuidString: token) != nil else {
            replyHandler(nil, "NotSupportedError"); return
        }
        discover()
        let requestedID = body["deviceId"] as? String
        let facing = body["facingMode"] as? String == "environment" ? AVCaptureDevice.Position.back : .front
        // Exact IDs must resolve exactly. A missing lens never falls back to a
        // different front/back camera while retaining the requested label.
        let index = SnapchatCameraSelection.index(requestedID: requestedID, facing: facing,
            cameras: devices.map { ($0.id, $0.device.position, $0.device.deviceType == .builtInUltraWideCamera) })
        guard let index else { replyHandler(nil, "OverconstrainedError"); return }
        let chosen = devices[index]
        selection.select(token); documentID = identity
        Task { [weak self] in
            guard let self else { replyHandler(nil, "AbortError"); return }
            let authorized = await SnapchatMediaPolicy.authorizeCapture(.camera,
                status: { AVCaptureDevice.authorizationStatus(for: $0) },
                request: { await AVCaptureDevice.requestAccess(for: $0) })
            guard authorized, self.isAllowed?(identity) == true else {
                if self.selection.accepts(token) { self.suspend() }
                replyHandler(nil, "NotAllowedError"); return
            }
            guard self.selection.accepts(token) else { replyHandler(nil, "AbortError"); return }
            let coordinator = AVCaptureDevice.RotationCoordinator(device: chosen.device, previewLayer: nil)
            self.coordinator = coordinator
            let angle: CGFloat
            if #available(iOS 27.0, *) {
                angle = coordinator.videoRotationAngleRelative(toDeviceOrientation: .portrait)
            } else {
                angle = coordinator.videoRotationAngleForHorizonLevelCapture
            }
            do {
                try await self.capture.start(device: chosen.device, token: token, rotation: angle)
                guard self.selection.accepts(token), self.isAllowed?(identity) == true else {
                    self.capture.stop(token: token); replyHandler(nil, "AbortError"); return
                }
                replyHandler(["deviceId": chosen.id,
                    "facingMode": chosen.device.position == .front ? "user" : "environment",
                    "frameRate": 20], nil)
            } catch {
                if self.selection.accepts(token) { self.suspend() }
                replyHandler(nil, "NotReadableError")
            }
        }
    }

    func suspend() {
        let old = selection.stop()
        capture.stop(); coordinator = nil
        if let old {
            webView?.callAsyncJavaScript("window.__vigilSnapchatNativeEnd?.(token);",
                arguments: ["token": old], in: nil, in: .page, completionHandler: nil)
        }
    }

    private func deliver(_ frame: SnapchatCameraFrame) async {
        defer { capture.releaseFrame(token: frame.token) }
        guard selection.accepts(frame.token), let identity = documentID, isAllowed?(identity) == true,
              let webView else { if selection.accepts(frame.token) { suspend() }; return }
        _ = try? await webView.callAsyncJavaScript(
            "return await window.__vigilSnapchatNativeFrame?.(token, jpeg);",
            arguments: ["token": frame.token, "jpeg": frame.jpeg.base64EncodedString()],
            in: nil, contentWorld: .page)
    }
}
