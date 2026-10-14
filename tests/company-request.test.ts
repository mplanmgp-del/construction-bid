import { describe, expect, it } from 'vitest';
import { createCompanyRequestGate } from '../src/company/company-request';

describe('shared live company request gate', () => {
  it('allows two sources at a time and releases their slots on completion or failure', async () => {
    const gate = createCompanyRequestGate(2);
    const started: number[] = [];
    let first!: () => void, second!: (error: Error) => void;
    const a = gate.run(() => { started.push(1); return new Promise<void>(resolve => { first = resolve; }); });
    const b = gate.run(() => { started.push(2); return new Promise<void>((_, reject) => { second = reject; }); }).catch(() => undefined);
    const c = gate.run(async () => { started.push(3); return 3; });
    const d = gate.run(async () => { started.push(4); return 4; });
    await Promise.resolve(); expect(started).toEqual([1, 2]);
    second(new Error('provider failure')); await b; await c; expect(await d).toBe(4);
    expect(started).toEqual([1, 2, 3, 4]);
    first(); await a;
  });
  it('removes aborted waiting work without ever invoking its provider request', async () => {
    const gate = createCompanyRequestGate(1), controller = new AbortController();
    let release!: () => void, called = false;
    const active = gate.run(() => new Promise<void>(resolve => { release = resolve; }));
    const skipped = gate.run(async () => { called = true; }, controller.signal).catch(error => error.name);
    controller.abort(); expect(await skipped).toBe('AbortError');
    await Promise.resolve(); release(); await active;
    expect(await gate.run(async () => 'next')).toBe('next'); expect(called).toBe(false);
  });
});
