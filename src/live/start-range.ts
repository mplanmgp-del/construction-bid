export const START_LOOKBACK_DAYS = 90;
const day = 86_400_000;
export function startSearchWindows(from: string, to: string) {
  const windows: { from: string; to: string }[] = [];
  const oldest = Date.parse(from) - START_LOOKBACK_DAYS * day;
  // Newest first; every posting day is covered once, with no overlapping boundaries.
  for (let end = Date.parse(to); end >= oldest;) {
    const start = Math.max(oldest, end - 30 * day);
    windows.push({ from: new Date(start).toISOString().slice(0, 10), to: new Date(end).toISOString().slice(0, 10) });
    end = start - day;
  }
  return windows;
}
