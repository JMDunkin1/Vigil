#include <ApplicationServices/ApplicationServices.h>
#include <math.h>
#include <stdio.h>

int main(void) {
  const double seconds = CGEventSourceSecondsSinceLastEventType(
    kCGEventSourceStateHIDSystemState,
    kCGAnyInputEventType
  );
  if (!isfinite(seconds) || seconds < 0) return 1;
  printf("%.3f\n", seconds);
  return 0;
}
