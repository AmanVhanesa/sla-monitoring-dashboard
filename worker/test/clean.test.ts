import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitCsvLine,
  parseTimestamp,
  parseLatency,
  parseStatus,
  precedence,
  cleanChunk,
} from '../src/clean.ts';

describe('splitCsvLine', () => {
  test('splits a plain row and trims whitespace', () => {
    assert.deepEqual(splitCsvLine('a, b ,c'), ['a', 'b', 'c']);
  });

  test('keeps commas that live inside a quoted field', () => {
    assert.deepEqual(splitCsvLine('svc-auth,"Mumbai, India",200'), [
      'svc-auth',
      'Mumbai, India',
      '200',
    ]);
  });

  test('unescapes a doubled quote', () => {
    assert.deepEqual(splitCsvLine('a,"say ""hi""",b'), ['a', 'say "hi"', 'b']);
  });

  test('preserves empty fields so column positions do not shift', () => {
    assert.deepEqual(splitCsvLine('a,,c'), ['a', '', 'c']);
  });
});

describe('parseTimestamp', () => {
  test('reads ISO-8601 UTC', () => {
    const result = parseTimestamp('2025-05-13T12:45:00Z');
    assert.equal(result?.iso, '2025-05-13T12:45:00Z');
    assert.equal(result?.day, '2025-05-13');
    assert.equal(result?.format, 'iso_utc');
  });

  test('reads Unix epoch seconds', () => {
    const result = parseTimestamp('1746938700');
    assert.equal(result?.iso, '2025-05-11T04:45:00Z');
    assert.equal(result?.format, 'epoch');
  });

  test('converts a +05:30 offset to UTC instead of dropping it', () => {
    // 18:00 IST is 12:30 UTC. Ignoring the offset would file this check in the
    // 18:00 slot, which is both the wrong slot and sometimes the wrong day.
    const result = parseTimestamp('2025-05-13T18:00:00+05:30');
    assert.equal(result?.iso, '2025-05-13T12:30:00Z');
    assert.equal(result?.format, 'iso_offset');
  });

  test('an offset that crosses midnight lands on the correct UTC day', () => {
    const result = parseTimestamp('2025-05-14T04:00:00+05:30');
    assert.equal(result?.iso, '2025-05-13T22:30:00Z');
    assert.equal(result?.day, '2025-05-13');
  });

  test('pins a zone-less timestamp to UTC rather than the local clock', () => {
    const result = parseTimestamp('2025-05-13T12:45:00');
    assert.equal(result?.iso, '2025-05-13T12:45:00Z');
    assert.equal(result?.format, 'assumed_utc');
  });

  test('rejects junk and implausible dates', () => {
    assert.equal(parseTimestamp(''), null);
    assert.equal(parseTimestamp('not-a-date'), null);
    assert.equal(parseTimestamp('1899-01-01T00:00:00Z'), null);
  });
});

describe('parseLatency', () => {
  test('leaves milliseconds alone', () => {
    assert.deepEqual(parseLatency('707', 'ms'), { ms: 707, flag: 'ok', converted: false });
  });

  test('converts seconds to milliseconds', () => {
    assert.deepEqual(parseLatency('0.717', 's'), { ms: 717, flag: 'ok', converted: true });
  });

  test('flags a missing value instead of reading it as zero', () => {
    assert.deepEqual(parseLatency('', 'ms'), { ms: null, flag: 'missing', converted: false });
  });

  test('discards a negative latency', () => {
    const result = parseLatency('-286', 'ms');
    assert.equal(result.ms, null);
    assert.equal(result.flag, 'negative');
  });

  test('flags a non-numeric value', () => {
    assert.equal(parseLatency('fast', 'ms').flag, 'unparseable');
  });
});

describe('parseStatus', () => {
  test('2xx is up', () => {
    assert.deepEqual(parseStatus('200'), { code: 200, outcome: 'up', valid: true });
  });

  test('5xx is down', () => {
    for (const code of ['500', '502', '503']) {
      assert.equal(parseStatus(code).outcome, 'down', `${code} should be down`);
    }
  });

  test('4xx is a client error, not provider downtime', () => {
    assert.equal(parseStatus('404').outcome, 'up');
  });

  test('999 is not an HTTP code, so it is unknown rather than down', () => {
    const result = parseStatus('999');
    assert.equal(result.outcome, 'unknown');
    assert.equal(result.valid, false);
  });
});

describe('precedence', () => {
  test('a real failure outranks a success, and both outrank an unusable reading', () => {
    assert.ok(precedence('down') > precedence('up'));
    assert.ok(precedence('up') > precedence('unknown'));
  });
});

describe('cleanChunk', () => {
  const header = 'service_id,service_name,timestamp,status_code,latency,latency_unit,agent,region';

  test('cleans a mixed chunk and counts every issue it found', () => {
    const csv = [
      header,
      'svc-auth,auth-api,2025-05-13T12:45:00Z,200,181,ms,agent-1,ap-south-1',
      'svc-search,search-api,1746938700,200,0.717,s,agent-1,ap-south-1',
      'svc-notify,notify-worker,2025-05-13T18:00:00+05:30,503,,ms,agent-2,ap-south-1',
      'svc-payments,payments-api,2025-05-13T22:30:00Z,999,389,ms,agent-1,ap-south-1',
      'svc-reports,reports-api,2025-05-13T13:00:00Z,200,-223,ms,agent-1,ap-south-1',
    ].join('\n');

    const { rows, counters, rejected } = cleanChunk(csv);

    assert.equal(counters.received, 5);
    assert.equal(counters.accepted, 5);
    assert.equal(rejected.length, 0);

    assert.equal(counters.tsIsoUtc, 3);
    assert.equal(counters.tsEpoch, 1);
    assert.equal(counters.tsOffset, 1);

    assert.equal(counters.latencyConverted, 1);
    assert.equal(counters.latencyMissing, 1);
    assert.equal(counters.latencyNegative, 1);
    assert.equal(counters.statusInvalid, 1);

    assert.equal(counters.outcomeUp, 3);
    assert.equal(counters.outcomeDown, 1);

    assert.equal(rows[1].latencyMs, 717, 'seconds should have become milliseconds');
    assert.equal(rows[1].latencyRaw, '0.717', 'the original reading is kept for audit');
    assert.equal(rows[2].ts, '2025-05-13T12:30:00Z');
    assert.equal(rows[3].outcome, 'unknown');
    assert.equal(rows[4].latencyMs, null);
  });

  test('rejects rows it cannot trust but keeps processing the rest', () => {
    const csv = [
      header,
      ',auth-api,2025-05-13T12:45:00Z,200,181,ms,agent-1,ap-south-1',
      'svc-auth,auth-api,garbage,200,181,ms,agent-1,ap-south-1',
      'svc-auth,auth-api,2025-05-13T12:45:00Z,200,181,ms,agent-1,ap-south-1',
    ].join('\n');

    const { rows, counters, rejected } = cleanChunk(csv);

    assert.equal(counters.received, 3);
    assert.equal(counters.accepted, 1);
    assert.equal(counters.rejected, 2);
    assert.equal(rows.length, 1);
    assert.deepEqual(
      rejected.map((r) => r.reason),
      ['missing service_id', 'unparseable timestamp'],
    );
  });

  test('refuses a CSV that is missing a column the SLA maths depends on', () => {
    assert.throws(
      () => cleanChunk('service_id,latency\nsvc-auth,181'),
      /missing the required "timestamp" column/,
    );
  });

  test('falls back to the service id when the friendly name is blank', () => {
    const { rows } = cleanChunk(`${header}\nsvc-auth,,2025-05-13T12:45:00Z,200,181,ms,agent-1,ap`);
    assert.equal(rows[0].serviceName, 'svc-auth');
  });

  test('ignores blank lines and a trailing newline', () => {
    const csv = `${header}\nsvc-auth,auth-api,2025-05-13T12:45:00Z,200,181,ms,agent-1,ap\n\n`;
    assert.equal(cleanChunk(csv).counters.received, 1);
  });
});
