import Foundation
import ImageIO

enum SocialMediaSuspensionPolicy {
    static func relinquishesGlobalAudio(requested: Bool, serviceIsVisible: Bool) -> Bool {
        requested && serviceIsVisible
    }
}

enum YouTubeExternalPlaybackFramePolicy {
    static func isValidCapturedFrame(_ data: Data?) -> Bool {
        guard let data,
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return false }
        return image.width > 0 && image.height > 0
    }

    // A completed check follows the same explicit install policy as foreground
    // playback. Personal Team's reveal-unclassified policy can permit unknown;
    // this does not turn that raw classifier result into a safety guarantee.
    static func permitsCompletedFrameCheck(verdict: ContentSafetyVerdict,
                                          policy: UnclassifiedMediaPolicy,
                                          completedValidFrameCheck: Bool) -> Bool {
        completedValidFrameCheck && policy.resolve(verdict) == .safe
    }

    static func isFresh(completedAt: TimeInterval?, uptime: TimeInterval) -> Bool {
        guard let completedAt else { return false }
        let age = uptime - completedAt
        // Existing checks repeat at six seconds with a five-second deadline.
        return age >= 0 && age < 12
    }
}

// An observer of the existing durable ledger, never a second allowance. The
// page still settles actual play time; this gate stops external playback when
// its last persisted reservation runs out, even if WebKit delays page timers.
struct YouTubeExternalPlaybackAuthorization {
    private(set) var leaseID: String?
    private(set) var client: String?
    private(set) var videoID: String?
    private(set) var allowedMilliseconds = 0.0
    private(set) var playedMilliseconds = 0.0
    private(set) var expiresAt: Date?
    private var expiresAtUptime: TimeInterval?
    private var previousSnapshot: YouTubeExternalPlaybackSnapshot?

    var hasLease: Bool { leaseID != nil }
    var remainingPlaybackMilliseconds: Double { max(0, allowedMilliseconds - playedMilliseconds - 100) }

    mutating func reset() { self = Self() }

    mutating func receive(request: [String: Any], reply: [String: Any], now: Date = Date(),
                          uptime: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        guard let action = request["action"] as? String else { return }
        guard ["start", "renew", "settle"].contains(action) else { return }
        if action == "settle" {
            if request["leaseId"] as? String == leaseID { reset() }
            return
        }
        guard reply["ok"] as? Bool == true,
              let lease = reply["lease"] as? [String: Any],
              let id = lease["id"] as? String, !id.isEmpty,
              let owner = lease["client"] as? String, !owner.isEmpty,
              owner == request["client"] as? String,
              let video = lease["videoId"] as? String,
              video.range(of: "^[A-Za-z0-9_-]{11}$", options: .regularExpression) != nil,
              let allowed = lease["milliseconds"] as? Double, allowed.isFinite, allowed > 0,
              let settled = lease["settledMs"] as? Double, settled.isFinite, settled >= 0, settled <= allowed,
              let expiration = lease["expiresAt"] as? Double, expiration.isFinite,
              let serverTime = reply["serverTime"] as? Double, serverTime.isFinite,
              expiration > serverTime,
              expiration > now.timeIntervalSince1970 * 1_000 else { reset(); return }
        if action == "renew", (id != leaseID || owner != client || video != videoID) {
            reset()
            return
        }
        if action == "start" {
            guard request["videoId"] as? String == video else { reset(); return }
            reset()
        }
        leaseID = id
        client = owner
        videoID = video
        allowedMilliseconds = allowed
        playedMilliseconds = max(playedMilliseconds, settled)
        expiresAt = Date(timeIntervalSince1970: expiration / 1_000)
        // The authority reserves five seconds at most. Uptime also expires the
        // reservation when the user moves the wall clock backwards.
        expiresAtUptime = uptime + min(5_000, expiration - serverTime) / 1_000
    }

    mutating func sample(_ snapshot: YouTubeExternalPlaybackSnapshot) {
        defer { previousSnapshot = snapshot }
        guard let previousSnapshot,
              previousSnapshot.videoID == videoID, snapshot.videoID == videoID,
              previousSnapshot.playing, !previousSnapshot.seeking, !snapshot.seeking,
              snapshot.position >= previousSnapshot.position else { return }
        let wallMilliseconds = max(0, snapshot.uptime - previousSnapshot.uptime) * 1_000
        let progressMilliseconds = max(0, snapshot.position - previousSnapshot.position) * 1_000
            / max(0.01, previousSnapshot.rate)
        playedMilliseconds += min(wallMilliseconds, progressMilliseconds)
    }

    func permits(_ snapshot: YouTubeExternalPlaybackSnapshot, accessConfirmed: Bool,
                 restricted: Bool, now: Date = Date(),
                 uptime: TimeInterval = ProcessInfo.processInfo.systemUptime) -> Bool {
        guard hasLease, accessConfirmed, !restricted,
              snapshot.videoID == videoID, snapshot.permittedUnderPolicy,
              let expiresAt, now < expiresAt,
              let expiresAtUptime, uptime < expiresAtUptime,
              allowedMilliseconds - playedMilliseconds > 100 else { return false }
        return true
    }
}

struct YouTubeExternalPlaybackSnapshot {
    let videoID: String?
    let mediaID: String?
    let permittedUnderPolicy: Bool
    let playing: Bool
    let seeking: Bool
    let pictureInPicture: Bool
    let position: Double
    let rate: Double
    let uptime: TimeInterval

    init?(result: Any, uptime: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        guard let values = result as? [String: Any],
              let position = values["position"] as? Double, position.isFinite, position >= 0,
              let rate = values["rate"] as? Double, rate.isFinite, rate > 0 else { return nil }
        videoID = values["videoID"] as? String
        mediaID = values["mediaID"] as? String
        permittedUnderPolicy = values["permittedUnderPolicy"] as? Bool == true
        playing = values["playing"] as? Bool == true
        seeking = values["seeking"] as? Bool == true
        pictureInPicture = values["pictureInPicture"] as? Bool == true
        self.position = position
        self.rate = rate
        self.uptime = uptime
    }
}

enum YouTubeExternalPlaybackScript {
    // Isolated WebKit world: native permission is not a page-callable grant.
    // DOM verdicts follow Vigil's unchanged foreground install policy. Native
    // permission additionally requires a fresh completed frame check.
    static let source = #"""
    (() => {
      if (window !== window.top) return;
      let authorizedID = null, pictureEnabled = false;
      const currentID = () => {
        if (!/^https:\/\/(?:www\.|m\.)?youtube\.com\//.test(location.href)
            || !['/watch', '/watch/'].includes(location.pathname)) return null;
        const id = new URLSearchParams(location.search).get('v');
        return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null;
      };
      const primaryVideo = () => currentID() ? document.querySelector('video') : null;
      const sourceFingerprint = video => JSON.stringify({
        current: String(video.currentSrc || video.src || ''),
        declared: String(video.getAttribute('src') || ''),
        sources: [...video.querySelectorAll('source')].map(source => [
          String(source.getAttribute('src') || ''), String(source.getAttribute('srcset') || ''),
          String(source.getAttribute('media') || ''), String(source.getAttribute('type') || '')
        ])
      });
      const permittedUnderPolicy = video => Boolean(video
        && document.documentElement?.dataset.vigilPageVerdict === 'safe'
        && video.dataset.vigilMediaVerdict !== 'sensitive'
        && video.dataset.vigilVideoFrameVerdict === 'safe'
        && video.dataset.vigilVideoFrameFingerprint === sourceFingerprint(video));
      const eligible = video => pictureEnabled && authorizedID === currentID()
        && video === primaryVideo() && permittedUnderPolicy(video);
      const update = () => {
        document.querySelectorAll('video').forEach(video => {
          const disabled = !eligible(video);
          if (video.disablePictureInPicture !== disabled) video.disablePictureInPicture = disabled;
          if (disabled && video.webkitPresentationMode === 'picture-in-picture') {
            try { video.webkitSetPresentationMode?.('inline'); } catch (_) {}
            video.pause();
          }
        });
      };
      window.__vigilExternalPlaybackPermission = (videoID, enabled) => {
        authorizedID = videoID; pictureEnabled = enabled === true; update();
      };
      window.__vigilExternalPlaybackSnapshot = () => {
        const video = primaryVideo();
        return {
          videoID: currentID(), mediaID: video?.dataset.vigilMediaId || null,
          permittedUnderPolicy: permittedUnderPolicy(video),
          playing: Boolean(video && !video.paused && !video.ended && video.readyState >= 2),
          seeking: Boolean(video?.seeking),
          pictureInPicture: Boolean(video && (video.webkitPresentationMode === 'picture-in-picture'
            || document.pictureInPictureElement === video)),
          position: Number(video?.currentTime || 0), rate: Number(video?.playbackRate || 1)
        };
      };
      window.__vigilRequestExternalPictureInPicture = () => {
        const video = primaryVideo();
        if (!video || !eligible(video)) return false;
        if (video.webkitSupportsPresentationMode?.('picture-in-picture')) {
          video.webkitSetPresentationMode('picture-in-picture'); return true;
        }
        if (video.requestPictureInPicture && !video.disablePictureInPicture) {
          void video.requestPictureInPicture().catch(() => {}); return true;
        }
        return false;
      };
      window.__vigilStopExternalPlayback = () => {
        authorizedID = null;
        document.querySelectorAll('video, audio').forEach(video => {
          video.pause();
          if (video.webkitPresentationMode === 'picture-in-picture') {
            try { video.webkitSetPresentationMode?.('inline'); } catch (_) {}
          }
        });
        if (document.pictureInPictureElement) void document.exitPictureInPicture?.().catch(() => {});
        update();
      };
      const observe = () => {
        if (!document.documentElement) return;
        new MutationObserver(update).observe(document.documentElement, {
          childList: true, subtree: true, attributes: true,
          attributeFilter: ['data-vigil-page-verdict', 'data-vigil-media-verdict',
            'data-vigil-video-frame-verdict', 'data-vigil-video-frame-fingerprint', 'src', 'disablepictureinpicture']
        });
        update();
      };
      for (const event of ['playing', 'pause', 'ended', 'emptied', 'popstate',
        'yt-navigate-finish', 'webkitpresentationmodechanged']) document.addEventListener(event, update, true);
      if (document.documentElement) observe();
      else document.addEventListener('DOMContentLoaded', observe, {once: true});
    })();
    """#
}
