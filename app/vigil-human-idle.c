#include <ApplicationServices/ApplicationServices.h>
#include <AppKit/AppKit.h>
#include <math.h>
#include <stdio.h>

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
      NSRunningApplication *frontmost = NSWorkspace.sharedWorkspace.frontmostApplication;
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
