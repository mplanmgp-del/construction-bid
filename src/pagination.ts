export function pageItems(current: number, total: number): (number | 'start-gap' | 'end-gap')[] {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  if (current <= 4) return [1, 2, 3, 4, 5, 'end-gap', total];
  if (current >= total - 3) return [1, 'start-gap', total - 4, total - 3, total - 2, total - 1, total];
  return [1, 'start-gap', current - 1, current, current + 1, 'end-gap', total];
}
