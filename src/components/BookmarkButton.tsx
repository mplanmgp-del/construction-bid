import { Star } from 'lucide-react';

export function BookmarkButton({ noticeTitle, saved, onToggle, disabled = false, className = '' }: {
  noticeTitle: string; saved: boolean; onToggle: () => void; disabled?: boolean; className?: string;
}) {
  return <button type="button" className={`notice-bookmark${saved ? ' is-saved' : ''}${className ? ` ${className}` : ''}`}
    aria-label={`${noticeTitle} 즐겨찾기 ${saved ? '해제' : '저장'}`} aria-pressed={saved} onClick={onToggle} disabled={disabled}>
    <Star size={16} fill={saved ? 'currentColor' : 'none'} aria-hidden="true" /><span>{saved ? '저장됨' : '즐겨찾기'}</span>
  </button>;
}
