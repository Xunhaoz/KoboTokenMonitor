import { test } from "node:test";
import assert from "node:assert/strict";
import { dashboardModel } from "./dashboard-model.mjs";

const now = Date.parse("2026-10-25T01:00:00Z");
const sample = {
  provider: "codex",
  usage: {
    updatedAt: new Date(now).toISOString(),
    primary: { usedPercent: 0 },
    secondary: { usedPercent: 100 },
  },
  collection: {
    lastSuccessAt: new Date(now).toISOString(),
    authCheckSucceeded: false,
  },
};

test("dashboard distinguishes zero, missing data, quota exhaustion and unknown query state", () => {
  const data = dashboardModel([sample], {}, { now });
  assert.equal(data.providers[0].usage.primary.usedPercent, 0);
  assert.equal(data.providers[0].usage.state, "quota_reached");
  assert.equal(data.providers[0].collection.status, "ok");
  assert.equal(data.providers[0].collection.authCheckSucceeded, undefined);
  assert.equal(data.providers[1].usage.primary.usedPercent, null);
  assert.equal(data.providers[1].usage.state, "missing");
  assert.equal(data.providers[1].collection.status, "unknown");
});

test("dashboard separates retained usage from failed queries and recomputes age at read time", () => {
  const record = {
    ...sample,
    retained: true,
    error: { code: "authentication_required" },
  };
  const data = dashboardModel([record], {}, { now });
  assert.equal(data.providers[0].usage.primary.usedPercent, 0);
  assert.equal(data.providers[0].usage.state, "authentication_required");
  assert.equal(data.providers[0].collection.status, "authentication_required");
  const stale = dashboardModel([sample], {}, { now: now + 660000 });
  assert.equal(stale.providers[0].usage.state, "stale");
  assert.equal(stale.providers[0].usage.quotaReached, true);
});

test("public schema excludes identities, raw diagnostics and unrecognized error text", () => {
  const dirty = {
    ...sample,
    token: "secret-token",
    email: "private@example.com",
    error: { code: "secret-diagnostic" },
    usage: {
      ...sample.usage,
      loginMethod: "secret-method",
      identity: "secret-identity",
    },
    collection: { ...sample.collection, stdout: "secret-output" },
  };
  const data = dashboardModel(
    [dirty, null],
    { token: "secret-health" },
    { now },
  );
  assert.doesNotMatch(JSON.stringify(data), /secret|private@example/);
  assert.equal(data.providers[0].collection.status, "query_failed");
  assert.equal(data.providers[0].usage.primary.usedPercent, null);
});

test('account labels are shared with PNG and old records fall back',()=>{
  const data=dashboardModel([{...sample,account:'my-account'}],{}, {now});
  assert.equal(data.providers[0].account,'my-account');
  assert.equal(data.providers[0].name,'codex - my-account');
  assert.equal(dashboardModel([sample],{}, {now}).providers[0].name,'Codex');
  const claude=dashboardModel([{...sample,provider:'claude',account:'claude-user'}],{}, {now});
  assert.equal(claude.providers[1].name,'claude - claude-user');
  assert.equal(dashboardModel([],{}, {now}).providers[1].name,'Claude');
});
