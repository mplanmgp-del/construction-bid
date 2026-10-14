import { useId, useState } from 'react';
import { ChevronDown, ExternalLink, Link2 } from 'lucide-react';
import type { CompanyProfile } from '../types';
import { readQuickLinks } from '../quick-links';
import './FloatingQuickLinks.css';

export function FloatingQuickLinks({ profile }: { profile: CompanyProfile }) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const links = readQuickLinks(profile.quickLinks);
  if (!links.length) return null;

  return (
    <nav className={`floating-quick-links${expanded ? ' is-expanded' : ''}`} aria-label="내 바로가기">
      <div className="floating-quick-links-list" id={id}>
        <span className="floating-quick-links-caption">내 바로가기</span>
        {links.map((link, index) => (
          <a className="floating-quick-link" href={link.url} key={`${index}:${link.url}`} target="_blank" rel="noopener noreferrer"
            title={`${link.label} · 새 탭에서 열기`} aria-label={`${link.label} · 새 탭에서 열기`}>
            <span className="floating-quick-link-number" aria-hidden="true">{index + 1}</span>
            <span className="floating-quick-link-label">{link.label}</span>
            <ExternalLink size={13} aria-hidden="true" />
          </a>
        ))}
      </div>
      <button type="button" className="floating-quick-links-toggle" aria-controls={id} aria-expanded={expanded}
        aria-label={expanded ? '내 바로가기 접기' : `내 바로가기 ${links.length}개 펼치기`} onClick={() => setExpanded(current => !current)}>
        {expanded ? <ChevronDown size={19} aria-hidden="true" /> : <Link2 size={19} aria-hidden="true" />}
        <span>바로가기</span><span className="floating-quick-links-count">{links.length}</span>
      </button>
    </nav>
  );
}
