import { useEffect, useId, useMemo, useState } from 'react';
import { BookOpen, Calculator, Check, Copy, Info, RotateCcw, Shuffle } from 'lucide-react';
import { calculateAnalysis, calculateScenario, drawScenario, type ScenarioDraw, type ScenarioInput } from './calculations';
import { BID_GLOSSARY } from './glossary';
import { clearPendingBidHelperSeed, readPendingBidHelperSeed, type BidHelperSeed } from './notice-seed';
import { readRate, readWon } from './form';
import { EMPTY_FIELDS, restoreBidHelperState, serializeBidHelperState, type BidHelperFields as Fields } from './draft';

type Mode = 'scenario' | 'analysis' | 'glossary';
const EMPTY = EMPTY_FIELDS;
const DRAFT_KEY = 'construction-bid:helper-draft:v1';
const amount = (value: number) => value.toLocaleString('ko-KR', { maximumFractionDigits: 6 });
const won = (value: number) => `${amount(value)}원`;
const percent = (value: number) => `${value.toLocaleString('ko-KR', { minimumFractionDigits: 4, maximumFractionDigits: 6 })}%`;
const drawPercent = (value: number) => `${value.toLocaleString('ko-KR', { minimumFractionDigits: 4, maximumFractionDigits: 8 })}%`;
const difference = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(6)}%p`;

export function BidHelper({ initialSeed, onSeedConsumed }: { initialSeed?: BidHelperSeed; onSeedConsumed?: () => void }) {
  const id = useId();
  const [initial] = useState(() => {
    const requestedSeed = initialSeed ?? readPendingBidHelperSeed();
    try { return restoreBidHelperState(requestedSeed, sessionStorage.getItem(DRAFT_KEY)); }
    catch { return restoreBidHelperState(requestedSeed, null); }
  });
  const [seed, setSeed] = useState(initial.seed);
  const [fields, setFields] = useState<Fields>(initial.fields);
  const [mode, setMode] = useState<Mode>('scenario');
  const [attempted, setAttempted] = useState(false);
  const [message, setMessage] = useState('');
  const [draw, setDraw] = useState<ScenarioDraw>();
  const [submitError, setSubmitError] = useState('');
  const [storageFailed, setStorageFailed] = useState(false);
  const [glossarySearch, setGlossarySearch] = useState('');

  useEffect(() => { clearPendingBidHelperSeed(); }, []);
  useEffect(() => {
    try { sessionStorage.setItem(DRAFT_KEY, serializeBidHelperState({ fields, seed })); setStorageFailed(false); }
    catch { setStorageFailed(true); }
  }, [fields, seed]);
  useEffect(() => { onSeedConsumed?.(); }, [onSeedConsumed]);

  const calculated = useMemo(() => {
    try {
      const common = { baseAmount: readWon(fields.baseAmount, '기초금액'), aValue: readWon(fields.aValue, 'A값'), lowerRate: readRate(fields.lowerRate, '낙찰하한율') };
      if (mode === 'analysis') {
        const input = { ...common, plannedPrice: readWon(fields.plannedPrice, '개찰 예정가격'), bidAmount: readWon(fields.bidAmount, '실제 투찰금액') };
        return { result: { ...calculateAnalysis(input), plannedPrice: input.plannedPrice, bidAmount: input.bidAmount }, error: '' };
      }
      const input: ScenarioInput = { ...common, noticeRate: readRate(fields.noticeRate, '가정 공고 사정률'), targetRate: readRate(fields.targetRate, '목표 투찰률(A)'), rangeMin: readRate(fields.rangeMin, '예가 변동폭 하한'), rangeMax: readRate(fields.rangeMax, '예가 변동폭 상한') };
      const result = calculateScenario(input);
      return { result, error: '' };
    } catch (error) { return { result: undefined, error: error instanceof Error ? error.message : '입력값을 확인해 주세요.' }; }
  }, [fields, mode]);
  const result = calculated.result;

  function update(key: keyof Fields, value: string) {
    setMessage('');
    setDraw(undefined); setSubmitError('');
    const monetary = ['baseAmount', 'aValue', 'plannedPrice', 'bidAmount'].includes(key);
    const formatted = monetary && /^[\d,]+$/.test(value) ? value.replaceAll(',', '').replace(/\B(?=(\d{3})+(?!\d))/g, ',') : value;
    setFields(previous => ({ ...previous, [key]: formatted }));
  }

  function loadExample() {
    setSeed(undefined);
    setDraw(undefined); setSubmitError('');
    setFields({ baseAmount: '134,541,000', aValue: '7,054,014', lowerRate: '89.745', plannedPrice: '134,323,075', bidAmount: '121,290,200', noticeRate: '100', targetRate: '89.745', rangeMin: '-3', rangeMax: '3' });
    setAttempted(true); setMessage('원본 엑셀의 예시값을 불러왔습니다. 실제 공고 조건으로 변경해 사용하세요.');
  }

  function submitCalculation() {
    setAttempted(true); setSubmitError(''); setMessage(''); setDraw(undefined);
    if (mode !== 'scenario') { setMessage(result ? '입력한 조건으로 계산했습니다.' : ''); return; }
    try {
      const selected = drawScenario({
        baseAmount: readWon(fields.baseAmount, '기초금액'), aValue: readWon(fields.aValue, 'A값'),
        lowerRate: readRate(fields.lowerRate, '낙찰하한율'), targetRate: readRate(fields.targetRate, '목표 투찰률(A)'),
        rangeMin: readRate(fields.rangeMin, '예가 변동폭 하한'), rangeMax: readRate(fields.rangeMax, '예가 변동폭 상한'),
      });
      setFields(previous => ({ ...previous, noticeRate: selected.noticeRate.toFixed(8) }));
      setDraw(selected);
      setMessage(`10,000개 후보 중 ${selected.candidateIndex + 1}번을 추첨했습니다. 선택 사정률 ${drawPercent(selected.noticeRate)}`);
    } catch (error) { setSubmitError(error instanceof Error ? error.message : '추첨할 입력값을 확인해 주세요.'); }
  }

  async function copyResult() {
    if (!result) return;
    const text = [mode === 'analysis' ? '개찰결과 분석' : '예상 투찰금액 계산', seed ? `${seed.title} (${seed.number}-${seed.revision})` : '', mode === 'scenario' && draw ? `무작위 추첨: 후보 10,000개 중 ${draw.candidateIndex + 1}번 / 선택 사정률 ${drawPercent(draw.noticeRate)}` : '', `기초금액: ${fields.baseAmount}원 / A값: ${fields.aValue}원 / 낙찰하한율: ${fields.lowerRate}%`, `예정가격${mode === 'scenario' ? '(가정)' : ''}: ${won(result.plannedPrice)}`, `투찰금액: ${won(result.bidAmount)}`, `하한 투찰금액(원 미만 올림): ${won(result.minimumBidAmount)}`, `단순 투찰률: ${percent(result.simpleBidRate)} / 투찰률(A): ${percent(result.adjustedBidRate)}`, `공고 사정률: ${mode === 'scenario' ? drawPercent(result.noticeRate) : percent(result.noticeRate)} / 업체 사정률: ${percent(result.companyRate)}`, `사정률 차이: ${difference(result.rateDifference)}`, '입력한 가격 조건의 비교 결과이며 순공사원가 98% 조건과 적격심사는 별도 확인합니다.'].filter(Boolean).join('\n');
    try { await navigator.clipboard.writeText(text); setMessage('계산 결과를 복사했습니다.'); }
    catch { setMessage('복사를 사용할 수 없습니다. 화면의 계산 결과를 선택해 복사해 주세요.'); }
  }

  function field(key: keyof Fields, label: string, unit: string, help?: string) {
    return <label className="bh-field" htmlFor={`${id}-${key}`}><span>{label}</span><div className="bh-input"><input id={`${id}-${key}`} value={fields[key]} onChange={event => update(key, event.target.value)} inputMode={unit === '원' ? 'numeric' : 'decimal'} autoComplete="off" maxLength={60} aria-describedby={help ? `${id}-${key}-help` : undefined} /><span aria-hidden="true">{unit}</span></div>{help && <small id={`${id}-${key}-help`}>{help}</small>}</label>;
  }

  return <section className="bid-helper" aria-labelledby={`${id}-title`}>
    <div className="bh-heading"><div><div className="eyebrow">입찰 가격 계산</div><h1 id={`${id}-title`}>투찰 도우미</h1><p>공고 조건과 가정 사정률을 입력해 투찰금액을 계산하고, 개찰결과를 비교하세요.</p></div><span className="bh-source"><Calculator size={16} />엑셀 계산식 기반</span></div>
    <div className="bh-tabs" role="tablist" aria-label="투찰 도우미 기능">{([{ key: 'scenario', label: '예상 투찰금액 계산' }, { key: 'analysis', label: '개찰결과 분석' }, { key: 'glossary', label: '입찰 용어 사전' }] as const).map((tab, index, tabs) => <button type="button" key={tab.key} id={`${id}-tab-${tab.key}`} role="tab" aria-selected={mode === tab.key} aria-controls={`${id}-panel-${tab.key}`} tabIndex={mode === tab.key ? 0 : -1} onClick={() => { setMode(tab.key); setAttempted(false); setMessage(''); setDraw(undefined); setSubmitError(''); }} onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length; setMode(tabs[next].key); setAttempted(false); setMessage(''); setDraw(undefined); setSubmitError(''); document.getElementById(`${id}-tab-${tabs[next].key}`)?.focus(); }}>{tab.key === 'glossary' && <BookOpen size={16} />}{tab.label}</button>)}</div>
    <div role="tabpanel" id={`${id}-panel-${mode}`} aria-labelledby={`${id}-tab-${mode}`} tabIndex={0}>
      {mode === 'glossary' ? <div className="bh-glossary panel"><h2>입찰 용어 사전</h2><p>원본 엑셀의 {BID_GLOSSARY.length}개 용어를 검색할 수 있습니다.</p><label className="bh-glossary-search">용어 검색<input value={glossarySearch} onChange={event => setGlossarySearch(event.target.value)} placeholder="예: 사정률, A값, 낙찰하한율" /></label><dl>{BID_GLOSSARY.filter(item => `${item.term} ${item.description}`.includes(glossarySearch.trim())).map(item => <div key={item.term}><dt>{item.term}</dt><dd>{item.description}</dd></div>)}</dl>{!BID_GLOSSARY.some(item => `${item.term} ${item.description}`.includes(glossarySearch.trim())) && <p role="status">검색한 용어가 없습니다.</p>}</div> : <>
        {seed && <div className="bh-notice panel"><strong>{seed.title}</strong><span>공고번호 {seed.number} · {seed.revision}차수</span><p>공개된 항목을 계산용으로 가져왔습니다. 빈 항목과 적용 조건을 확인해 주세요.</p>{seed.netCost !== undefined && <p>순공사원가 {won(seed.netCost)} · 참고 금액</p>}{seed.notes.map((note, index) => <p key={index}>{note}</p>)}</div>}
        <div className="bh-workspace">
          <form className="bh-form panel" noValidate onSubmit={event => { event.preventDefault(); submitCalculation(); }}>
            <div className="bh-section-heading"><h2>공고 조건</h2><button type="button" className="text-button" onClick={loadExample}>원본 예시 불러오기</button></div>
            <div className="bh-fields">{field('baseAmount', '기초금액', '원', '추정가격과 다릅니다. 공고에 공개된 기초금액을 입력하세요.')}{field('aValue', 'A값', '원', '공고에서 확인한 적용 A값. 미적용이면 0을 입력하세요.')}{field('lowerRate', '낙찰하한율', '%', '공고의 적용 하한율을 입력하세요. 예시: 89.745')}</div>
            <h2>{mode === 'scenario' ? '계산할 가정' : '개찰 자료'}</h2>
            <div className="bh-fields">{mode === 'scenario' ? <>{field('noticeRate', '가정 공고 사정률', '%', '계산하기를 누르면 추첨한 사정률로 자동 입력됩니다. 직접 수정할 수도 있습니다.')}{field('targetRate', '목표 투찰률(A)', '%', 'A값을 제외한 목표 비율입니다. 하한율을 다시 곱하지 않습니다.')}<div className="bh-range">{field('rangeMin', '예가 변동폭 하한', '%')}{field('rangeMax', '예가 변동폭 상한', '%')}</div><p className="bh-help">기본 변동폭 −3%~+3%는 원본 예시 설정입니다. 해당 공고의 범위로 변경하세요.</p></> : <>{field('plannedPrice', '개찰 예정가격', '원', '개찰 후 공개된 실제 예정가격입니다.')}{field('bidAmount', '실제 투찰금액', '원')}</>}</div>
            <div className="bh-form-actions"><button type="submit" className="button button-primary"><Calculator size={17} />계산하기</button><button type="button" className="button button-secondary" onClick={() => { setSeed(undefined); setFields({ ...EMPTY }); setDraw(undefined); setSubmitError(''); setAttempted(false); setMessage('입력값을 초기화했습니다.'); }}><RotateCcw size={15} />초기화</button></div>
            <p className="bh-help">{storageFailed ? '이 브라우저에서 임시 저장을 사용할 수 없습니다.' : '입력값은 이 브라우저 탭에 임시 저장됩니다.'}</p>
            {attempted && (submitError || calculated.error) && <p className="bh-error" role="alert">{submitError || calculated.error}</p>}
          </form>
          <div className="bh-results">
            <section className="bh-result-hero panel" aria-label="투찰금액 계산 결과"><div className="bh-section-heading"><h2>{mode === 'scenario' ? '계산 투찰금액' : '실제 투찰금액'}</h2><button type="button" className="text-button" onClick={() => { void copyResult(); }} disabled={!result}><Copy size={15} />결과 복사</button></div><div aria-live="polite" aria-atomic="true"><strong className="bh-big-result">{result ? won(result.bidAmount) : '입력 후 계산'}</strong><p>{mode === 'scenario' ? (draw ? '추첨 사정률로 계산 · 원 미만 올림' : '입력한 가정으로 계산 · 원 미만 올림') : '입력한 개찰 자료를 기준으로 분석'}</p></div>{!result && <p className="bh-empty">공고 조건과 {mode === 'scenario' ? '계산할 가정' : '개찰 자료'}을 입력하면 계산 결과가 표시됩니다.</p>}
              {result && <><div className="bh-checks"><span className={result.meetsLowerRate ? 'is-met' : 'is-unmet'}>{result.meetsLowerRate && <Check size={14} />}{result.meetsLowerRate ? '낙찰하한율 이상' : '낙찰하한율 미만'}</span><span className={result.withinPlannedPrice ? 'is-met' : 'is-unmet'}>{result.withinPlannedPrice && <Check size={14} />}{result.withinPlannedPrice ? '예정가격 이하' : '예정가격 초과'}</span></div>{'withinRange' in result && result.withinRange === false && <p className="bh-error" role="alert">가정 공고 사정률이 입력한 예가 변동폭을 벗어났습니다.</p>}</>}
            </section>
            {mode === 'scenario' && <section className="bh-draw panel" aria-labelledby={`${id}-draw-title`}>
              <div className="bh-section-heading"><h2 id={`${id}-draw-title`}>사정률 무작위 추첨</h2><span className="bh-draw-badge"><Shuffle size={14} />10,000개 중 1개</span></div>
              <p>입력한 예가 범위 안의 사정률 후보 10,000개 중 하나를 같은 확률로 선택합니다.</p>
              <div className="bh-draw-output" aria-live="polite" aria-atomic="true">{draw ? <>
                <span className="bh-draw-label">선택된 사정률</span><strong className="bh-draw-rate">{drawPercent(draw.noticeRate)}</strong>
                <dl className="bh-draw-amounts"><div><dt>가정 예정가격</dt><dd>{won(draw.result.plannedPrice)}</dd></div><div><dt>계산 투찰금액</dt><dd>{won(draw.result.bidAmount)}</dd></div></dl>
                <p className="bh-draw-caption">후보 {(draw.candidateIndex + 1).toLocaleString('ko-KR')}번 선택 · 계산하기를 다시 누르면 새로 추첨합니다.</p>
              </> : <p className="bh-draw-empty">‘계산하기’를 누르면 추첨 결과가 여기에 표시됩니다.</p>}</div>
              <p className="bh-draw-note">범위 안에서 무작위로 선택한 가정값입니다.</p>
            </section>}
            {result && <><section className="bh-metrics panel" aria-label="가격과 사정률 분석"><dl><div><dt>{mode === 'scenario' ? '가정 예정가격' : '개찰 예정가격'}</dt><dd>{won(result.plannedPrice)}</dd></div><div><dt>하한 투찰금액<small>원 미만 올림</small></dt><dd>{won(result.minimumBidAmount)}</dd></div><div><dt>단순 투찰률<small>투찰금액 ÷ 예정가격</small></dt><dd>{percent(result.simpleBidRate)}</dd></div><div><dt>투찰률(A)<small>(투찰금액 − A) ÷ (예정가격 − A)</small></dt><dd>{percent(result.adjustedBidRate)}</dd></div><div><dt>공고 사정률<small>예정가격 ÷ 기초금액</small></dt><dd>{mode === 'scenario' ? drawPercent(result.noticeRate) : percent(result.noticeRate)}</dd></div><div><dt>업체 사정률<small>하한율로 역산한 회사의 기준</small></dt><dd>{percent(result.companyRate)}</dd></div><div className="bh-metric-wide"><dt>업체 − 공고 사정률 차이</dt><dd>{difference(result.rateDifference)}</dd></div></dl></section>
              <details className="bh-formulas panel"><summary>계산식과 반올림 기준 보기</summary><dl><div><dt>가정 예정가격</dt><dd>기초금액 × 공고 사정률 ÷ 100</dd></div><div><dt>예상 투찰금액</dt><dd>(예정가격 − A값) × 목표 투찰률(A) ÷ 100 + A값</dd></div><div><dt>하한 투찰금액</dt><dd>(예정가격 − A값) × 낙찰하한율 ÷ 100 + A값</dd></div><div><dt>업체 사정률</dt><dd>((투찰금액 − A값) ÷ (낙찰하한율 ÷ 100) + A값) ÷ 기초금액 × 100</dd></div></dl><p>가정 예정가격은 중간 반올림 없이 계산하며, 투찰금액과 하한 투찰금액만 원 미만 올림합니다. 분석 비율은 소수 6자리, 추첨 사정률은 소수 8자리까지 표시하며 조건 비교에는 반올림 전 값을 사용합니다.</p></details>
            </>}
            <div className="bh-note"><Info size={18} /><p>실제 예정가격은 개찰 전 확정할 수 없습니다. 이 계산은 입력한 가격 조건의 비교이며, 순공사원가 98% 조건·적격심사·최종 낙찰 여부는 판정하지 않습니다. 적용 A값과 하한율은 해당 공고를 확인하세요.</p></div>
          </div>
        </div>
      </>}
    </div>
    <p className="bh-feedback" role="status">{message}</p>
  </section>;
}
