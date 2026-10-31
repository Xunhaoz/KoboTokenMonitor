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
  const retained = record?.retained === true;
  const primary = error && !retained ? null : percentage(usage.primary);
  const secondary = error && !retained ? null : percentage(usage.secondary);
  const updatedAt = timestamp(usage.updatedAt);
  const stale = updatedAt !== null && +now - updatedAt > 600_000;
  const future = updatedAt !== null && updatedAt - +now > 300_000;
  const quotaReached = secondary === 100;
  let state = 'ok';
  if (error) state = authError ? 'authentication_required' : retained ? 'stale' : 'error';
  else if (primary === null && secondary === null) state = 'missing';
  else if (stale) state = 'stale';
  else if (future || updatedAt === null || primary === null || secondary === null) state = 'partial';
  else if (quotaReached) state = 'quota_reached';
  const captions = {ok:'訂閱用量', missing:'尚無用量資料', error:'查詢失敗',
    authentication_required:'需要重新登入', stale:'資料已過期', partial:'資料不完整', quota_reached:'週額度已滿'};
  return {usage,primary,secondary,updatedAt,state,caption:captions[state],quotaReached,
    resetPrimary:error&&!retained?null:usage.primary?.resetsAt,
    resetSecondary:error&&!retained?null:usage.secondary?.resetsAt};
}

// Only the local part is public; persisted snapshots already contain account.
export function accountName(record) {
  const emails = [record?.usage?.accountEmail, record?.usage?.identity?.accountEmail];
  for (const email of emails) {
    if (typeof email === 'string' && /^[^\s@]+@[^\s@]+$/.test(email.trim())) {
      return email.trim().split('@')[0];
    }
  }
  // Raw identity fields must not fall back to a potentially stale persisted account.
  if (emails.some(email => email !== undefined)) return null;
  const account = record?.account;
  return typeof account === 'string' && /^[^\s@]+$/.test(account) ? account : null;
}

export function displayName(record, fallback) {
  const account = accountName(record);
  const providerName = { codex: 'Codex', claude: 'Claude' }[record?.provider];
  return providerName && account ? `${providerName} - ${account}` : fallback;
}
