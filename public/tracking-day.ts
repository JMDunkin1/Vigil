export const TRACKING_DAY_ROLLOVER_HOUR = 3;

export function trackingDay(value = new Date()): Date {
  const day = new Date(value);
  if (day.getHours() < TRACKING_DAY_ROLLOVER_HOUR) day.setDate(day.getDate() - 1);
  day.setHours(0, 0, 0, 0);
  return day;
}

export function nextTrackingDayRollover(value = new Date()): Date {
  const rollover = new Date(value);
  rollover.setHours(TRACKING_DAY_ROLLOVER_HOUR, 0, 0, 0);
  if (rollover.getTime() <= value.getTime()) rollover.setDate(rollover.getDate() + 1);
  return rollover;
}

export function millisecondsUntilTrackingDayRollover(value = new Date()): number {
  return Math.max(1, nextTrackingDayRollover(value).getTime() - value.getTime());
}
