const utils = require('../renderer/utils');

describe('renderer utils', () => {
  test('downsampleBuffer returns identical buffer when rates match', () => {
    const input = new Float32Array([0, 0.5, -0.25]);
    const output = utils.downsampleBuffer(input, 16000, 16000);
    expect(Array.from(output)).toEqual(Array.from(input));
  });

  test('downsampleBuffer averages samples when reducing rate', () => {
    const input = new Float32Array([1, 3, 5, 7]);
    const output = utils.downsampleBuffer(input, 4000, 2000);
    expect(Array.from(output)).toEqual([2, 6]);
  });

  test('formatTimestamp clamps invalid values', () => {
    expect(utils.formatTimestamp(0, 10)).toBe('0:05');
    expect(utils.formatTimestamp(-5, -1)).toBe('0:00');
  });
});
