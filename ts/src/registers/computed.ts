import type { DecodedValue } from '../core/types.js';

export interface ComputedRegister {
  name: string;
  dependencies: string[];
  unit?: string;
  compute(values: Map<string, DecodedValue>): DecodedValue;
}

export function applyComputed(
  values: Map<string, DecodedValue>,
  computedRegisters: ComputedRegister[],
): void {
  for (const cr of computedRegisters) {
    if (cr.dependencies.some((dep) => !values.has(dep))) continue;
    const result = cr.compute(values);
    if (result !== undefined) {
      values.set(cr.name, result);
    }
  }
}

function padTwo(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

const timestampRegister: ComputedRegister = {
  name: 'timestamp',
  dependencies: ['year', 'month', 'day', 'hour', 'minute', 'second'],
  compute(values) {
    const y = values.get('year');
    const mo = values.get('month');
    const d = values.get('day');
    const h = values.get('hour');
    const mi = values.get('minute');
    const s = values.get('second');
    if (typeof y !== 'number' || typeof mo !== 'number' || typeof d !== 'number' ||
        typeof h !== 'number' || typeof mi !== 'number' || typeof s !== 'number') {
      return null;
    }
    const year = y < 100 ? 2000 + y : y;
    return `${year}-${padTwo(mo)}-${padTwo(d)} ${padTwo(h)}:${padTwo(mi)}:${padTwo(s)}`;
  },
};

const alarmTimestampRegister: ComputedRegister = {
  name: 'alarm_timestamp',
  dependencies: ['pid_alarm_code', 'alarm_time_year', 'alarm_time_month', 'alarm_time_day', 'alarm_time_hour', 'alarm_time_minute', 'alarm_time_second'],
  compute(values) {
    const code = values.get('pid_alarm_code');
    if (code === 0 || code === null) return null;
    const y = values.get('alarm_time_year');
    const mo = values.get('alarm_time_month');
    const d = values.get('alarm_time_day');
    const h = values.get('alarm_time_hour');
    const mi = values.get('alarm_time_minute');
    const s = values.get('alarm_time_second');
    if (typeof y !== 'number' || typeof mo !== 'number' || typeof d !== 'number' ||
        typeof h !== 'number' || typeof mi !== 'number' || typeof s !== 'number') {
      return null;
    }
    const year = y < 100 ? 2000 + y : y;
    return `${year}-${padTwo(mo)}-${padTwo(d)} ${padTwo(h)}:${padTwo(mi)}:${padTwo(s)}`;
  },
};

function mpptPower(i: number): ComputedRegister {
  return {
    name: `mppt_${i}_power`,
    dependencies: [`mppt_${i}_voltage`, `mppt_${i}_current`],
    unit: 'W',
    compute(values) {
      const v = values.get(`mppt_${i}_voltage`);
      const c = values.get(`mppt_${i}_current`);
      if (typeof v !== 'number' || typeof c !== 'number') return null;
      return v * c;
    },
  };
}

export const BUILTIN_COMPUTED: ComputedRegister[] = [
  timestampRegister,
  alarmTimestampRegister,
  ...Array.from({ length: 12 }, (_, i) => mpptPower(i + 1)),
];
