/** 진단 전용. 서버의 숫자만 고정된 키로 투영하고 원문·ID·중첩 content는 싣지 않는다. */
const metrics = ["input_tokens", "cached_tokens", "cache_write_tokens", "output_tokens"] as const;
type Metric = typeof metrics[number];
type Counts = Partial<Record<Metric, number>>;
export type CacheAttribution = {
  instructions?: Counts;
  tools?: Counts;
  items?: Counts & { count: number };
};
const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const counts = (v: unknown): Counts | undefined => {
  const row = record(v);
  if (!row) return undefined;
  const out: Counts = {};
  for (const key of metrics) if (count(row[key])) out[key] = row[key];
  // 부정합인 캐시 수치를 적중률 근거로 내보내지 않는다. 입력 누락은 0과 다르다.
  if (out.input_tokens !== undefined) {
    for (const key of ["cached_tokens", "cache_write_tokens"] as const) {
      if (out[key] !== undefined && out[key]! > out.input_tokens) delete out[key];
    }
  }
  return Object.keys(out).length ? out : undefined;
};
export const summarizeCacheAttribution = (raw: unknown): CacheAttribution | undefined => {
  const attr = record(raw);
  if (!attr) return undefined;
  const out: CacheAttribution = {};
  const fields = record(attr.request_fields);
  for (const key of ["instructions", "tools"] as const) {
    const value = counts(fields?.[key]);
    if (value) out[key] = value;
  }
  const items = record(attr.items);
  if (items && Object.keys(items).length > 0) {
    const rows = Object.values(items).map(counts);
    const sum: Counts & { count: number } = { count: rows.length };
    for (const key of metrics) {
      // 하나라도 누락·부정합이면 부분 합계를 전체처럼 표시하지 않는다.
      if (!rows.every(row => row?.[key] !== undefined)) continue;
      const total = rows.reduce((n, row) => n + row![key]!, 0);
      if (count(total)) sum[key] = total;
    }
    out.items = sum;
  }
  return Object.keys(out).length ? out : undefined;
};
