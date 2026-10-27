import AVFoundation
import Photos
import SwiftUI
import UIKit
import WebKit
import XCTest
@testable import VigilSocial

@MainActor
private final class CameraFixtureBridge: NSObject, WKScriptMessageHandlerWithReply {
    weak var view: WKWebView?
    var active: String?
    var requested: [String] = []
    private var frames: Task<Void, Never>?
    let cameras = [
        ["deviceId": "front-ultra", "facingMode": "user", "label": "Front Ultra Wide"],
        ["deviceId": "back-wide", "facingMode": "environment", "label": "Back Wide"],
        ["deviceId": "back-ultra", "facingMode": "environment", "label": "Back Ultra Wide"]
    ]

    func send(_ token: String, camera: String) async {
        guard let view else { return }
        let jpeg = UIGraphicsImageRenderer(size: CGSize(width: 300, height: 400), format: {
            let format = UIGraphicsImageRendererFormat(); format.scale = 1; return format
        }()).jpegData(withCompressionQuality: 1) { context in
            (camera == "front-ultra" ? UIColor.blue : camera == "back-wide" ? UIColor.green : UIColor.magenta).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 300, height: 400))
            UIColor.yellow.setFill(); context.fill(CGRect(x: 0, y: 0, width: 36, height: 400))
            UIColor.red.setFill(); context.fill(CGRect(x: 264, y: 0, width: 36, height: 400))
        }
        _ = try? await view.callAsyncJavaScript("return await window.__vigilSnapchatNativeFrame(token,jpeg);",
            arguments: ["token": token, "jpeg": jpeg.base64EncodedString()], in: nil, contentWorld: .page)
    }

    func userContentController(_ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        let body = message.body as! [String: Any]
        let token = body["token"] as? String ?? ""
        switch body["action"] as? String {
        case "devices": replyHandler(cameras, nil)
        case "stop":
            if active == token { frames?.cancel(); active = nil }
            replyHandler(["stopped": true], nil)
        case "start":
            let id = body["deviceId"] as? String ?? "front-ultra"
            guard let camera = cameras.first(where: { $0["deviceId"] == id }) else {
                replyHandler(nil, "OverconstrainedError"); return
            }
            frames?.cancel(); active = token; requested.append(id)
            replyHandler(["deviceId": id, "facingMode": camera["facingMode"]!, "frameRate": 20], nil)
            frames = Task { [weak self] in
                while !Task.isCancelled {
                    await self?.send(token, camera: id)
                    try? await Task.sleep(for: .milliseconds(50))
                }
            }
        default: replyHandler(nil, "NotSupportedError")
        }
    }
    func stop() { frames?.cancel(); frames = nil }
}

final class SnapchatCameraTests: XCTestCase {
    @MainActor
    func testNativeCameraRejectsUnconfirmedDocumentsWithoutOpeningCapture() async throws {
        let bridge = SnapchatCameraBridge()
        bridge.isAllowed = { _ in false }
        let controller = WKUserContentController()
        controller.addScriptMessageHandler(bridge, contentWorld: .page, name: SnapchatCameraBridge.handlerName)
        let configuration = WKWebViewConfiguration(); configuration.userContentController = controller
        let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 780), configuration: configuration)
        bridge.webView = view
        view.loadHTMLString("<p id=ready>Fixture</p>", baseURL: URL(string: "https://www.snapchat.com/web/"))
        try await wait("document.getElementById('ready') !== null", in: view)
        for action in ["devices", "start"] {
            let denied = try await view.callAsyncJavaScript("""
                try { await window.webkit.messageHandlers.vigilSnapchatCamera.postMessage({action,documentID:'stale',token:crypto.randomUUID()});return false; }
                catch(e) { return String(e).includes('NotAllowedError'); }
                """, arguments: ["action": action], in: nil, contentWorld: .page) as? Bool
            XCTAssertEqual(denied, true)
        }
        bridge.isAllowed = { $0 == "allowed-document" }
        let accepted = try await view.callAsyncJavaScript("""
            const cameras=await window.webkit.messageHandlers.vigilSnapchatCamera.postMessage({action:'devices',documentID:'allowed-document'});
            return Array.isArray(cameras);
            """, arguments: [:], in: nil, contentWorld: .page) as? Bool
        XCTAssertEqual(accepted, true, "The real bridge must accept the confirmed first-party document")
    }

    @MainActor
    func testPhysicalLensSelectionNeverFallsBackToFrontAndOldStopCannotCancelNewInput() {
        let cameras: [(String, AVCaptureDevice.Position, Bool)] = [
            ("front-wide", .front, false), ("front-ultra", .front, true),
            ("back-wide", .back, false), ("back-ultra", .back, true)
        ]
        XCTAssertEqual(SnapchatCameraSelection.index(requestedID: nil, facing: .front, cameras: cameras), 1)
        XCTAssertEqual(SnapchatCameraSelection.index(requestedID: nil, facing: .back, cameras: cameras), 3)
        XCTAssertEqual(SnapchatCameraSelection.index(requestedID: "back-wide", facing: .front, cameras: cameras), 2)
        XCTAssertNil(SnapchatCameraSelection.index(requestedID: "missing-camera", facing: .front, cameras: cameras))
        var selection = SnapchatCameraSelection()
        selection.select("old"); selection.select("new")
        XCTAssertNil(selection.stop("old"))
        XCTAssertTrue(selection.accepts("new"))
        XCTAssertEqual(selection.stop("new"), "new")
        XCTAssertFalse(selection.accepts("new"))
    }

    @MainActor
    func testNativeFramesKeepPortraitPixelsAcrossRepeatedFrontAndBackSwitches() async throws {
        let bridge = CameraFixtureBridge()
        let controller = WKUserContentController()
        controller.addScriptMessageHandler(bridge, contentWorld: .page, name: SnapchatCameraBridge.handlerName)
        controller.addUserScript(WKUserScript(source: """
            Object.defineProperty(navigator,'mediaDevices',{value:Object.assign(new EventTarget(),{
              enumerateDevices:async()=>[{kind:'videoinput',deviceId:'webkit-front'},{kind:'audioinput',deviceId:'mic'}],
              getUserMedia:async()=>{throw new Error('A native camera must never open WebKit capture')}
            })});
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        controller.addUserScript(WKUserScript(source: DOMAdapters.documentStartScript(for: .snapchat,
            unclassifiedMediaPolicy: .revealUnclassified, audioEnabled: true, contentSafetyEnabled: false),
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller; configuration.websiteDataStore = .nonPersistent()
        configuration.allowsInlineMediaPlayback = true; configuration.mediaTypesRequiringUserActionForPlayback = []
        let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 780), configuration: configuration)
        bridge.view = view
        let window = UIWindow(frame: view.bounds)
        window.windowScene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let host = UIViewController(); window.rootViewController = host; host.view.addSubview(view); window.makeKeyAndVisible()
        defer { bridge.stop(); window.isHidden = true }
        view.loadHTMLString("""
            <meta name=viewport content="width=device-width,initial-scale=1"><body style="margin:0;background:black">
            <video id=preview muted autoplay playsinline style="width:100%;height:100vh;object-fit:contain"></video>
            """, baseURL: URL(string: "https://www.snapchat.com/web/"))
        try await wait("window.__vigilSnapchatNativeCameraInstalled === true", in: view)
        let devices = try await view.callAsyncJavaScript(
            "return (await navigator.mediaDevices.enumerateDevices()).map(d=>d.deviceId);",
            arguments: [:], in: nil, contentWorld: .page) as? [String]
        XCTAssertEqual(devices, ["mic", "front-ultra", "back-wide", "back-ultra"])
        for id in ["front-ultra", "back-wide", "back-ultra", "front-ultra", "back-wide", "front-ultra"] {
            let old = bridge.active
            let result = try await view.callAsyncJavaScript("""
                const previous=window.fixtureStream;
                const stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{
                  deviceId:{exact:id},width:{ideal:406},height:{ideal:720},aspectRatio:{exact:9/16}}});
                window.fixtureStream=stream;
                const video=document.getElementById('preview'); video.srcObject=stream;await video.play();
                if(previous) previous.getTracks().forEach(t=>t.stop());
                const settings=stream.getVideoTracks()[0].getSettings();
                return [settings.deviceId===id,settings.width===300,settings.height===400,settings.aspectRatio===.75];
                """, arguments: ["id": id], in: nil, contentWorld: .page) as? [Bool]
            XCTAssertEqual(result, [true, true, true, true], id)
            try await wait("document.getElementById('preview').videoWidth===300 && document.getElementById('preview').videoHeight===400", in: view)
            if let old { await bridge.send(old, camera: "wrong-old-camera") }
            let pixels = try await view.evaluateJavaScript("""
                (()=>{const v=document.getElementById('preview'),c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;
                  const g=c.getContext('2d');g.drawImage(v,0,0);return [...g.getImageData(1,1,1,1).data,...g.getImageData(298,1,1,1).data,...g.getImageData(150,200,1,1).data];})()
                """) as? [Int]
            let actual = try XCTUnwrap(pixels)
            let center = id == "front-ultra" ? [0,0,255,255] : id == "back-wide" ? [0,255,0,255] : [255,0,255,255]
            for (value, expected) in zip(actual, [255,255,0,255,255,0,0,255] + center) {
                XCTAssertLessThanOrEqual(abs(value - expected), 5, "\(id): camera identity and complete sensor edges must survive preview/capture")
            }
            XCTAssertNotNil(bridge.active, "Stopping the previous stream cannot stop the new lens")
        }
        let source = try await view.callAsyncJavaScript("""
            const previous=navigator.mediaDevices.getUserMedia({video:{deviceId:{exact:'back-wide'}}}).then(()=>false,e=>e.name==='AbortError');
            const newest=navigator.mediaDevices.getUserMedia({video:{deviceId:{exact:'front-ultra'}}});
            const stream=await newest;window.fixtureStream=stream;
            return [await previous,stream.getVideoTracks()[0].getSettings().deviceId==='front-ultra'];
            """, arguments: [:], in: nil, contentWorld: .page) as? [Bool]
        XCTAssertEqual(source, [true, true])
        let unavailable = try await view.callAsyncJavaScript("""
            try { await navigator.mediaDevices.getUserMedia({video:{deviceId:{exact:'missing'}}}); return false; }
            catch(e) { return e.name==='OverconstrainedError'; }
            """, arguments: [:], in: nil, contentWorld: .page) as? Bool
        XCTAssertEqual(unavailable, true)
    }

    @MainActor
    func testNativeSaveBarIsVisibleAndSavesThroughTheRealBridge() async throws {
        guard PHPhotoLibrary.authorizationStatus(for: .addOnly) == .authorized else {
            throw XCTSkip("Grant photos-add to the simulator fixture app")
        }
        let store = SocialWebViewStore(fixedService: .snapchat, loadInitialPages: false,
            mediaClassifier: SafeCameraFixtureClassifier(), unclassifiedMediaPolicy: .conceal,
            websiteDataStore: .nonPersistent())
        let view = store.webView(for: .snapchat)
        let host = UIHostingController(rootView: RootView(store: store).environment(\.scenePhase, .active))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.windowScene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        window.rootViewController = host; window.makeKeyAndVisible()
        defer { window.isHidden = true }
        view.loadHTMLString(VigilSocialTests.snapchatMobileShellFixture, baseURL: SocialService.snapchat.homeURL)
        try await wait("document.documentElement.dataset.vigilPageVerdict==='safe'", in: view)
        _ = try await view.callAsyncJavaScript("globalThis.fetch=async url=>({status:200,url});return true;",
            arguments: [:], in: nil, contentWorld: .defaultClient)
        let allowed = await store.confirmServiceAccess(); XCTAssertTrue(allowed)
        await store.handleSceneActivity(true, isServiceVisible: true)
        store.resumeSuspendedMedia()
        await store.saveOpenedSnapchatPhoto()
        XCTAssertEqual(store.snapchatPhotoSaveMessage, "Open a photo first")
        _ = try await view.evaluateJavaScript("""
            fixtureOpenSnap();const c=document.createElement('canvas');c.width=90;c.height=120;
            const g=c.getContext('2d');g.fillStyle='#84b4d4';g.fillRect(0,0,90,120);
            document.getElementById('fixture-snap-image').src=c.toDataURL('image/png');
            """)
        try await wait("document.getElementById('fixture-snap-image').dataset.vigilMediaVerdict==='safe'", in: view)
        view.becomeFirstResponder()
        func saveButton(_ root: UIView) -> UIView? {
            if root.accessibilityIdentifier == "snapchat-save-camera-roll" { return root }
            return root.subviews.lazy.compactMap { saveButton($0) }.first
        }
        host.view.layoutIfNeeded()
        let button = try XCTUnwrap(saveButton(host.view))
        XCTAssertFalse(button.isHidden)
        XCTAssertGreaterThan(button.bounds.width, 40)
        let position = button.convert(button.bounds, to: host.view)
        XCTAssertGreaterThan(position.minY, host.view.bounds.height / 2, "Save belongs to the visible bottom bar")
        try XCTUnwrap(button as? UIButton).sendActions(for: .touchUpInside)
        for _ in 0..<100 {
            if store.snapchatPhotoSaveMessage == "Saved to Camera Roll" { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertEqual(store.snapchatPhotoSaveMessage, "Saved to Camera Roll")
        let screenshot = UIGraphicsImageRenderer(bounds: host.view.bounds).image { _ in
            host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true)
        }
        let attachment = XCTAttachment(image: screenshot)
        attachment.name = "Snapchat native bottom Save to Camera Roll bar"
        attachment.lifetime = .keepAlways
        add(attachment)
        await store.handleSceneActivity(false, isServiceVisible: false)
    }

    @MainActor private func wait(_ condition: String, in view: WKWebView) async throws {
        for _ in 0..<150 {
            if (try? await view.evaluateJavaScript(condition)) as? Bool == true { return }
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTFail("Timed out: \(condition)")
        throw NSError(domain: "SnapchatCameraTests", code: 1)
    }
}

private struct SafeCameraFixtureClassifier: MediaSafetyClassifying {
    func classify(imageData: Data) async -> ContentSafetyVerdict { .safe }
}
