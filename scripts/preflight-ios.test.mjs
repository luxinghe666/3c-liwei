import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripConfigComment, resolveBuildValue, releaseURLProblem, readConfig, inspectPNG } from './preflight-ios.mjs';

test('xcconfig escaped URL survives comments and resolves; plain // is not silently accepted', () => {
  assert.equal(resolveBuildValue(stripConfigComment('https:/$()/finance.yuantuo.vip // ready').trim(), {}), 'https://finance.yuantuo.vip');
  assert.ok(releaseURLProblem(stripConfigComment('https://finance.yuantuo.vip')));
  assert.equal(stripConfigComment('"https://finance.yuantuo.vip" // comment').trim(), '"https://finance.yuantuo.vip"');
});

test('missing and unsafe release endpoints remain blocked', () => {
  for (const url of ['', 'http://finance.yuantuo.vip', 'https://localhost', 'https://127.0.0.1', 'https://example.com', 'https://finance.yuantuo.vip.evil.test', 'https://finance.yuantuo.vip:4318', 'https://boss:password@finance.yuantuo.vip', 'https://finance.yuantuo.vip/?token=secret', 'https://finance.yuantuo.vip/#overview', 'https://finance.yuantuo.vip/api', '$(FINANCE_SERVER_URL)']) {
    assert.ok(releaseURLProblem(url), `must block ${url}`);
  }
  assert.equal(releaseURLProblem('https://finance.yuantuo.vip'), null);
  assert.equal(releaseURLProblem('https://finance.yuantuo.vip:443/'), null);
});

test('build expansion preserves unknown and cyclic references instead of inventing values', () => {
  assert.equal(resolveBuildValue('$(A)', { A: '${B}', B: 'value' }), 'value');
  assert.equal(resolveBuildValue('$(A)', { A: '$(B)', B: '$(A)' }), '$(A)');
  assert.equal(resolveBuildValue('$(MISSING)', {}), '$(MISSING)');
});

test('xcconfig include order, missing optional include and cycles are handled safely', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuantuo-preflight-'));
  try {
    writeFileSync(join(root, 'Release.xcconfig'), 'DEVELOPMENT_TEAM = TEAM\nFINANCE_SERVER_URL = https:/$()/finance.yuantuo.vip\n');
    writeFileSync(join(root, 'Production.xcconfig'), '#include? "absent.xcconfig"\n#include "Release.xcconfig"\nDEVELOPMENT_TEAM = OVERRIDE\n');
    assert.equal(readConfig(join(root, 'Production.xcconfig'), root).DEVELOPMENT_TEAM, 'OVERRIDE');
    writeFileSync(join(root, 'Release.xcconfig'), '#include "Production.xcconfig"\n');
    assert.throws(() => readConfig(join(root, 'Production.xcconfig'), root), /循环/);
    writeFileSync(join(root, 'Production.xcconfig'), '#include? "../outside.xcconfig"\n');
    assert.throws(() => readConfig(join(root, 'Production.xcconfig'), root), /目录之外/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function png(colorType, transparent = false) {
  const chunk = (type, data = Buffer.alloc(0)) => {
    const header = Buffer.alloc(8); header.writeUInt32BE(data.length); header.write(type, 4);
    return Buffer.concat([header, data, Buffer.alloc(4)]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1024); header.writeUInt32BE(1024, 4); header[8] = 8; header[9] = colorType;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), ...(transparent ? [chunk('tRNS', Buffer.from([0]))] : []), chunk('IEND')]);
}

test('PNG guard detects alpha channels, indexed transparency and truncated files', () => {
  assert.deepEqual(inspectPNG(png(2)), { width: 1024, height: 1024, alpha: false });
  assert.equal(inspectPNG(png(6)).alpha, true);
  assert.equal(inspectPNG(png(3, true)).alpha, true);
  assert.throws(() => inspectPNG(png(2).subarray(0, 20)), /有效|完整/);
  assert.throws(() => inspectPNG(png(2).subarray(0, 33)), /结束/);
});
