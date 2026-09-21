import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { availabilityOf, groupIncidents, SLA_TARGET } from '../src/stats.ts';
import type { ImpairedCheck } from '../src/stats.ts';

const down = (ts: string, serviceId = 'svc-auth'): ImpairedCheck => ({
  serviceId,
  serviceName: serviceId.replace('svc-', '') + '-api',
  ts,
  state: 'down',
});

const slow = (ts: string, serviceId = 'svc-auth'): ImpairedCheck => ({
  ...down(ts, serviceId),
  state: 'degraded',
});

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
      [down('2025-04-22T04:00:00Z'), down('2025-04-22T04:15:00Z'), down('2025-04-22T04:30:00Z')],
      15,
    );
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].start, '2025-04-22T04:00:00Z');
    assert.equal(incidents[0].end, '2025-04-22T04:45:00Z');
    assert.equal(incidents[0].durationMinutes, 45);
    assert.equal(incidents[0].failedChecks, 3);
    assert.equal(incidents[0].degradedChecks, 0);
  });

  test('a slow but successful check holds a flapping outage together', () => {
    // This is the shape of the seeded reports-api outage: 5xx, 5xx, a 200 that
    // took 3x the median, then 5xx again. Grouping only the failures would
    // report two unrelated blips instead of one continuous degradation.
    const incidents = groupIncidents(
      [
        down('2025-05-13T16:00:00Z'),
        down('2025-05-13T16:15:00Z'),
        slow('2025-05-13T16:30:00Z'),
        down('2025-05-13T16:45:00Z'),
        slow('2025-05-13T17:00:00Z'),
        down('2025-05-13T17:15:00Z'),
      ],
      15,
    );
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].durationMinutes, 90);
    assert.equal(incidents[0].failedChecks, 4);
    assert.equal(incidents[0].degradedChecks, 2);
  });

  test('a slow patch with no failure at all is not called an outage', () => {
    const incidents = groupIncidents(
      [slow('2025-04-22T04:00:00Z'), slow('2025-04-22T04:15:00Z'), slow('2025-04-22T04:30:00Z')],
      15,
    );
    assert.deepEqual(incidents, []);
  });

  test('discards an isolated failure as noise', () => {
    assert.deepEqual(groupIncidents([down('2025-04-22T04:00:00Z')], 15), []);
  });

  test('splits a run when the checks are not adjacent', () => {
    const incidents = groupIncidents(
      [
        down('2025-04-22T04:00:00Z'),
        down('2025-04-22T04:15:00Z'),
        down('2025-04-22T09:00:00Z'),
        down('2025-04-22T09:15:00Z'),
      ],
      15,
    );
    assert.equal(incidents.length, 2);
  });

  test('never merges failures from two different services', () => {
    const incidents = groupIncidents(
      [
        down('2025-04-22T04:00:00Z', 'svc-auth'),
        down('2025-04-22T04:15:00Z', 'svc-auth'),
        down('2025-04-22T04:30:00Z', 'svc-search'),
        down('2025-04-22T04:45:00Z', 'svc-search'),
      ],
      15,
    );
    assert.equal(incidents.length, 2);
    assert.deepEqual(incidents.map((i) => i.serviceId).sort(), ['svc-auth', 'svc-search']);
  });

  test('ranks the longest outage first, which is what an on-call engineer opens', () => {
    const incidents = groupIncidents(
      [
        down('2025-04-22T04:00:00Z'),
        down('2025-04-22T04:15:00Z'),
        down('2025-04-22T20:00:00Z'),
        down('2025-04-22T20:15:00Z'),
        down('2025-04-22T20:30:00Z'),
        down('2025-04-22T20:45:00Z'),
      ],
      15,
    );
    assert.equal(incidents[0].failedChecks, 4);
  });

  test('one healthy check does not end an outage that resumes straight after', () => {
    // The auth-api outage did exactly this: it returned a single normal 200
    // mid-outage and then failed for hours more.
    const incidents = groupIncidents(
      [down('2025-04-22T04:00:00Z'), down('2025-04-22T04:15:00Z'), down('2025-04-22T04:45:00Z')],
      15,
    );
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].durationMinutes, 60);
    assert.equal(incidents[0].failedChecks, 3);
  });

  test('two healthy checks in a row do end it', () => {
    // 04:15 then 05:00 is a 45 minute gap - a full half hour of recovery -
    // so these are two separate events, and neither reaches two checks.
    const incidents = groupIncidents(
      [down('2025-04-22T04:00:00Z'), down('2025-04-22T04:15:00Z'), down('2025-04-22T05:00:00Z')],
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
