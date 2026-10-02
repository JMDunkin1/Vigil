#include <ApplicationServices/ApplicationServices.h>
#include <AppKit/AppKit.h>
#include <errno.h>
#include <math.h>
#include <poll.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

enum {
  // Aggregate, permission-free counters do not need display-frame cadence.
  // A 100ms bound remains responsive while cutting idle WindowServer queries
  // by 75%; Node still launches the first browser probe immediately.
  browserActivityPollMilliseconds = 100,
  browserActivityHeartbeatMilliseconds = 1000
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

static bool watchBrowserActivity = false;

static int64_t monotonicMilliseconds(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return -1;
  return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static void printApplicationActivity(NSNotification *notification, NSString *kind) {
  NSRunningApplication *app = notification.userInfo[NSWorkspaceApplicationKey];
  if (!watchBrowserActivity) return;
  if (!app || !app.bundleIdentifier || !app.launchDate) {
    printf("wake\t%s\n", kind.UTF8String);
    return;
  }
  NSDictionary *info = [NSBundle bundleWithURL:app.bundleURL].infoDictionary ?: @{};
  NSDictionary *frame = @{
    @"kind": kind, @"app": app.localizedName ?: @"",
    @"bundleId": app.bundleIdentifier, @"pid": @(app.processIdentifier),
    @"launchedAt": @(app.launchDate.timeIntervalSince1970),
    @"bundleInfo": @{
      @"CFBundleURLTypes": info[@"CFBundleURLTypes"] ?: @[],
      @"CFBundleDocumentTypes": info[@"CFBundleDocumentTypes"] ?: @[]
    }
  };
  NSData *json = [NSJSONSerialization dataWithJSONObject:frame options:0 error:nil];
  if (json) printf("application\t%.*s\n", (int)json.length, (const char *)json.bytes);
}

@interface VigilWorkspaceObserver : NSObject
- (void)applicationActivated:(NSNotification *)notification;
- (void)applicationLaunched:(NSNotification *)notification;
@end

@implementation VigilWorkspaceObserver
- (void)applicationActivated:(NSNotification *)notification {
  printApplicationActivity(notification, @"activate");
}

- (void)applicationLaunched:(NSNotification *)notification {
  printApplicationActivity(notification, @"launch");
}
@end

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

static void drainWorkspaceNotifications(void) {
  // This command-line helper has no AppKit event loop to drain autoreleased
  // objects. Even an idle watch creates a date and processes notifications on
  // every iteration, so bound their lifetime independently of sample requests.
  @autoreleasepool {
    [[NSRunLoop currentRunLoop]
      runMode:NSDefaultRunLoopMode
      beforeDate:[NSDate date]];
  }
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

static int runHelper(int argc, const char *argv[]) {
  char request[16];
  watchBrowserActivity = argc > 1
    && strcmp(argv[1], "--watch-browser-activity") == 0;
  BrowserActivityCounters activityCounters = {0};
  VigilWorkspaceObserver *workspaceObserver = [VigilWorkspaceObserver new];
  NSNotificationCenter *workspaceNotifications = NSWorkspace.sharedWorkspace.notificationCenter;
  [workspaceNotifications
    addObserver:workspaceObserver
    selector:@selector(applicationActivated:)
    name:NSWorkspaceDidActivateApplicationNotification
    object:nil];
  [workspaceNotifications
    addObserver:workspaceObserver
    selector:@selector(applicationLaunched:)
    name:NSWorkspaceDidLaunchApplicationNotification
    object:nil];
  setvbuf(stdin, NULL, _IONBF, 0);
  setvbuf(stdout, NULL, _IOLBF, 0);
  if (watchBrowserActivity) (void)changedBrowserActivityKind(&activityCounters);
  int64_t nextBrowserActivityHeartbeatAt = monotonicMilliseconds() + browserActivityHeartbeatMilliseconds;

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
      drainWorkspaceNotifications();
      const char *kind = changedBrowserActivityKind(&activityCounters);
      if (kind != NULL) printf("wake\t%s\n", kind);
      const int64_t heartbeatNow = monotonicMilliseconds();
      if (heartbeatNow >= nextBrowserActivityHeartbeatAt) {
        printf("watch\talive\n");
        nextBrowserActivityHeartbeatAt = heartbeatNow + browserActivityHeartbeatMilliseconds;
      }
      if (result == 0) continue;
      if ((input.revents & POLLIN) == 0) break;
    }

    if (fgets(request, sizeof(request), stdin) == NULL) break;
    if (strcmp(request, "watch\n") == 0) {
      watchBrowserActivity = true;
      memset(&activityCounters, 0, sizeof(activityCounters));
      (void)changedBrowserActivityKind(&activityCounters);
      nextBrowserActivityHeartbeatAt = monotonicMilliseconds() + browserActivityHeartbeatMilliseconds;
      continue;
    }
    if (strcmp(request, "unwatch\n") == 0) {
      watchBrowserActivity = false;
      memset(&activityCounters, 0, sizeof(activityCounters));
      continue;
    }
    printHumanActivitySample();
  }
  [workspaceNotifications removeObserver:workspaceObserver];
  [workspaceObserver release];
  return 0;
}

// Read only Safari's focused window. Ordinary web pages cannot supply the
// safari-resource: error-document URL. No page text or history leaves this helper.
static id safariAXAttribute(AXUIElementRef element, CFStringRef attribute) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(element, attribute, &value) != kAXErrorSuccess || !value) return nil;
  return [(id)value autorelease];
}

static void scanSafariError(AXUIElementRef element, int depth, int *remaining,
                           bool inNativeError, bool *errorText, bool *reloadButton,
                           NSString **address) {
  if (depth > 18 || (*remaining)-- <= 0) return;
  NSString *role = safariAXAttribute(element, kAXRoleAttribute);
  if ([role isEqualToString:@"AXWebArea"]) {
    id rawURL = safariAXAttribute(element, kAXURLAttribute);
    NSString *url = [rawURL isKindOfClass:NSURL.class] ? [rawURL absoluteString] : rawURL;
    if (![url isKindOfClass:NSString.class] || ![url isEqualToString:@"safari-resource:/ErrorPage.html"]) return;
    inNativeError = true;
  }
  if (inNativeError) {
    id value = safariAXAttribute(element, kAXValueAttribute);
    id title = safariAXAttribute(element, kAXTitleAttribute);
    if ([value isKindOfClass:NSString.class] && [value containsString:@"blocked by a content blocker"]) *errorText = true;
    if ([role isEqualToString:@"AXButton"] && [title isEqualToString:@"Reload Without Content Blockers"]) *reloadButton = true;
  } else if ([safariAXAttribute(element, CFSTR("AXIdentifier")) isEqualToString:@"WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD"]) {
    id value = safariAXAttribute(element, kAXValueAttribute);
    if ([value isKindOfClass:NSString.class]) *address = value;
  }
  NSArray *children = safariAXAttribute(element, kAXChildrenAttribute);
  if (![children isKindOfClass:NSArray.class]) return;
  for (id child in children) scanSafariError((AXUIElementRef)child, depth + 1, remaining, inNativeError, errorText, reloadButton, address);
}

static int printSafariContentBlockerError(void) {
  NSRunningApplication *app = currentFrontmostApplication();
  if (![app.bundleIdentifier isEqualToString:@"com.apple.Safari"] || !AXIsProcessTrusted()) {
    puts("{\"contentBlockerError\":false}"); return 0;
  }
  AXUIElementRef application = AXUIElementCreateApplication(app.processIdentifier);
  AXUIElementSetMessagingTimeout(application, 0.1);
  id window = safariAXAttribute(application, kAXFocusedWindowAttribute);
  bool errorText = false, reloadButton = false;
  NSString *address = @"";
  int remaining = 600;
  if (window) scanSafariError((AXUIElementRef)window, 0, &remaining, false, &errorText, &reloadButton, &address);
  const bool stillSafari = currentFrontmostApplication().processIdentifier == app.processIdentifier;
  NSDictionary *result = @{ @"contentBlockerError": @(stillSafari && errorText && reloadButton), @"url": address };
  NSData *json = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
  if (json) printf("%.*s\n", (int)json.length, (const char *)json.bytes);
  CFRelease(application);
  return 0;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc == 2 && strcmp(argv[1], "--safari-content-blocker-error") == 0) return printSafariContentBlockerError();
    if (argc == 5 && strcmp(argv[1], "--quit-application-instance") == 0) {
      NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:atoi(argv[2])];
      NSString *bundleId = [NSString stringWithUTF8String:argv[3]];
      // Bind the action to this launch, never a name or a reused PID. Vigil's
      // enforcement runtime and the supported browsers are never targets here.
      if (!app || !app.launchDate || ![app.bundleIdentifier isEqualToString:bundleId]
          || fabs(app.launchDate.timeIntervalSince1970 - atof(argv[4])) > 0.000001
          || [bundleId hasPrefix:@"tech.caseline.vigil"]
          || [@[@"com.apple.Safari", @"com.google.Chrome", @"com.openai.codex", @"com.openai.chat", @"com.apple.finder"] containsObject:bundleId]) return 2;
      return [app forceTerminate] ? 0 : 1;
    }
    return runHelper(argc, argv);
  }
}
