import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runWorkflow, createFileStore, createWorkflowDriver } from '../scripts/workflow.mjs';
import { ask } from '../scripts/jev-decide.mjs';
import { createWikipediaWorkflow } from '../scripts/wikipedia-workflow.mjs';

function fixture(overrides = {}) {
  let screen = { ax: '1 button Next\n2 button Other', page: 'expected', done: false };
  const state = { calls: [], requested: 0, observed: 0, disk: null, events: [], time: 1000 };
  const stage = { id: 'next', goal: 'Click Next', actions: ['click_element'],
    ready: () => true, verify: o => o.done, acceptTarget: e => e.label === 'Next',
    progress: o => o.done, canRetry: () => true, ...overrides.stage };
  const workflow = { id: 'test', version: '1', guard: o => o.page === 'expected',
    verify: o => o.done === true, stages: [stage], ...overrides.workflow };
  const store = { checkpointPath: 'memory:' + randomUUID(),
    read: () => structuredClone(state.disk),
    commit: (s, event) => { state.disk = structuredClone(s); state.events.push(event); },
  };
  const driver = { identity: 'fake:' + randomUUID(),
    observe: async () => { state.observed++; return structuredClone(screen); },
    execute: async d => { state.calls.push(d.targetIndex); screen.done = true; },
  };
  const decide = async ({ candidates }) => { state.requested++; return {
    targetIndex: candidates[0].index, action: 'click_element', confidence: 1, risk: 0, done: 0,
  }; };
  return { state, stage, workflow, store, driver, get screen() { return screen; },
    set screen(v) { screen = v; },
    run(extra = {}) { return runWorkflow({ workflow, input: { text: 'unchanged' }, driver, store, decide,
      dryRun: false, now: () => state.time, sleep: async ms => { state.time += ms; }, ...extra }); },
  };
}

test('normal completion verifies stages and final condition; missing usage is unknown', async () => {
  const f = fixture(); const r = await f.run();
  assert.equal(r.status, 'done'); assert.deepEqual(f.state.calls, [1]);
  assert.deepEqual(f.state.disk.completed, ['next']); assert.equal(r.jev.inputTokens, null);
  assert.ok(f.state.events.indexOf('action_intent') < f.state.events.indexOf('action_settled'));
});
test('dry-run observes and selects but performs zero UI actions', async () => {
  const f = fixture(); assert.equal((await f.run({ dryRun: true })).status, 'dry_run');
  assert.equal(f.state.calls.length, 0); assert.equal((await f.run()).status, 'done');
});
test('503 retries only decision, observes again, disables nested retries', async () => {
  const f = fixture(); let calls = 0;
  const r = await f.run({ decide: async opts => {
    assert.equal(opts.maxRetries, 0); calls++;
    if (calls === 1) throw Object.assign(new Error('private-provider-content'), { status: 503 });
    return { targetIndex: opts.candidates[0].index, action: 'click_element', confidence: 1, risk: 0, done: 0 };
  } });
  assert.equal(r.status, 'done'); assert.equal(r.decisions, 2); assert.equal(r.actions, 1);
  assert.ok(f.state.observed >= 4); assert.equal(JSON.stringify(r).includes('private-provider'), false);
});
test('401 stops without retry or action', async () => {
  const f = fixture(); const r = await f.run({ decide: async () => { throw Object.assign(new Error(), { status: 401 }); } });
  assert.equal(r.reason, 'api_auth'); assert.equal(r.decisions, 1); assert.equal(r.actions, 0);
});
test('candidate clipping expands once and reaches candidate beyond 40', async () => {
  const f = fixture(); f.screen.ax = Array.from({ length: 50 }, (_, i) => `${i + 1} button ${i === 49 ? 'Next' : 'Other'}`).join('\n');
  f.stage.goal = 'Continue';
  assert.equal((await f.run()).status, 'done'); assert.deepEqual(f.state.calls, [50]);
  assert.equal(f.state.events.filter(e => e === 'expand_candidates').length, 1);
});
test('fresh observation rebinds unique target and never clicks stale index', async () => {
  const f = fixture(); const observe = f.driver.observe;
  f.driver.observe = async () => { if (f.state.observed >= 1) f.screen.ax = '8 button Next\n1 button Other'; return observe(); };
  assert.equal((await f.run()).status, 'done'); assert.deepEqual(f.state.calls, [8]);
});
test('ambiguous target after selection stops without clicking', async () => {
  const f = fixture(); const observe = f.driver.observe;
  f.driver.observe = async () => { if (f.state.observed >= 1) f.screen.ax = '8 button Next\n9 button Next'; return observe(); };
  const r = await f.run(); assert.equal(r.reason, 'stale_target'); assert.equal(r.actions, 0);
});
test('lost acknowledgement after successful save verifies success without duplicating', async () => {
  const f = fixture({ stage: { canRetry: () => false } });
  f.driver.execute = async d => { f.state.calls.push(d.targetIndex); f.screen.done = true; throw new Error('lost response'); };
  assert.equal((await f.run()).status, 'done'); assert.equal(f.state.calls.length, 1);
});
test('unknown result returns to Codex; confirmed success resumes without duplicate', async () => {
  const f = fixture({ stage: { canRetry: () => false } });
  f.driver.execute = async d => { f.state.calls.push(d.targetIndex); f.screen.done = null; throw new Error(); };
  const r = await f.run(); assert.equal(r.reason, 'action_outcome_unknown'); assert.equal(r.lastActionOutcome, 'unknown');
  assert.equal((await f.run()).reason, 'action_outcome_unknown');
  f.screen.done = true;
  assert.equal((await f.run({ resumeAfterHandoff: true })).status, 'done');
  assert.equal(f.state.calls.length, 1);
});
test('unproven repeat safety stops even after an acknowledged operation', async () => {
  const f = fixture({ stage: { canRetry: () => false } }); f.driver.execute = async d => { f.state.calls.push(d.targetIndex); };
  assert.equal((await f.run()).reason, 'retry_not_proven_safe'); assert.equal(f.state.calls.length, 1);
});
test('two ineffective operations stop despite changing AX indices and unrelated clock text', async () => {
  const f = fixture();
  f.driver.execute = async d => { f.state.calls.push(d.targetIndex);
    f.screen.ax = `${f.state.calls.length + 1} button Next\n99 text clock-${f.state.calls.length}`; };
  assert.equal((await f.run()).reason, 'repeated_no_progress'); assert.equal(f.state.calls.length, 2);
});
test('Jev done flag cannot override failed verification', async () => {
  const f = fixture(); const r = await f.run({ decide: async () => ({ targetIndex: 1, action: 'click_element', confidence: 1, risk: 0, done: 1 }) });
  assert.equal(r.reason, 'policy_done'); assert.equal(r.actions, 0);
});
test('chunk pause and resume do not reset counters or replay completed stage', async () => {
  const f = fixture(); f.workflow.stages.push({ ...f.stage, id: 'second', verify: o => o.second === true,
    progress: o => o.second === true }); f.workflow.verify = o => o.second === true;
  f.driver.execute = async d => { f.state.calls.push(d.targetIndex); f.state.time += 30;
    if (!f.screen.done) f.screen.done = true; else f.screen.second = true; };
  const first = await f.run({ chunkMs: 20 }); assert.equal(first.status, 'paused'); assert.equal(first.stageId, 'second');
  const second = await f.run({ chunkMs: 20 }); assert.equal(second.status, 'done'); assert.equal(second.actions, 2);
  assert.equal(second.recoveryResumes, 0);
});
test('changed input or workflow version refuses resume', async () => {
  const f = fixture(); await f.run({ dryRun: true });
  assert.equal((await f.run({ input: { text: 'different' } })).reason, 'resume_mismatch');
  f.workflow.version = '2'; assert.equal((await f.run()).reason, 'resume_mismatch'); assert.equal(f.state.calls.length, 0);
});
test('changed site stops before action and before accepting a success flag', async () => {
  const f = fixture(); f.screen.page = 'other'; f.screen.done = true;
  assert.equal((await f.run()).reason, 'scope_mismatch'); assert.equal(f.state.calls.length, 0);
});
test('storage failure at action intent prevents browser mutation', async () => {
  const f = fixture(); const commit = f.store.commit;
  f.store.commit = (s, event) => { if (event === 'action_intent') throw Object.assign(new Error(), { code: 'ENOSPC' }); commit(s, event); };
  assert.equal((await f.run()).reason, 'storage_or_io_error'); assert.equal(f.state.calls.length, 0);
});
test('uncancellable in-flight action retains lock and is awaited even past time limit', async () => {
  const f = fixture(); let settle, entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.driver.execute = async d => { f.state.calls.push(d.targetIndex); entered(); await new Promise(resolve => { settle = resolve; }); f.screen.done = true; };
  const first = f.run(); await started;
  assert.equal((await f.run()).reason, 'locked'); assert.equal(f.state.calls.length, 1);
  f.state.time += 1000000; settle(); assert.equal((await first).status, 'done');
});
test('maximum decisions persists across handoff; no extra API call', async () => {
  const f = fixture(); const decide = async () => { throw Object.assign(new Error(), { status: 503 }); };
  const limits = { maxDecisions: 1 }; await f.run({ decide, limits });
  const r = await f.run({ decide, limits, resumeAfterHandoff: true });
  assert.equal(r.reason, 'operation_limit'); assert.equal(r.decisions, 1);
});
test('recovery handoff limit persists', async () => {
  const f = fixture(); f.screen.page = 'other';
  await f.run(); await f.run({ resumeAfterHandoff: true }); await f.run({ resumeAfterHandoff: true });
  assert.equal((await f.run({ resumeAfterHandoff: true })).reason, 'recovery_limit');
});
test('file store persists checkpoint across new store instances and detects malformed JSON', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-workflow-test-'));
  const f = fixture(); const s = createFileStore(dir); await f.run({ store: s, dryRun: true });
  assert.equal((await f.run({ store: createFileStore(dir) })).status, 'done');
  fs.writeFileSync(s.checkpointPath, '{');
  assert.equal((await f.run({ store: s })).reason, 'checkpoint_unreadable');
  // Only files created by this test, no recursive path deletion.
  for (const name of ['checkpoint.json', 'events.jsonl']) fs.unlinkSync(path.join(dir, name));
  fs.rmdirSync(dir);
});
test('observer failure after action keeps pending checkpoint for safe resume', async () => {
  const f = fixture(); const observe = f.driver.observe;
  f.driver.observe = async () => { if (f.state.calls.length) throw new Error('AX unavailable'); return observe(); };
  assert.equal((await f.run()).status, 'needs_codex'); assert.ok(f.state.disk.pending);
  f.driver.observe = observe;
  assert.equal((await f.run({ resumeAfterHandoff: true })).status, 'done'); assert.equal(f.state.calls.length, 1);
});
test('driver uses provided fresh target for input and keys', async () => {
  const calls = []; const tab = { getAXState: async () => '7 text field Title',
    setValue: async (...a) => calls.push(a), pressKey: async (...a) => calls.push(a) };
  const d = createWorkflowDriver(tab, { identity: 'tab:test', readMetadata: async () => ({ url: 'https://example.test' }) });
  assert.equal((await d.observe()).url, 'https://example.test');
  await d.execute({ action: 'set_value', targetIndex: 7 }, { text: 'title' });
  await d.execute({ action: 'press_key', targetIndex: 8 }, { key: 'Return' });
  assert.deepEqual(calls, [[7, 'title'], [8, 'Return']]);
});

test('valid JSON but incomplete checkpoint is rejected without mutation', async () => {
  const f = fixture(); f.state.disk = { schema: 1, position: 0, completed: [] };
  assert.equal((await f.run()).reason, 'checkpoint_invalid'); assert.equal(f.state.calls.length, 0);
  assert.deepEqual(f.state.disk, { schema: 1, position: 0, completed: [] });
});
test('provider cost limit stops before another decision across stages', async () => {
  const f = fixture(); f.workflow.stages.push({ ...f.stage, id: 'second', verify: () => false });
  const r = await f.run({ decide: async ({ candidates }) => ({ targetIndex: candidates[0].index,
    action: 'click_element', confidence: 1, risk: 0, done: 0, costUsd: 0.1 }) });
  assert.equal(r.reason, 'reported_cost_limit'); assert.equal(r.decisions, 1); assert.equal(r.actions, 1);
});
test('Retry-After is preserved by API adapter and respected by runner', async () => {
  await assert.rejects(ask({ state: {}, questions: {}, apiKey: 'test-only', maxRetries: 0,
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}), headers: { get: () => '2' } }) }),
    e => e.status === 429 && e.retryAfterMs === 2000);
  const f = fixture(); let calls = 0; const before = f.state.time;
  const r = await f.run({ decide: async ({ candidates }) => {
    if (!calls++) throw Object.assign(new Error(), { status: 429, retryAfterMs: 2000 });
    return { targetIndex: candidates[0].index, action: 'click_element', confidence: 1, risk: 0, done: 0 };
  } });
  assert.equal(r.status, 'done'); assert.equal(f.state.time - before, 2000);
});
test('checkpoint does not store supplied text or raw provider replies', async () => {
  const f = fixture(); const r = await f.run({ input: { text: 'private-test-marker' },
    decide: async () => ({ targetIndex: 1, action: 'click_element', confidence: 1, risk: 0, done: 0,
      raw: { token: 'private-test-marker' } }) });
  assert.equal(r.status, 'done'); assert.ok(!JSON.stringify(f.state.disk).includes('private-test-marker'));
  assert.ok(!JSON.stringify(r).includes('private-test-marker'));
});
test('Wikipedia search workflow supports observed combo box and requires exact article URL', () => {
  const w = createWikipediaWorkflow([{ title: '東京スカイツリー', section: '歴史' }]);
  const o = { url: 'https://ja.wikipedia.org/wiki/メインページ', ax:
    '737 combo box (collapsed, settable) Description: Wikipedia内を検索, Value: 東京スカイツリー\n738 button 検索' };
  assert.equal(w.stages[0].verify(o), true); assert.equal(w.stages[1].verify(o), true);
  assert.equal(w.stages[2].ready(o), true); assert.equal(w.stages[2].verify(o), false);
  o.url = 'https://ja.wikipedia.org/wiki/東京スカイツリー#歴史';
  o.ax = '18 heading 東京スカイツリー, Value: 1, ID: firstHeading';
  assert.equal(w.verify(o), true);
  o.url = 'https://ja.wikipedia.org/wiki/東京タワー#歴史'; assert.equal(w.verify(o), false);
});
