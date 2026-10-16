import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Building2, Check, Info, Link2, MapPin, RotateCcw, Save, ShieldCheck, Trash2, UserRound } from 'lucide-react';
import { DISTRICTS, LICENSES, PROVINCES } from '../data';
import type { CompanyProfile } from '../types';
import { formatBusinessNumber, normalizeBusinessNumber } from '../company-profile';
import { QUICK_LINK_LABEL_LIMIT, quickLinkDrafts, validateQuickLinkDrafts } from '../quick-links';

interface ProfileViewProps {
  profile: CompanyProfile;
  onSave: (profile: CompanyProfile) => void;
  persistence?: 'browser' | 'cloud';
}

type ProfileErrors = Partial<Record<'companyName' | 'businessNumber' | 'email', string>>;

function copyProfile(profile: CompanyProfile): CompanyProfile {
  return { ...profile, businessNumber: formatBusinessNumber(profile.businessNumber), licenses: [...profile.licenses], quickLinks: quickLinkDrafts(profile.quickLinks) };
}

function profileHasChanges(profile: CompanyProfile, draft: CompanyProfile): boolean {
  return (['companyName', 'province', 'district', 'address', 'contactName', 'email'] as const)
    .some((key) => profile[key] !== draft[key])
    || (normalizeBusinessNumber(profile.businessNumber ?? '') ?? profile.businessNumber)
      !== (normalizeBusinessNumber(draft.businessNumber ?? '') ?? draft.businessNumber)
    || [...profile.licenses].sort().join('\u0000') !== [...draft.licenses].sort().join('\u0000')
    || JSON.stringify(quickLinkDrafts(profile.quickLinks)) !== JSON.stringify(draft.quickLinks);
}

export function ProfileView({ profile, onSave, persistence = 'browser' }: ProfileViewProps) {
  const id = useId();
  const [draft, setDraft] = useState(() => copyProfile(profile));
  const [errors, setErrors] = useState<ProfileErrors>({});
  const [quickLinkErrors, setQuickLinkErrors] = useState<Record<number, string>>({});
  const [feedback, setFeedback] = useState('');
  const previousProfileId = useRef(profile.id);
  const companyInput = useRef<HTMLInputElement>(null);
  const businessNumberInput = useRef<HTMLInputElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const quickLinkInputs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    setDraft(copyProfile(profile));
    setErrors({});
    setQuickLinkErrors({});
    if (previousProfileId.current !== profile.id) setFeedback('');
    previousProfileId.current = profile.id;
  }, [profile]);

  const dirty = profileHasChanges(profile, draft);
  const districts = DISTRICTS[draft.province] ?? [];
  const availableLicenses = [...new Set([...LICENSES, ...draft.licenses])];
  const regionLabel = [draft.province, draft.district].filter(Boolean).join(' ');
  const hasRegion = Boolean(draft.province && draft.district);

  const updateField = (field: Exclude<keyof CompanyProfile, 'id' | 'licenses' | 'quickLinks'>, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setFeedback('');
    if (field === 'companyName' || field === 'businessNumber' || field === 'email') {
      setErrors((current) => ({ ...current, [field]: undefined }));
    }
  };

  const updateQuickLink = (index: number, patch: { label?: string; url?: string }) => {
    setDraft(current => ({ ...current, quickLinks: (current.quickLinks ?? quickLinkDrafts(undefined)).map((link, slot) => slot === index ? { ...link, ...patch } : link) }));
    setQuickLinkErrors(current => { const next = { ...current }; delete next[index]; return next; });
    setFeedback('');
  };

  const toggleLicense = (license: string) => {
    setDraft((current) => ({
      ...current,
      licenses: current.licenses.includes(license)
        ? current.licenses.filter((item) => item !== license)
        : [...current.licenses, license],
    }));
    setFeedback('');
  };

  const resetDraft = () => {
    setDraft(copyProfile(profile));
    setErrors({});
    setQuickLinkErrors({});
    setFeedback('변경 내용을 취소했습니다.');
  };

  const saveProfile = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors: ProfileErrors = {};
    const companyName = draft.companyName.trim();
    const businessNumber = normalizeBusinessNumber(draft.businessNumber ?? '');
    const email = draft.email.trim();
    const shortcuts = validateQuickLinkDrafts(draft.quickLinks ?? []);
    if (!companyName) nextErrors.companyName = '업체명을 입력해주세요.';
    if (businessNumber === null) nextErrors.businessNumber = '사업자등록번호 10자리를 입력해주세요. 예: 123-45-67890';
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      nextErrors.email = '이메일 주소를 확인해주세요. 예: name@example.com';
    }
    setErrors(nextErrors);
    setQuickLinkErrors(shortcuts.errors);
    if (Object.keys(nextErrors).length || Object.keys(shortcuts.errors).length) {
      if (nextErrors.companyName) companyInput.current?.focus();
      else if (nextErrors.businessNumber) businessNumberInput.current?.focus();
      else if (nextErrors.email) emailInput.current?.focus();
      else quickLinkInputs.current[Number(Object.keys(shortcuts.errors)[0])]?.focus();
      setFeedback('입력 내용을 확인한 후 다시 저장해주세요.');
      return;
    }
    const savedProfile = {
      ...draft,
      companyName,
      businessNumber: businessNumber ?? '',
      email,
      address: draft.address.trim(),
      contactName: draft.contactName.trim(),
      licenses: [...draft.licenses],
      quickLinks: shortcuts.links,
    };
    onSave(savedProfile);
    setDraft(copyProfile(savedProfile));
    setFeedback(persistence === 'cloud' ? '업체 정보를 적용했습니다. 클라우드 저장 상태를 확인하세요.' : '업체 정보를 저장했습니다.');
  };

  return (
    <section className="profile-view" aria-labelledby={`${id}-heading`}>
      <header className="profile-page-heading">
        <div>
          <span className="eyebrow">업체 프로필</span>
          <h1 id={`${id}-heading`}>내 정보</h1>
          <p>우리 업체의 소재지와 보유면허를 등록하고, 맞는 공고를 찾아보세요.</p>
        </div>
        <div className={`profile-save-status ${dirty ? 'profile-save-status-dirty' : ''}`} aria-live="polite">
          {dirty ? <span className="profile-status-dot" /> : <Check size={15} aria-hidden="true" />}
          {dirty ? '저장하지 않은 변경사항' : '저장된 업체 정보'}
        </div>
      </header>

      <div className="profile-layout">
        <form className="profile-form panel" onSubmit={saveProfile} noValidate>
          <section className="profile-form-section" aria-labelledby={`${id}-company-heading`}>
            <div className="profile-section-heading">
              <span className="profile-section-icon"><Building2 size={19} aria-hidden="true" /></span>
              <div><h2 id={`${id}-company-heading`}>업체 기본정보</h2><p>지역 자동필터에 사용할 본점 소재지를 입력하세요.</p></div>
            </div>
            <div className="profile-fields">
              <div className="profile-field profile-field-full">
                <label className="field-label" htmlFor={`${id}-company`}>업체명 <span className="profile-required">필수</span></label>
                <input ref={companyInput} id={`${id}-company`} className="field" value={draft.companyName}
                  autoComplete="organization" maxLength={100} placeholder="업체명을 입력하세요"
                  onChange={(event) => updateField('companyName', event.target.value)}
                  aria-invalid={Boolean(errors.companyName)} aria-describedby={errors.companyName ? `${id}-company-error` : undefined} required />
                {errors.companyName && <p id={`${id}-company-error`} className="profile-field-error">{errors.companyName}</p>}
              </div>
              <div className="profile-field profile-field-full">
                <label className="field-label" htmlFor={`${id}-business-number`}>사업자등록번호 <span className="profile-optional">선택</span></label>
                <input ref={businessNumberInput} id={`${id}-business-number`} className="field" value={draft.businessNumber ?? ''}
                  inputMode="numeric" maxLength={12} placeholder="123-45-67890"
                  onChange={(event) => updateField('businessNumber', event.target.value)}
                  onBlur={() => setDraft((current) => ({ ...current, businessNumber: formatBusinessNumber(current.businessNumber) }))}
                  aria-invalid={Boolean(errors.businessNumber)}
                  aria-describedby={`${id}-business-number-help${errors.businessNumber ? ` ${id}-business-number-error` : ''}`} />
                <p id={`${id}-business-number-help`} className="profile-field-help">MY입찰관리에서 우리 업체의 공개 입찰 이력을 조회할 때 사용합니다.</p>
                {errors.businessNumber && <p id={`${id}-business-number-error`} className="profile-field-error">{errors.businessNumber}</p>}
              </div>
              <div className="profile-field">
                <label className="field-label" htmlFor={`${id}-province`}>본점 소재지 · 시·도</label>
                <select id={`${id}-province`} className="field" value={draft.province} onChange={(event) => {
                  setDraft((current) => ({ ...current, province: event.target.value, district: '' }));
                  setFeedback('');
                }}>
                  <option value="">시·도 선택</option>
                  {PROVINCES.map((province) => <option key={province} value={province}>{province}</option>)}
                </select>
              </div>
              <div className="profile-field">
                <label className="field-label" htmlFor={`${id}-district`}>시·군·구</label>
                <select id={`${id}-district`} className="field" value={draft.district}
                  disabled={!draft.province} onChange={(event) => updateField('district', event.target.value)}>
                  <option value="">{draft.province ? '시·군·구 선택' : '시·도를 먼저 선택하세요'}</option>
                  {districts.map((district) => <option key={district} value={district}>{district}</option>)}
                </select>
              </div>
              <div className="profile-field profile-field-full">
                <label className="field-label" htmlFor={`${id}-address`}>상세 주소 <span className="profile-optional">선택</span></label>
                <input id={`${id}-address`} className="field" value={draft.address} autoComplete="street-address"
                  maxLength={200} placeholder="도로명 주소와 상세 주소" onChange={(event) => updateField('address', event.target.value)} />
                <p className="profile-field-help">공사 현장 위치가 아닌, 업체의 본점 소재지를 기준으로 비교합니다.</p>
              </div>
            </div>
          </section>

          <section className="profile-form-section" aria-labelledby={`${id}-license-heading`}>
            <div className="profile-section-heading">
              <span className="profile-section-icon"><ShieldCheck size={19} aria-hidden="true" /></span>
              <div><h2 id={`${id}-license-heading`}>보유면허</h2><p>업체가 보유한 면허를 모두 선택하세요.</p></div>
              <span className="profile-license-count">{draft.licenses.length}개 선택</span>
            </div>
            <div className="profile-license-grid">
              {availableLicenses.map((license) => (
                <label key={license} className={`profile-license-option ${draft.licenses.includes(license) ? 'profile-license-selected' : ''}`}>
                  <input type="checkbox" checked={draft.licenses.includes(license)} onChange={() => toggleLicense(license)} />
                  <span>{license}</span>
                </label>
              ))}
            </div>
          </section>

          <section className="profile-form-section" aria-labelledby={`${id}-contact-heading`}>
            <div className="profile-section-heading">
              <span className="profile-section-icon"><UserRound size={19} aria-hidden="true" /></span>
              <div><h2 id={`${id}-contact-heading`}>담당자 정보</h2><p>담당자 정보는 선택사항입니다.</p></div>
            </div>
            <div className="profile-fields">
              <div className="profile-field">
                <label className="field-label" htmlFor={`${id}-contact`}>담당자명 <span className="profile-optional">선택</span></label>
                <input id={`${id}-contact`} className="field" value={draft.contactName} autoComplete="name"
                  maxLength={60} placeholder="담당자 이름" onChange={(event) => updateField('contactName', event.target.value)} />
              </div>
              <div className="profile-field">
                <label className="field-label" htmlFor={`${id}-email`}>이메일 <span className="profile-optional">선택</span></label>
                <input ref={emailInput} id={`${id}-email`} className="field" type="email" value={draft.email}
                  autoComplete="email" maxLength={254} placeholder="name@example.com"
                  onChange={(event) => updateField('email', event.target.value)} aria-invalid={Boolean(errors.email)}
                  aria-describedby={errors.email ? `${id}-email-error` : undefined} />
                {errors.email && <p id={`${id}-email-error`} className="profile-field-error">{errors.email}</p>}
              </div>
            </div>
          </section>

          <section className="profile-form-section" aria-labelledby={`${id}-links-heading`}>
            <div className="profile-section-heading">
              <span className="profile-section-icon"><Link2 size={19} aria-hidden="true" /></span>
              <div><h2 id={`${id}-links-heading`}>내 바로가기</h2><p>자주 사용하는 웹사이트를 최대 4개 등록하세요. 저장하면 화면 오른쪽에 따라다니는 버튼으로 표시됩니다.</p></div>
            </div>
            <div className="profile-quick-links">
              {(draft.quickLinks ?? []).map((link, index) => (
                <div className="profile-quick-link" key={index}>
                  <span className="profile-quick-link-number" aria-hidden="true">{index + 1}</span>
                  <div className="profile-field">
                    <label className="field-label" htmlFor={`${id}-link-name-${index}`}>바로가기 {index + 1} 이름</label>
                    <input className="field" id={`${id}-link-name-${index}`} value={link.label} maxLength={QUICK_LINK_LABEL_LIMIT}
                      placeholder="버튼 이름" onChange={event => updateQuickLink(index, { label: event.target.value })} />
                  </div>
                  <div className="profile-field">
                    <label className="field-label" htmlFor={`${id}-link-url-${index}`}>URL</label>
                    <input className="field" id={`${id}-link-url-${index}`} aria-label={`바로가기 ${index + 1} URL`}
                      ref={element => { quickLinkInputs.current[index] = element; }} value={link.url} inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                      maxLength={2048} placeholder="https://웹사이트주소" onChange={event => updateQuickLink(index, { url: event.target.value })}
                      aria-invalid={Boolean(quickLinkErrors[index])} aria-describedby={quickLinkErrors[index] ? `${id}-link-error-${index}` : undefined} />
                    {quickLinkErrors[index] && <p className="profile-field-error" id={`${id}-link-error-${index}`}>{quickLinkErrors[index]}</p>}
                  </div>
                  <button className="profile-quick-link-delete" type="button" aria-label={`바로가기 ${index + 1} 삭제`} title="바로가기 삭제"
                    disabled={!link.label && !link.url} onClick={() => updateQuickLink(index, { label: '', url: '' })}><Trash2 size={17} aria-hidden="true" /></button>
                </div>
              ))}
            </div>
            <p className="profile-field-help">주소에 https://를 생략해도 됩니다. 버튼 이름을 비워두면 사이트 주소가 표시됩니다. 삭제한 바로가기도 정보 저장 후 적용됩니다.</p>
          </section>

          <footer className="profile-form-footer">
            <p className="profile-feedback" role="status">{feedback || (dirty ? '변경한 정보는 저장 후 적용됩니다.' : persistence === 'cloud' ? '현재 회원의 업체 정보를 클라우드에 저장합니다.' : '현재 업체의 정보가 브라우저에 저장됩니다.')}</p>
            <div className="profile-actions">
              <button type="button" className="button button-secondary" disabled={!dirty} onClick={resetDraft}><RotateCcw size={16} aria-hidden="true" />변경 취소</button>
              <button type="submit" className="button button-primary"><Save size={16} aria-hidden="true" />정보 저장</button>
            </div>
          </footer>
        </form>

        <aside className="profile-summary">
          <div className="profile-summary-card panel">
            <span className="profile-summary-icon"><MapPin size={24} aria-hidden="true" /></span>
            <span className="eyebrow">우리 업체의 지역 기준</span>
            <h2>{draft.companyName.trim() || '업체명 미입력'}</h2>
            <p className="profile-current-region">{regionLabel || '본점 소재지를 선택하세요'}</p>
            <span className={`badge ${hasRegion ? 'badge-green' : 'badge-amber'}`}>{hasRegion ? '지역조건 비교 가능' : '소재지 확인 필요'}</span>
            <div className="profile-summary-divider" />
            <div className="profile-summary-stat"><span>보유면허</span><strong>{draft.licenses.length}개</strong></div>
            <p className="profile-summary-licenses">{draft.licenses.length ? draft.licenses.join(' · ') : '선택한 면허가 없습니다.'}</p>
            {dirty && <p className="profile-summary-draft">저장 전 변경 내용을 미리 보고 있습니다.</p>}
          </div>
          <div className="profile-guidance">
            <Info size={18} aria-hidden="true" />
            <div><strong>지역 일치는 첫 번째 확인입니다.</strong><p>지역판정은 등록한 소재지와 공고의 지역조건만 비교합니다. 면허, 실적, 공동수급 등 최종 참가자격은 공고 원문을 확인하세요.</p></div>
          </div>
        </aside>
      </div>
    </section>
  );
}
