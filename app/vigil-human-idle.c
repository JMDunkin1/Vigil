#include <ApplicationServices/ApplicationServices.h>
#include <AppKit/AppKit.h>
#include <errno.h>
#include <math.h>
#include <poll.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

enum {
  // Keep the aggregate, permission-free fallback within roughly one to two
  // display frames. The expensive URL query is still event-coalesced in Node;
  // this loop only reads tiny WindowServer counters.
  browserActivityPollMilliseconds = 25
};

typedef struct {
  bool initialized;
  uint32_t keyDown;
  uint32_t keyUp;
  uint32_t flagsChanged;
  uint32_t leftMouseDown;
  uint32_t leftMouseUp;
  uint32_t rightMouseDown;
  uint32_t rightMouseUp;
  uint32_t otherMouseDown;
  uint32_t otherMouseUp;
  uint32_t scrollWheel;
} BrowserActivityCounters;

static uint32_t eventCounter(CGEventType type) {
  // Aggregate counters reveal only that an event occurred. They do not expose
  // characters, key codes, pointer coordinates, or an event payload, and they
  // avoid the extra Input Monitoring permission required by a global event tap.
  // Combined-session counters also include assistive and remote input that can
  // navigate a browser without a physical HID key-down event.
  return (uint32_t)CGEventSourceCounterForEventType(
    kCGEventSourceStateCombinedSessionState,
    type
  );
}

static const char *changedBrowserActivityKind(BrowserActivityCounters *previous) {
  BrowserActivityCounters current = {
    .initialized = true,
    .keyDown = eventCounter(kCGEventKeyDown),
    .keyUp = eventCounter(kCGEventKeyUp),
    .flagsChanged = eventCounter(kCGEventFlagsChanged),
    .leftMouseDown = eventCounter(kCGEventLeftMouseDown),
    .leftMouseUp = eventCounter(kCGEventLeftMouseUp),
    .rightMouseDown = eventCounter(kCGEventRightMouseDown),
    .rightMouseUp = eventCounter(kCGEventRightMouseUp),
    .otherMouseDown = eventCounter(kCGEventOtherMouseDown),
    .otherMouseUp = eventCounter(kCGEventOtherMouseUp),
    .scrollWheel = eventCounter(kCGEventScrollWheel)
  };
  if (!previous->initialized) {
    *previous = current;
    return NULL;
  }

  const bool keyChanged = current.keyDown != previous->keyDown
    || current.keyUp != previous->keyUp
    || current.flagsChanged != previous->flagsChanged;
  const bool pointerChanged = current.leftMouseDown != previous->leftMouseDown
    || current.leftMouseUp != previous->leftMouseUp
    || current.rightMouseDown != previous->rightMouseDown
    || current.rightMouseUp != previous->rightMouseUp
    || current.otherMouseDown != previous->otherMouseDown
    || current.otherMouseUp != previous->otherMouseUp
    || current.scrollWheel != previous->scrollWheel;
  *previous = current;
  if (keyChanged) return "key";
  if (pointerChanged) return "click";
  return NULL;
}

static NSRunningApplication *currentFrontmostApplication(void) {
  // NSWorkspace delivers application-activation changes through the run loop.
  // This helper normally blocks on stdin between samples, so give AppKit a
  // chance to consume any queued workspace notifications before reading the
  // cached frontmostApplication property.
  [[NSRunLoop currentRunLoop]
    runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
  return NSWorkspace.sharedWorkspace.frontmostApplication;
}

static void printHumanActivitySample(void) {
  @autoreleasepool {
    const double seconds = CGEventSourceSecondsSinceLastEventType(
      kCGEventSourceStateHIDSystemState,
      kCGAnyInputEventType
    );
    if (!isfinite(seconds) || seconds < 0) {
      printf("error\n");
      return;
    }
    NSRunningApplication *frontmost = currentFrontmostApplication();
    NSString *name = frontmost.localizedName ?: @"";
    NSString *bundleId = frontmost.bundleIdentifier ?: @"";
    name = [[name stringByReplacingOccurrencesOfString:@"\t" withString:@" "]
      stringByReplacingOccurrencesOfString:@"\n" withString:@" "];
    bundleId = [[bundleId stringByReplacingOccurrencesOfString:@"\t" withString:@" "]
      stringByReplacingOccurrencesOfString:@"\n" withString:@" "];
    printf("%.3f\t%s\t%s\n", seconds, name.UTF8String, bundleId.UTF8String);
  }
}

int main(int argc, const char *argv[]) {
  char request[16];
  bool watchBrowserActivity = argc > 1
    && strcmp(argv[1], "--watch-browser-activity") == 0;
  BrowserActivityCounters activityCounters = {0};
  setvbuf(stdin, NULL, _IONBF, 0);
  setvbuf(stdout, NULL, _IOLBF, 0);
  if (watchBrowserActivity) (void)changedBrowserActivityKind(&activityCounters);

  while (true) {
    if (watchBrowserActivity) {
      struct pollfd input = {
        .fd = STDIN_FILENO,
        .events = POLLIN,
        .revents = 0
      };
      const int result = poll(&input, 1, browserActivityPollMilliseconds);
      if (result < 0) {
        if (errno == EINTR) continue;
        return 1;
      }
      const char *kind = changedBrowserActivityKind(&activityCounters);
      if (kind != NULL) printf("wake\t%s\n", kind);
      if (result == 0) continue;
      if ((input.revents & POLLIN) == 0) break;
    }

    if (fgets(request, sizeof(request), stdin) == NULL) break;
    if (strcmp(request, "watch\n") == 0) {
      watchBrowserActivity = true;
      memset(&activityCounters, 0, sizeof(activityCounters));
      (void)changedBrowserActivityKind(&activityCounters);
      continue;
    }
    if (strcmp(request, "unwatch\n") == 0) {
      watchBrowserActivity = false;
      memset(&activityCounters, 0, sizeof(activityCounters));
      continue;
    }
    printHumanActivitySample();
  }
  return 0;
}
