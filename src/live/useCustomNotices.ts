import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { CustomNoticesController, visibleCustomNotices, type CustomNoticeQuery } from './custom-notice-search';
export type { CustomNoticeQuery } from './custom-notice-search';

export function useCustomNotices(userId?: string) {
  const controllerRef = useRef<CustomNoticesController | null>(null);
  if (!controllerRef.current) controllerRef.current = new CustomNoticesController();
  const controller = controllerRef.current;
  const owner = useRef(userId); owner.current = userId;
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    controller.setUser(userId);
    return () => controller.setUser();
  }, [controller, userId]);
  const search = useCallback((query: CustomNoticeQuery) => controller.getSnapshot().userId === (owner.current || null)
    ? controller.search(query) : Promise.resolve(), [controller]);
  const loadMore = useCallback(() => controller.getSnapshot().userId === (owner.current || null)
    ? controller.loadMore() : Promise.resolve(), [controller]);
  const clear = useCallback(() => { if (controller.getSnapshot().userId === (owner.current || null)) controller.clear(); }, [controller]);
  return { ...visibleCustomNotices(snapshot, userId), search, loadMore, clear };
}
