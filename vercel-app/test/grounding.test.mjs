import test from 'node:test';
import assert from 'node:assert/strict';
import { calibratePriceAxis, parseHocrPriceSamples, priceForPermille, rr, validateGeometry } from '../lib/grounding.js';

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
  assert.ok(c.quality >= 90);
  assert.equal(priceForPermille(c, 440), 21000);
});

test('refuses weak price calibration', () => {
  const c = calibratePriceAxis([
    { y: .2, price: 21000, raw:'21000' },
    { y: .4, price: 20980, raw:'20980' },
  ]);
  assert.equal(c.strong, false);
});

test('rejects OCR prices that are not aligned to the 0.25 futures tick', () => {
  const hocr = `
    <span class='ocrx_word' title='bbox 0 100 90 130; x_wconf 95'>21040.13</span>
    <span class='ocrx_word' title='bbox 0 200 90 230; x_wconf 95'>21020.25</span>
    <span class='ocrx_word' title='bbox 0 300 90 330; x_wconf 20'>21000.00</span>
  `;
  const samples = parseHocrPriceSamples(hocr, 1000);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].price, 21020.25);
});

test('reassembles split TradingView price labels on the same OCR row', () => {
  const hocr = `
    <span class='ocrx_word' title='bbox 4 100 35 125; x_wconf 88'>21</span>
    <span class='ocrx_word' title='bbox 37 101 83 126; x_wconf 91'>040</span>
    <span class='ocrx_word' title='bbox 85 100 110 126; x_wconf 84'>.25</span>
    <span class='ocrx_word' title='bbox 4 300 72 326; x_wconf 90'>21020</span>
    <span class='ocrx_word' title='bbox 74 300 108 326; x_wconf 90'>,00</span>
  `;
  const samples = parseHocrPriceSamples(hocr, 1000);
  assert.equal(samples.some(x => x.price === 21040.25), true);
  assert.equal(samples.some(x => x.price === 21020), true);
});

test('refuses excessive price extrapolation beyond visible labels', () => {
  const samples = [
    { y: .20, price: 21040, raw: '21040' },
    { y: .35, price: 21020, raw: '21020' },
    { y: .50, price: 21000, raw: '21000' },
    { y: .65, price: 20980, raw: '20980' },
    { y: .80, price: 20960, raw: '20960' },
  ];
  const c = calibratePriceAxis(samples);
  assert.equal(c.strong, true);
  assert.equal(Number.isFinite(priceForPermille(c, 500)), true);
  assert.equal(Number.isFinite(priceForPermille(c, 50)), false);
});

test('validates only correct long and short price geometry', () => {
  assert.equal(validateGeometry('LONG', 21000, 20980, 21040), true);
  assert.equal(validateGeometry('SHORT', 21000, 21020, 20960), true);
  assert.equal(validateGeometry('LONG', 21000, 21020, 20960), false);
  assert.equal(rr('LONG', 21000, 20980, 21040), 2);
});
