export const greet = (who) => `hello, ${who}`;

export const clamp = (value, min, max) => {
  if (min > max) {
    throw new RangeError(`clamp: min (${min}) must not be greater than max (${max})`);
  }
  if (value < min) return min;
  if (value > max) return max;
  return value;
};
