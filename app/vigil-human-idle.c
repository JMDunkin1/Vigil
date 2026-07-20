#include <ApplicationServices/ApplicationServices.h>
#include <AppKit/AppKit.h>
#include <math.h>
#include <stdio.h>

static NSRunningApplication *currentFrontmostApplication(void) {
  // NSWorkspace delivers application-activation changes through the run loop.
  // This helper normally blocks on stdin between samples, so give AppKit a
  // chance to consume any queued workspace notifications before reading the
  // cached frontmostApplication property.
  [[NSRunLoop currentRunLoop]
    runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
  return NSWorkspace.sharedWorkspace.frontmostApplication;
}

int main(void) {
  char request[16];
  setvbuf(stdout, NULL, _IOLBF, 0);
  while (fgets(request, sizeof(request), stdin) != NULL) {
    @autoreleasepool {
      const double seconds = CGEventSourceSecondsSinceLastEventType(
        kCGEventSourceStateHIDSystemState,
        kCGAnyInputEventType
      );
      if (!isfinite(seconds) || seconds < 0) {
        printf("error\n");
        continue;
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
  return 0;
}
