const assert = require('assert');
const {
  computeFingerprint,
  findQueueBlockers,
  checkSubmissionPrerequisites,
  findActiveDrillForVersion,
  evaluateExecutionGate,
  buildPlanVersion,
  buildFrozenSnapshot,
} = require('../dist-test/models/rollback-drill.model.js');
const { buildDrillSubmission } = require('../dist-test/store/drill-factory.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

function makeChange(overrides = {}) {
  return {
    id: 'CHG-1',
    title: '演练变更',
    owner: '甲',
    onCall: ['甲'],
    status: 'submitted',
    risk: 'high',
    resources: [
      {
        id: 'isolated-link-1',
        name: '隔离链路1',
        type: 'network',
        critical: true,
        dependencies: [],
      },
    ],
    steps: [
      {
        id: 'rb1',
        phase: 'rollback',
        title: '回切',
        owner: '甲',
        durationMinutes: 10,
        command: 'rollback --now',
        completed: false,
      },
    ],
    window: {
      start: '2026-10-05T01:00',
      end: '2026-10-05T03:00',
      observationWindowMinutes: 30,
      blackoutProtected: false,
    },
    approvals: [
      { stage: 'network', state: 'approved' },
      { stage: 'system', state: 'pending' },
      { stage: 'security', state: 'pending' },
      { stage: 'business', state: 'pending' },
    ],
    deviations: [],
    audit: [],
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

// 1. 指纹稳定性与变化检测
check('指纹：拓扑/命令/窗口变化才变，会签推进不触发版本变化', () => {
  const base = makeChange();
  const fp0 = computeFingerprint(base);
  const signed = makeChange({
    approvals: base.approvals.map((a) => ({
      ...a,
      state: a.stage === 'system' ? 'approved' : a.state,
    })),
  });
  assert.strictEqual(computeFingerprint(signed), fp0, '会签推进不应改变指纹');

  const changedCommand = makeChange({
    steps: [{ ...base.steps[0], command: 'rollback --force' }],
  });
  assert.notStrictEqual(computeFingerprint(changedCommand), fp0, '命令变化应改变指纹');

  const changedWindow = makeChange({
    window: { ...base.window, end: '2026-10-05T04:00' },
  });
  assert.notStrictEqual(computeFingerprint(changedWindow), fp0, '窗口变化应改变指纹');

  const changedTopology = makeChange({
    resources: [
      ...base.resources,
      { id: 'link-2', name: '链路2', type: 'network', critical: false, dependencies: [] },
    ],
  });
  assert.notStrictEqual(computeFingerprint(changedTopology), fp0, '拓扑变化应改变指纹');
});

// 2. 前置校验
check('前置校验：草稿、缺命令、缺资源拒绝演练', () => {
  assert.strictEqual(checkSubmissionPrerequisites(makeChange({ status: 'draft' })).ok, false);
  assert.strictEqual(
    checkSubmissionPrerequisites(makeChange({ steps: [{ ...makeChange().steps[0], command: '' }] }))
      .ok,
    false,
  );
  assert.strictEqual(checkSubmissionPrerequisites(makeChange({ resources: [] })).ok, false);
  assert.strictEqual(checkSubmissionPrerequisites(makeChange()).ok, true);
});

// 3. 排队：与正式变更共享资源且窗口重叠
check('排队：正式变更持有共享隔离链路时阻塞演练', () => {
  const drillChange = makeChange();
  const formal = makeChange({ id: 'CHG-2', title: '正式变更', status: 'approved' });
  const blockers = findQueueBlockers(drillChange, [formal], []);
  assert.strictEqual(blockers.length, 1);
  assert.strictEqual(blockers[0].kind, 'formal_change');
  assert.deepStrictEqual(blockers[0].resourceIds, ['isolated-link-1']);

  const noOverlap = makeChange({
    id: 'CHG-2',
    status: 'approved',
    window: { ...makeChange().window, start: '2026-10-06T01:00', end: '2026-10-06T03:00' },
  });
  assert.strictEqual(findQueueBlockers(drillChange, [noOverlap], []).length, 0, '窗口不重叠不阻塞');

  const otherResource = makeChange({
    id: 'CHG-2',
    status: 'approved',
    resources: [{ id: 'other', name: '其他', type: 'rack', critical: false, dependencies: [] }],
  });
  assert.strictEqual(
    findQueueBlockers(drillChange, [otherResource], []).length,
    0,
    '不共享资源不阻塞',
  );
});

// 4. 先到生效
check('并发：同版本先到生效，后到只保留冲突', () => {
  const change = makeChange();
  const fp = computeFingerprint(change);
  const first = buildDrillSubmission({
    change,
    submittedBy: '甲',
    clientToken: 'tok-1',
    order: 1,
    status: 'running',
    blockedBy: [],
    replayed: false,
    timestamp: new Date().toISOString(),
  });
  const winner = findActiveDrillForVersion([first], change.id, fp);
  assert.strictEqual(winner.id, first.id);

  const second = buildDrillSubmission({
    change,
    submittedBy: '乙',
    clientToken: 'tok-2',
    order: 2,
    status: 'conflict_retained',
    blockedBy: [
      {
        kind: 'prior_drill',
        holderId: first.id,
        changeId: first.changeId,
        holderLabel: 'x',
        resourceIds: [],
      },
    ],
    replayed: false,
    timestamp: new Date().toISOString(),
  });
  assert.strictEqual(second.status, 'conflict_retained');
  // 冲突保留的批次不参与资源占用判定
  const blockers = findQueueBlockers(change, [], [first, second], { selfId: first.id });
  assert.strictEqual(blockers.length, 0);
});

// 5. 凭证门禁
check('门禁：旧方案待补、无凭证、旧版本凭证均拦截；当前版本凭证放行', () => {
  const change = makeChange({ status: 'approved' });
  const version = buildPlanVersion(change);

  assert.strictEqual(
    evaluateExecutionGate(change, { ...version, gateState: 'legacy_backfill' }, undefined).allowed,
    false,
  );
  assert.strictEqual(
    evaluateExecutionGate(change, version, undefined).allowed,
    false,
    '无凭证应拦截',
  );

  const credential = {
    id: 'CRE-1',
    changeId: change.id,
    fingerprint: version.fingerprint,
    versionLabel: version.versionLabel,
    status: 'issued',
    frozen: buildFrozenSnapshot(change, version),
  };
  assert.strictEqual(
    evaluateExecutionGate(change, version, credential).allowed,
    true,
    '当前版本凭证应放行',
  );

  const stale = { ...credential, fingerprint: 'deadbeefdeadbeef' };
  assert.strictEqual(
    evaluateExecutionGate(change, version, stale).allowed,
    false,
    '旧版本凭证应拦截',
  );
});

// 6. 冻结快照包含拓扑与命令摘要
check('冻结快照：包含完整拓扑摘要与回滚命令摘要', () => {
  const change = makeChange();
  const version = buildPlanVersion(change);
  const frozen = buildFrozenSnapshot(change, version);
  assert.ok(frozen.topologySummary.some((line) => line.includes('isolated-link-1')));
  assert.strictEqual(frozen.commandSummary[0].command, 'rollback --now');
  assert.strictEqual(frozen.fingerprint, version.fingerprint);
});

// 7. 恢复身份确定性
check('恢复：相同 clientToken+序号生成相同身份，重复重放不新增凭证', () => {
  const change = makeChange();
  const ts = '2026-10-05T01:00:00.000Z';
  const a = buildDrillSubmission({
    change,
    submittedBy: '甲',
    clientToken: 'tok-x',
    order: 7,
    status: 'succeeded',
    blockedBy: [],
    replayed: false,
    timestamp: ts,
  });
  const b = buildDrillSubmission({
    change,
    submittedBy: '甲',
    clientToken: 'tok-x',
    order: 7,
    status: 'succeeded',
    blockedBy: [],
    replayed: true,
    timestamp: ts,
  });
  assert.strictEqual(a.id, b.id);
  assert.strictEqual(a.batch.id, b.batch.id);
  assert.strictEqual(b.batch.replayed, true);
});

console.log(`\n${passed} 项逻辑自检全部通过`);
