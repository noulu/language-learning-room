// JSON objects are unordered, including objects returned by PostgreSQL JSONB.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeKey = key => !['__proto__', 'prototype', 'constructor'].includes(key);
const definedKeys = value => Object.keys(value).filter(key => value[key] !== undefined);
const jsonValue = value => {
  if (value instanceof Date) return value.toJSON();
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
};

export function sameJSON(left, right) {
  if (left === right) return true;
  left = jsonValue(left);
  right = jsonValue(right);
  if (left === right) return true;
  if (Array.isArray(left)) {
    return Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => sameJSON(value ?? null, right[index] ?? null));
  }
  if (!object(left) || !object(right)) return false;
  const keys = definedKeys(left);
  return keys.length === definedKeys(right).length &&
    keys.every(key => Object.hasOwn(right, key) && sameJSON(left[key], right[key]));
}

export function makeDelta(before, after) {
  if (before === after) return null;
  before = jsonValue(before);
  after = jsonValue(after);
  if (before === after) return null;
  if (Array.isArray(before) && Array.isArray(after)) {
    let keep = 0;
    while (keep < before.length && keep < after.length && sameJSON(before[keep] ?? null, after[keep] ?? null)) keep++;
    if (keep === before.length && keep === after.length) return null;
    return { keep, tail: after.slice(keep) };
  }
  if (object(before) && object(after)) {
    const fields = [];
    const removed = definedKeys(before).filter(key => after[key] === undefined);
    for (const key of definedKeys(after)) {
      const change = makeDelta(before[key], after[key]);
      if (change) fields.push([key, change]);
    }
    return fields.length || removed.length ? { fields, removed } : null;
  }
  return { value: after };
}

export function applyDelta(before, delta, depth = 0) {
  if (!object(delta) || depth >= 32) throw new Error('Invalid progress delta');
  if (Object.hasOwn(delta, 'value')) return delta.value;
  if (Array.isArray(delta.tail) && Array.isArray(before) &&
      Number.isInteger(delta.keep) && delta.keep >= 0 && delta.keep <= before.length) {
    return before.slice(0, delta.keep).concat(delta.tail);
  }
  if (object(before) && Array.isArray(delta.fields) && Array.isArray(delta.removed)) {
    const after = { ...before };
    for (const key of delta.removed) {
      if (typeof key !== 'string' || !safeKey(key) || !Object.hasOwn(before, key)) throw new Error('Invalid progress delta key');
      delete after[key];
    }
    for (const field of delta.fields) {
      if (!Array.isArray(field) || field.length !== 2 || typeof field[0] !== 'string' || !safeKey(field[0])) {
        throw new Error('Invalid progress delta field');
      }
      const [key, change] = field;
      after[key] = applyDelta(before[key], change, depth + 1);
    }
    return after;
  }
  throw new Error('Invalid progress delta');
}
