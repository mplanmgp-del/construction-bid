export function pageGroup(current: number, total: number) {
  const start = Math.floor((current - 1) / 10) * 10 + 1;
  return {
    items: Array.from({ length: Math.min(10, total - start + 1) }, (_, index) => start + index),
    previous: start > 1 ? start - 10 : null,
    next: start + 10 <= total ? start + 10 : null,
  };
}
