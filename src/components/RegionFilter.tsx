import { useId, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { REGION_PROVINCES, regionDistricts, regionLocalities } from '../region-directory';
import { regionKey, regionLabel, toggleSearchRegion } from '../search-filters';
import type { SearchRegion } from '../types';
import './RegionFilter.css';

export function RegionFilter({ values, onChange }: { values: SearchRegion[]; onChange: (values: SearchRegion[]) => void }) {
  const [province, setProvince] = useState('');
  const [district, setDistrict] = useState('');
  const [locality, setLocality] = useState('');
  const id = useId();
  const districts = province ? regionDistricts(province) : [];
  const localities = province && district ? regionLocalities(province, district) : [];
  const candidate: SearchRegion = { province, ...(district ? { district } : {}), ...(locality ? { locality } : {}) };
  const selected = values.some(value => regionKey(value) === regionKey(candidate));
  const candidatePath = regionLabel(candidate).split(' ');
  const replacesParent = values.some(value => {
    const parentPath = regionLabel(value).split(' ');
    return parentPath.length < candidatePath.length && parentPath.every((part, index) => part === candidatePath[index]);
  });

  return <div className="region-filter">
    <div className="region-filter-path">
      <label htmlFor={`${id}-province`}>시·도</label>
      <select id={`${id}-province`} className="field" value={province} onChange={event => { setProvince(event.target.value); setDistrict(''); setLocality(''); }}><option value="">시·도 선택</option>{REGION_PROVINCES.map(value => <option key={value}>{value}</option>)}</select>
      <label htmlFor={`${id}-district`}>시·군·구</label>
      <select id={`${id}-district`} className="field" value={district} disabled={!province || !districts.length} onChange={event => { setDistrict(event.target.value); setLocality(''); }}><option value="">{province ? '시·군·구 전체' : '시·도 먼저 선택'}</option>{districts.map(value => <option key={value}>{value}</option>)}</select>
      <label htmlFor={`${id}-locality`}>읍·면·동</label>
      <select id={`${id}-locality`} className="field" value={locality} disabled={!district || !localities.length} onChange={event => setLocality(event.target.value)}><option value="">{district ? '읍·면·동 전체' : '시·군·구 먼저 선택'}</option>{localities.map(value => <option key={value}>{value}</option>)}</select>
    </div>
    <button type="button" className={`region-filter-add${selected ? ' is-selected' : ''}`} disabled={!province} onClick={() => onChange(toggleSearchRegion(values, candidate))}>{selected ? <X size={14} /> : <Plus size={14} />}<span>{selected ? '선택 지역 해제' : replacesParent ? '세부 지역으로 변경' : '선택 지역 추가'}</span></button>
    {province && <p className="region-filter-candidate">{regionLabel(candidate)}{!locality ? ' 전체' : ''}</p>}
    {values.length > 0 ? <div className="region-filter-selected"><div className="region-filter-selected-heading"><span>선택 지역 {values.length}개</span><button type="button" onClick={() => onChange([])}>모두 해제</button></div><div className="region-filter-tags">{values.map(value => <button type="button" key={regionKey(value)} title={`${regionLabel(value)} 선택 해제`} aria-label={`${regionLabel(value)} 선택 해제`} onClick={() => onChange(values.filter(item => regionKey(item) !== regionKey(value)))}><span>{regionLabel(value)}</span><X size={12} aria-hidden="true" /></button>)}</div></div> : <p className="region-filter-empty">전국 모든 지역을 표시합니다.</p>}
    <details className="region-selection-help"><summary>지역 선택 안내</summary><p className="filter-description">여러 지역을 추가할 수 있습니다. 시·도 또는 시·군·구 전체를 선택하면 하위 지역을 포함합니다. 세부 지역으로 변경하면 해당 상위 지역의 전체 선택은 해제됩니다.</p></details>
  </div>;
}
