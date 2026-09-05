import { describe, it, expect } from 'vitest';
import { buildAutomationReport, type RawRun } from './report';

const run = (over: Partial<RawRun> = {}): RawRun => ({
  id: 'r1',
  status: 'success',
  trigger_event: 'new_contact_created',
  created_at: '2026-09-01T10:00:00.000Z',
  error_message: null,
  steps: [],
  contact: { id: 'c1', name: 'Sonu', phone: '+918208103317' },
  nextRunAt: null,
  ...over,
});

describe('buildAutomationReport', () => {
  it('counts an empty history without dividing by zero', () => {
    const r = buildAutomationReport([]);
    expect(r.stats.totalRuns).toBe(0);
    expect(r.stats.successRate).toBe(0);
    expect(r.stats.nextRunAt).toBeNull();
  });

  // The distinction the whole report exists for: the engine writes
  // "partial" when it parks at a Wait, so a healthy drip mid-sequence
  // must read as waiting, not as a failure.
  it('reads a parked run as waiting, not failed', () => {
    const r = buildAutomationReport([
      run({ id: 'a', status: 'partial', nextRunAt: '2026-09-03T10:00:00.000Z' }),
    ]);
    expect(r.runs[0].outcome).toBe('waiting');
    expect(r.stats.waiting).toBe(1);
    expect(r.stats.failed).toBe(0);
    expect(r.stats.nextRunAt).toBe('2026-09-03T10:00:00.000Z');
  });

  // A run that resumed inside a condition branch keeps status "partial"
  // for good (appendResults passes a null status for nested scopes), so
  // with nothing queued it has to count as finished.
  it('treats partial with no queued resume as completed', () => {
    const r = buildAutomationReport([run({ status: 'partial', nextRunAt: null })]);
    expect(r.runs[0].outcome).toBe('completed');
    expect(r.stats.completed).toBe(1);
  });

  it('excludes waiting runs from the success rate', () => {
    const r = buildAutomationReport([
      run({ id: 'a', status: 'success' }),
      run({ id: 'b', status: 'failed' }),
      run({ id: 'c', status: 'partial', nextRunAt: '2026-09-09T10:00:00.000Z' }),
    ]);
    // 1 completed of 2 decided — the waiting one must not drag it to 33%.
    expect(r.stats.successRate).toBe(50);
  });

  it('counts only message steps that actually succeeded', () => {
    const r = buildAutomationReport([
      run({
        steps: [
          { step_type: 'send_template', status: 'success' },
          { step_type: 'send_message', status: 'success' },
          { step_type: 'send_message', status: 'failed', detail: 'no window' },
          { step_type: 'add_tag', status: 'success' },
          { step_type: 'wait', status: 'success' },
        ],
      }),
    ]);
    expect(r.stats.messagesSent).toBe(2);
    expect(r.runs[0].failedStep).toBe('send_message');
  });

  it('counts each contact once however many times it ran', () => {
    const c = { id: 'c1', name: 'Sonu', phone: '+918208103317' };
    const r = buildAutomationReport([
      run({ id: 'a', contact: c }),
      run({ id: 'b', contact: c }),
      run({ id: 'd', contact: { id: 'c2', name: null, phone: '+919999999999' } }),
    ]);
    expect(r.stats.totalRuns).toBe(3);
    expect(r.stats.contactsReached).toBe(2);
  });

  it('ranks failure reasons and prefers the step detail over the run message', () => {
    const r = buildAutomationReport([
      run({
        id: 'a',
        status: 'failed',
        error_message: 'step failed',
        steps: [{ step_type: 'add_tag', status: 'failed', detail: 'add_tag needs contact + tag_id' }],
        created_at: '2026-09-01T10:00:00.000Z',
      }),
      run({
        id: 'b',
        status: 'failed',
        error_message: 'step failed',
        steps: [{ step_type: 'add_tag', status: 'failed', detail: 'add_tag needs contact + tag_id' }],
        created_at: '2026-09-02T10:00:00.000Z',
      }),
      run({
        id: 'c',
        status: 'failed',
        error_message: 'template not approved',
        steps: [],
      }),
    ]);
    expect(r.topErrors[0]).toEqual({
      message: 'add_tag needs contact + tag_id',
      count: 2,
      lastSeenAt: '2026-09-02T10:00:00.000Z',
    });
    expect(r.topErrors[1].message).toBe('template not approved');
  });

  it('surfaces the worst step type first', () => {
    const r = buildAutomationReport([
      run({
        steps: [
          { step_type: 'send_template', status: 'failed', detail: 'x' },
          { step_type: 'add_tag', status: 'success' },
        ],
      }),
    ]);
    expect(r.stepBreakdown[0].stepType).toBe('send_template');
    expect(r.stepBreakdown[0].failed).toBe(1);
  });

  it('buckets runs by day, oldest first', () => {
    const r = buildAutomationReport([
      run({ id: 'a', created_at: '2026-09-02T09:00:00.000Z' }),
      run({ id: 'b', created_at: '2026-09-01T09:00:00.000Z' }),
      run({ id: 'c', created_at: '2026-09-01T18:00:00.000Z', status: 'failed' }),
    ]);
    expect(r.daily).toEqual([
      { date: '2026-09-01', total: 2, failed: 1 },
      { date: '2026-09-02', total: 1, failed: 0 },
    ]);
  });
});
