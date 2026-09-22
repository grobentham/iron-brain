import test from 'node:test';
import assert from 'node:assert/strict';
import { calibratePriceAxis, priceForPermille, rr, validateGeometry } from '../lib/grounding.js';

test('calibrates a descending right-side price axis and rejects an outlier', () => {
  const samples = [
    { y: .12, price: 21040, raw: '21040' },
    { y: .28, price: 21020, raw: '21020' },
    { y: .44, price: 21000, raw: '21000' },
    { y: .60, price: 20980, raw: '20980' },
    { y: .76, price: 20960, raw: '20960' },
    { y: .50, price: 22444, raw: '22444' },
  ];
  const c = calibratePriceAxis(samples);
  assert.equal(c.strong, true);
  assert.ok(c.r2 > .999);
  assert.equal(priceForPermille(c, 440), 21000);
});

test('refuses weak price calibration', () => {
  const c = calibratePriceAxis([{ y: .2, price: 21000, raw:'21000' }, { y: .4, price: 20980, raw:'20980' }]);
  assert.equal(c.strong, false);
});

test('validates only correct long and short price geometry', () => {
  assert.equal(validateGeometry('LONG', 21000, 20980, 21040), true);
  assert.equal(validateGeometry('SHORT', 21000, 21020, 20960), true);
  assert.equal(validateGeometry('LONG', 21000, 21020, 20960), false);
  assert.equal(rr('LONG', 21000, 20980, 21040), 2);
});
