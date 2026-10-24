export function percentage(window) {
  const value = window?.usedPercent;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value : null;
}

export function timestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
}

export function normalizeProvider(records, id, now, inputError = null) {
  const record = records.find(r => r && typeof r === 'object' && r.provider === id);
  const usage = record?.usage && typeof record.usage === 'object' ? record.usage : {};
  const error = inputError || record?.error;
  const message = typeof error === 'string' ? error : JSON.stringify(error || '');
  const authError = /401|unauthori|authenticat|expired.*token|token.*expired/i.test(message);
  const primary = error ? null : percentage(usage.primary);
  const secondary = error ? null : percentage(usage.secondary);
  const updatedAt = timestamp(usage.updatedAt);
  const stale = updatedAt !== null && +now - updatedAt > 600_000;
  const future = updatedAt !== null && updatedAt - +now > 300_000;
  const quotaReached = secondary === 100;
  let state = 'ok';
  if (error) state = authError ? 'authentication_required' : 'error';
  else if (primary === null && secondary === null) state = 'missing';
  else if (stale) state = 'stale';
  else if (future || updatedAt === null || primary === null || secondary === null) state = 'partial';
  else if (quotaReached) state = 'quota_reached';
  const captions = {ok:'訂閱用量', missing:'尚無用量資料', error:'查詢失敗',
    authentication_required:'需要重新登入', stale:'資料已過期', partial:'資料不完整', quota_reached:'週額度已滿'};
  return {usage,primary,secondary,updatedAt,state,caption:captions[state],quotaReached,
    resetPrimary:error?null:usage.primary?.resetsAt,
    resetSecondary:error?null:usage.secondary?.resetsAt};
}
