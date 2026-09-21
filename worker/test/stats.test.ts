import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { availabilityOf, groupIncidents, SLA_TARGET } from '../src/stats.ts';

const svc = (ts: string) => ({ serviceId: 'svc-auth', serviceName: 'auth-api', ts });

describe('availabilityOf', () => {
  test('is the share of evaluated checks that succeeded', () => {
    assert.equal(availabilityOf(99, 1), 0.99);
  });

  test('ignores unknown readings by never receiving them', () => {
    // 2850 up, 30 down out of 2880 evaluated - the 999 rows are not passed in.
    assert.ok(availabilityOf(2850, 30)! < SLA_TARGET);
  });

  test('is null rather than zero when there is nothing to evaluate', () => {
    assert.equal(availabilityOf(0, 0), null);
  });

  test('a perfect window meets the target', () => {
    assert.ok(availabilityOf(2880, 0)! >= SLA_TARGET);
  });
});

describe('groupIncidents', () => {
  test('joins consecutive failures into one incident and extends it by one interval', () => {
    const incidents = groupIncidents(
      [svc('2025-04-22T04:00:00Z'), svc('2025-04-22T04:15:00Z'), svc('2025-04-22T04:30:00Z')],
      15,
    );
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].start, '2025-04-22T04:00:00Z');
    assert.equal(incidents[0].end, '2025-04-22T04:45:00Z');
    assert.equal(incidents[0].durationMinutes, 45);
    assert.equal(incidents[0].failedChecks, 3);
  });

  test('discards an isolated failure as noise', () => {
    assert.deepEqual(groupIncidents([svc('2025-04-22T04:00:00Z')], 15), []);
  });

  test('splits a run when the failures are not adjacent', () => {
    const incidents = groupIncidents(
      [
        svc('2025-04-22T04:00:00Z'),
        svc('2025-04-22T04:15:00Z'),
        svc('2025-04-22T09:00:00Z'),
        svc('2025-04-22T09:15:00Z'),
      ],
      15,
    );
    assert.equal(incidents.length, 2);
  });

  test('never merges failures from two different services', () => {
    const incidents = groupIncidents(
      [
        { serviceId: 'svc-auth', serviceName: 'auth-api', ts: '2025-04-22T04:00:00Z' },
        { serviceId: 'svc-auth', serviceName: 'auth-api', ts: '2025-04-22T04:15:00Z' },
        { serviceId: 'svc-search', serviceName: 'search-api', ts: '2025-04-22T04:30:00Z' },
        { serviceId: 'svc-search', serviceName: 'search-api', ts: '2025-04-22T04:45:00Z' },
      ],
      15,
    );
    assert.equal(incidents.length, 2);
    assert.deepEqual(
      incidents.map((i) => i.serviceId).sort(),
      ['svc-auth', 'svc-search'],
    );
  });

  test('ranks the longest outage first, which is what an on-call engineer opens', () => {
    const incidents = groupIncidents(
      [
        svc('2025-04-22T04:00:00Z'),
        svc('2025-04-22T04:15:00Z'),
        svc('2025-04-22T20:00:00Z'),
        svc('2025-04-22T20:15:00Z'),
        svc('2025-04-22T20:30:00Z'),
        svc('2025-04-22T20:45:00Z'),
      ],
      15,
    );
    assert.equal(incidents[0].failedChecks, 4);
  });

  test('a gap wider than one interval ends the incident', () => {
    // 04:00 and 04:15 fail, 04:30 is never reported, 04:45 fails again.
    // We define an incident as *consecutive* failed checks, so this is one
    // 30 minute incident plus a lone failure that does not qualify. Being
    // strict keeps the rule explainable; the deduped data has no gaps, so it
    // changes nothing here. A configurable gap tolerance is listed in the
    // README as future work.
    const incidents = groupIncidents(
      [svc('2025-04-22T04:00:00Z'), svc('2025-04-22T04:15:00Z'), svc('2025-04-22T04:45:00Z')],
      15,
    );
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].durationMinutes, 30);
    assert.equal(incidents[0].failedChecks, 2);
  });

  test('handles an empty window', () => {
    assert.deepEqual(groupIncidents([], 15), []);
  });
});
