(function (global, factory) {
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    global.rendererUtils = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function downsampleBuffer(buffer, sampleRate, targetRate) {
    if (sampleRate === targetRate) {
      return new Float32Array(buffer);
    }

    const ratio = sampleRate / targetRate;
    const newLength = Math.floor(buffer.length / ratio);
    const result = new Float32Array(newLength);
    let offsetResult = 0;
    let offsetBuffer = 0;

    while (offsetResult < newLength) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
      let accum = 0;
      let count = 0;
      for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i += 1) {
        accum += buffer[i];
        count += 1;
      }
      result[offsetResult] = count > 0 ? accum / count : 0;
      offsetResult += 1;
      offsetBuffer = nextOffsetBuffer;
    }

    return result;
  }

  function formatTimestamp(start, end) {
    const clamp = (value) => (Number.isFinite(value) ? Math.max(0, value) : 0);
    const midpoint = (clamp(start) + clamp(end)) / 2;
    const minutes = Math.floor(midpoint / 60);
    const seconds = Math.floor(midpoint % 60)
      .toString()
      .padStart(2, '0');
    return `${minutes}:${seconds}`;
  }

  return {
    downsampleBuffer,
    formatTimestamp,
  };
});
