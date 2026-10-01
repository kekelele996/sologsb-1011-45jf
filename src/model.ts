export type ConnectionState = 'connected' | 'degraded' | 'offline';
export type SegmentState = 'pending' | 'confirmed' | 'duplicate' | 'stale' | 'ignored';
export type SegmentSource = 'live' | 'offline' | 'manual';

export interface CaptionSegment {
  id: string;
  sequence: number;
  startTime: number;
  receivedAt: number;
  confirmedAt?: number;
  speaker: string;
  original: string;
  corrected: string;
  numberHints: string;
  source: SegmentSource;
  state: SegmentState;
  duplicateOf?: string;
  staleReason?: string;
  revision: number;
  tags: string[];
  aired?: boolean;
  locked?: boolean;
  airedAt?: number;
}

export interface TermRule {
  id: string;
  source: string;
  replacement: string;
  speaker: string;
  enabled: boolean;
  caseSensitive: boolean;
  usageCount: number;
  createdAt: number;
}

export interface DeskModel {
  eventName: string;
  eventDate: string;
  segments: CaptionSegment[];
  rules: TermRule[];
  selectedId: string;
  connection: ConnectionState;
  simulatedDelay: number;
  fontSize: number;
  nextSequence: number;
  autoStream: boolean;
  lastMergedAt?: number;
  updatedAt: number;
  schemaVersion: number;
  migrationNotes: string[];
  airedList: AiredItem[];
  reconciledAt?: number;
  redeliveryQueue: string[];
  lastCheckpointId?: string;
}

export interface AiredItem {
  segmentId: string;
  sequence: number;
  startTime: number;
  speaker: string;
  text: string;
  airedAt: number;
}

export type RecoveryPointKind = 'confirm' | 'rule' | 'ignore' | 'edit' | 'manual' | 'migrate';

export interface RecoveryPoint {
  id: string;
  schemaVersion: number;
  savedAt: number;
  kind: RecoveryPointKind;
  label: string;
  reason?: string;
  model: DeskModel;
  counts: { confirmed: number; pending: number; rules: number };
  fingerprints: Record<string, string>;
}

export interface ReconcileMismatch {
  kind: 'text-diff' | 'aired-only';
  segmentId: string;
  sequence: number;
  localText?: string;
  airedText: string;
  reason: string;
}

export interface ReconcileReport {
  matched: string[];
  redeliver: string[];
  mismatches: ReconcileMismatch[];
  reconciledAt: number;
}

export interface ToastMessage {
  id: string;
  kind: 'info' | 'success' | 'warning' | 'error';
  title: string;
  subtitle: string;
}

const now = Date.now();
export const STORAGE_KEY = 'sologsb-1011-live-caption-desk-v1';
export const SCHEMA_VERSION = 2;
export const CHECKPOINT_KEY = `${STORAGE_KEY}-checkpoints`;
export const CHECKPOINT_FAULT_KEY = `${STORAGE_KEY}-checkpoint-fault`;
export const CHECKPOINT_LIMIT = 20;

function segment(
  id: string,
  sequence: number,
  startTime: number,
  speaker: string,
  original: string,
  corrected = original,
  state: SegmentState = 'pending',
): CaptionSegment {
  return {
    id,
    sequence,
    startTime,
    receivedAt: now - (100 - sequence) * 8_000,
    confirmedAt: state === 'confirmed' ? now - (100 - sequence) * 7_000 : undefined,
    speaker,
    original,
    corrected,
    numberHints: '',
    source: 'live',
    state,
    revision: 0,
    tags: [],
  };
}

const seededSegments: CaptionSegment[] = [
  segment('seg-1', 1, 0, '主持人', '欢迎大家来到二零二六年产品发布会。', '欢迎大家来到2026年产品发布会。', 'confirmed'),
  segment('seg-2', 2, 7, '主讲人', '今天我们会介绍三个模块,首先是实时协作。', '今天我们会介绍三个模块，首先是实时协作。', 'confirmed'),
  segment('seg-3', 3, 15, '主讲人', '延迟和质量监测会帮助我们保持字幕稳定。', '延迟和质量监测会帮助我们保持字幕稳定。', 'confirmed'),
  segment('seg-4', 4, 24, '嘉宾 / 周然', '我们使用 studio cloud 作为演示环境。', '我们使用 Studio Cloud 作为演示环境。', 'pending'),
  segment('seg-5', 5, 34, '嘉宾 / 周然', '每分钟大约会收到一百二十个片段。', '每分钟大约会收到120个片段。', 'pending'),
  segment('seg-6', 6, 43, '主持人', '如果主持人提到 co pilot,需要统一大小写。', '如果主持人提到 Co-Pilot，需要统一大小写。', 'pending'),
  segment('seg-7', 7, 52, '主持人', '这个例子会演示五G网络下的字幕恢复。', '这个例子会演示5G网络下的字幕恢复。', 'pending'),
];

const duplicate: CaptionSegment = {
  ...segment('seg-8', 8, 61, '主讲人', '今天我们重点讨论字幕队列。', '今天我们重点讨论字幕队列。', 'duplicate'),
  source: 'live',
  duplicateOf: 'seg-2',
  staleReason: '与第 2 段高度相似',
};

export function createInitialModel(): DeskModel {
  return {
    eventName: '新品发布会现场字幕',
    eventDate: new Date(now).toISOString().slice(0, 10),
    segments: [...seededSegments, duplicate],
    rules: [
      { id: 'term-1', source: 'co pilot', replacement: 'Co-Pilot', speaker: '', enabled: true, caseSensitive: false, usageCount: 4, createdAt: now - 86_400_000 },
      { id: 'term-2', source: 'studio cloud', replacement: 'Studio Cloud', speaker: '', enabled: true, caseSensitive: false, usageCount: 7, createdAt: now - 43_200_000 },
      { id: 'term-3', source: '五G', replacement: '5G', speaker: '', enabled: true, caseSensitive: true, usageCount: 2, createdAt: now - 3_600_000 },
    ],
    selectedId: 'seg-4',
    connection: 'connected',
    simulatedDelay: 1.8,
    fontSize: 18,
    nextSequence: 9,
    autoStream: true,
    updatedAt: now,
    schemaVersion: SCHEMA_VERSION,
    migrationNotes: [],
    airedList: [],
    redeliveryQueue: [],
  };
}

export function cloneModel(model: DeskModel): DeskModel {
  return structuredClone(model);
}

export function normalizeNumbers(text: string): string {
  const digitMap: Record<string, string> = { '０': '0', '１': '1', '２': '2', '３': '3', '４': '4', '５': '5', '６': '6', '７': '7', '８': '8', '９': '9' };
  const chineseNumber = (raw: string): number => {
    const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (!/[十百千万]/u.test(raw)) return Number([...raw].map((char) => digits[char] ?? 0).join(''));
    let total = 0;
    let section = 0;
    let number = 0;
    for (const char of raw) {
      if (digits[char] !== undefined) {
        number = digits[char];
      } else if (char === '十') {
        section += (number || 1) * 10;
        number = 0;
      } else if (char === '百') {
        section += (number || 1) * 100;
        number = 0;
      } else if (char === '千') {
        section += (number || 1) * 1000;
        number = 0;
      } else if (char === '万') {
        total += (section + number) * 10_000;
        section = 0;
        number = 0;
      }
    }
    return total + section + number;
  };

  return text
    .replace(/[０-９]/g, (char) => digitMap[char] ?? char)
    .replace(/([零〇一二两三四五六七八九十百千万]+)/gu, (match) => String(chineseNumber(match)))
    .replace(/(?<=\d)[，,](?=\d{3}\b)/g, ',');
}

export function normalizePunctuation(text: string): string {
  return text
    .replace(/([，。！？；：])(?=[^\s，。！？；：])/gu, '$1')
    .replace(/\s+([，。！？；：])/gu, '$1')
    .replace(/([,;:!?])(?=[^\s,;:!?])/g, (match) => ({ ',': '，', ';': '；', ':': '：', '!': '！', '?': '？' }[match] ?? match));
}

export function applyRules(text: string, model: DeskModel): { text: string; used: string[] } {
  let next = text;
  const used: string[] = [];
  for (const rule of model.rules.filter((item) => item.enabled)) {
    if (!rule.source || !next) continue;
    const flags = rule.caseSensitive ? 'g' : 'gi';
    const expression = new RegExp(rule.source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    if (expression.test(next)) {
      next = next.replace(expression, rule.replacement);
      used.push(rule.id);
    }
  }
  return { text: normalizePunctuation(next), used };
}

export function isDuplicate(candidate: CaptionSegment, existing: CaptionSegment[]): CaptionSegment | undefined {
  const normalize = (value: string) => value.replace(/[\s，。！？；：,.;:!?]/g, '').toLocaleLowerCase();
  const candidateText = normalize(candidate.corrected || candidate.original);
  return existing.find((segmentItem) => {
    if (segmentItem.id === candidate.id || segmentItem.state === 'ignored') return false;
    const text = normalize(segmentItem.corrected || segmentItem.original);
    if (!candidateText || !text) return false;
    return text === candidateText || (Math.abs(segmentItem.startTime - candidate.startTime) < 12 && (text.includes(candidateText) || candidateText.includes(text)));
  });
}

export function mergeConfirmedSegments(model: DeskModel): DeskModel {
  const seen: string[] = [];
  const segments = model.segments
    .map((item) => ({ ...item }))
    .sort((a, b) => a.sequence - b.sequence || a.startTime - b.startTime)
    .map((item): CaptionSegment => {
      if (item.source === 'offline' && item.state === 'confirmed') {
        item.source = item.confirmedAt && Date.now() - item.confirmedAt > 90_000 ? 'offline' : 'live';
        item.staleReason = Date.now() - item.receivedAt > 90_000 ? `离线恢复后合并，原始片段已延迟 ${Math.round((Date.now() - item.receivedAt) / 1000)} 秒` : undefined;
        if (item.staleReason) item.state = 'stale';
      }
      const duplicate = isDuplicate(item, seen.map((id) => model.segments.find((segmentItem) => segmentItem.id === id)).filter(Boolean) as CaptionSegment[]);
      if (duplicate && item.state !== 'confirmed') {
        item.state = 'duplicate';
        item.duplicateOf = duplicate.id;
      }
      if (item.state !== 'ignored') seen.push(item.id);
      return item;
    });

  return {
    ...model,
    segments,
    connection: 'connected',
    simulatedDelay: Math.max(0.8, model.simulatedDelay - 0.7),
    lastMergedAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function queueStats(model: DeskModel) {
  const pending = model.segments.filter((item) => item.state === 'pending');
  const stale = model.segments.filter((item) => item.state === 'stale');
  const duplicate = model.segments.filter((item) => item.state === 'duplicate');
  const offline = model.segments.filter((item) => item.source === 'offline' && item.state === 'confirmed');
  return {
    pending: pending.length,
    stale: stale.length,
    duplicate: duplicate.length,
    offline: offline.length,
    backlog: pending.length + stale.length + duplicate.length + offline.length,
    oldestWaitSeconds: pending.length ? Math.max(...pending.map((item) => Math.round((Date.now() - item.receivedAt) / 1000))) : 0,
  };
}

export function createLiveSegment(sequence: number): CaptionSegment {
  const speakers = ['主持人', '主讲人', '嘉宾 / 周然', '现场提问'];
  const samples = [
    '接下来请产品团队介绍新的工作流。',
    '请注意屏幕右侧的实时队列状态。',
    '在弱网环境下我们会保留未确认片段。',
    '如果网络恢复,系统会按照时间顺序自动合并。',
    '这段字幕包含二零二五年的项目数据。',
    '大家可以在会后查看完整回放和术语表。',
  ];
  const start = Math.max(0, sequence * 9 - 10);
  return {
    id: `seg-live-${sequence}-${Date.now().toString(36)}`,
    sequence,
    startTime: start,
    receivedAt: Date.now(),
    speaker: speakers[(sequence - 1) % speakers.length],
    original: samples[(sequence - 1) % samples.length],
    corrected: samples[(sequence - 1) % samples.length],
    numberHints: '',
    source: 'live',
    state: 'pending',
    revision: 0,
    tags: [],
  };
}

export function simulateLatency(model: DeskModel): DeskModel {
  if (model.connection === 'offline') return model;
  const step = model.connection === 'degraded' ? 0.7 : model.simulatedDelay > 2.8 ? -0.3 : 0.15;
  const delay = Math.max(0.7, Math.min(8.9, Number((model.simulatedDelay + step).toFixed(1))));
  const applyStream = model.autoStream && Math.random() > 0.68;
  let nextSequence = model.nextSequence;
  let segments = model.segments;
  if (applyStream) {
    const candidate = createLiveSegment(model.nextSequence);
    const duplicate = isDuplicate(candidate, segments);
    segments = [...segments, duplicate ? { ...candidate, state: 'duplicate', duplicateOf: duplicate.id, staleReason: `与第 ${duplicate.sequence} 段重复` } : candidate];
    nextSequence += 1;
  }
  const pendingCutoff = Date.now() - 90_000;
  segments = segments.map((item) => item.state === 'pending' && item.receivedAt < pendingCutoff
    ? { ...item, state: 'stale', staleReason: `片段已等待 ${Math.round((Date.now() - item.receivedAt) / 1000)} 秒` }
    : item);
  return {
    ...model,
    segments,
    nextSequence,
    simulatedDelay: delay,
    connection: delay > 4.2 ? 'degraded' : model.connection,
    updatedAt: Date.now(),
  };
}

export function toSrt(model: DeskModel): string {
  const stamp = (seconds: number, separator = ',') => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const millis = Math.round((seconds - Math.floor(seconds)) * 1000);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}${separator}${String(millis).padStart(3, '0')}`;
  };
  return model.segments
    .filter((item) => item.state === 'confirmed')
    .sort((a, b) => a.startTime - b.startTime)
    .map((item, index) => `${index + 1}\n${stamp(item.startTime)} --> ${stamp(item.startTime + 7)}\n[${item.speaker}] ${item.corrected}\n`)
    .join('\n');
}

// ─────────────────────────────────────────────────────────────
// 旧稿升级迁移
// ─────────────────────────────────────────────────────────────

export interface MigrationResult {
  model: DeskModel;
  notes: string[];
  migrated: boolean;
}

const VALID_SEGMENT_STATES: SegmentState[] = ['pending', 'confirmed', 'duplicate', 'stale', 'ignored'];

/**
 * 旧稿首次打开时升级到恢复点格式。
 * 接不上的片段不丢弃，原样保留在稿中，原因写入 migrationNotes。
 */
export function migrateDraft(raw: unknown): MigrationResult {
  const fallback = createInitialModel();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { model: fallback, notes: [], migrated: false };
  }
  const parsed = raw as Partial<DeskModel> & { schemaVersion?: number };
  const version = typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : 1;
  if (version >= SCHEMA_VERSION && Array.isArray(parsed.segments)) {
    return { model: parsed as DeskModel, notes: [], migrated: false };
  }

  const notes: string[] = [];
  if (!Array.isArray(parsed.segments)) {
    notes.push('旧稿中没有找到片段数组，无法接上恢复点，已载入演示数据，旧内容原样保留在浏览器存储中未被覆盖。');
    return { model: fallback, notes, migrated: true };
  }

  const segments = parsed.segments.map((rawSegment, index) => {
    const item = { ...(rawSegment as Partial<CaptionSegment>) };
    const reasons: string[] = [];
    if (!item.id) {
      item.id = `seg-migrated-${index}-${Date.now().toString(36)}`;
      reasons.push('缺少片段编号，已重新分配');
    }
    if (typeof item.sequence !== 'number') {
      item.sequence = index + 1;
      reasons.push('序号缺失，已按顺序补排');
    }
    if (typeof item.startTime !== 'number') {
      item.startTime = index * 9;
      reasons.push('开始时间缺失，已按顺序补算');
    }
    if (!item.speaker) {
      item.speaker = '未知发言人';
      reasons.push('发言人缺失');
    }
    if (typeof item.original !== 'string' && typeof item.corrected !== 'string') {
      item.original = '';
      item.corrected = '';
      reasons.push('原文与校对文本均缺失，片段原样保留但无法显示内容');
    } else {
      if (typeof item.original !== 'string') {
        item.original = item.corrected as string;
        reasons.push('原文缺失，已用校对文本补齐');
      }
      if (typeof item.corrected !== 'string') {
        item.corrected = item.original;
        reasons.push('校对文本缺失，已用原文补齐');
      }
    }
    if (!VALID_SEGMENT_STATES.includes(item.state as SegmentState)) {
      reasons.push(`状态值 "${String(item.state)}" 无法识别，片段原样保留`);
    }
    if (typeof item.revision !== 'number') item.revision = 0;
    if (!Array.isArray(item.tags)) item.tags = [];
    if (typeof item.source !== 'string') item.source = 'live';
    if (typeof item.receivedAt !== 'number') item.receivedAt = Date.now();
    if (reasons.length) notes.push(`片段 #${item.sequence}（${item.id}）：${reasons.join('；')}。`);
    return item as CaptionSegment;
  });

  const rules = Array.isArray(parsed.rules) ? parsed.rules : [];
  if (!Array.isArray(parsed.rules)) notes.push('旧稿中没有找到术语规则，规则区已清空，可重新添加。');

  const model: DeskModel = {
    ...fallback,
    ...parsed,
    segments,
    rules,
    schemaVersion: SCHEMA_VERSION,
    migrationNotes: notes,
    airedList: Array.isArray(parsed.airedList) ? parsed.airedList : [],
    redeliveryQueue: Array.isArray(parsed.redeliveryQueue) ? parsed.redeliveryQueue : [],
    reconciledAt: typeof parsed.reconciledAt === 'number' ? parsed.reconciledAt : undefined,
    lastCheckpointId: typeof parsed.lastCheckpointId === 'string' ? parsed.lastCheckpointId : undefined,
    eventName: typeof parsed.eventName === 'string' ? parsed.eventName : fallback.eventName,
    eventDate: typeof parsed.eventDate === 'string' ? parsed.eventDate : fallback.eventDate,
    selectedId: typeof parsed.selectedId === 'string' ? parsed.selectedId : (segments[0]?.id ?? ''),
    connection: parsed.connection ?? 'connected',
    fontSize: typeof parsed.fontSize === 'number' ? parsed.fontSize : 18,
    nextSequence: typeof parsed.nextSequence === 'number' ? parsed.nextSequence : segments.length + 1,
    updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
  };
  notes.unshift(`旧稿格式（v${version}）已升级到 v${SCHEMA_VERSION} 恢复点格式，共接入 ${segments.length} 个片段、${rules.length} 条规则。接不上的片段已原样保留在稿中，原因见下。`);
  return { model, notes, migrated: true };
}

// ─────────────────────────────────────────────────────────────
// 恢复点（崩溃前先写恢复点，再动当前稿）
// ─────────────────────────────────────────────────────────────

function fingerprint(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return `fp-${(hash >>> 0).toString(36)}-${text.length}`;
}

function readCheckpointList(): RecoveryPoint[] {
  try {
    const raw = localStorage.getItem(CHECKPOINT_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as RecoveryPoint[];
    if (!Array.isArray(list)) return [];
    return list.filter((cp) => cp && typeof cp.id === 'string' && typeof cp.savedAt === 'number' && cp.model && Array.isArray((cp.model as DeskModel).segments));
  } catch {
    return [];
  }
}

function writeCheckpointList(list: RecoveryPoint[]): void {
  // 确认类恢复点优先保留，避免环形缓冲被编辑快照冲掉。
  const confirms = list.filter((cp) => cp.kind === 'confirm').sort((a, b) => b.savedAt - a.savedAt).slice(-12);
  const others = list.filter((cp) => cp.kind !== 'confirm').sort((a, b) => b.savedAt - a.savedAt).slice(-8);
  const kept = [...confirms, ...others].sort((a, b) => a.savedAt - b.savedAt).slice(-CHECKPOINT_LIMIT);
  localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(kept));
}

export interface CheckpointWriteResult {
  ok: boolean;
  id?: string;
}

/** 写一份恢复点。存储异常或故障开关触发时返回失败，由调用方重试/回滚。 */
export function saveCheckpoint(model: DeskModel, kind: RecoveryPointKind, label: string, reason?: string): CheckpointWriteResult {
  try {
    if (localStorage.getItem(CHECKPOINT_FAULT_KEY) === '1') {
      localStorage.removeItem(CHECKPOINT_FAULT_KEY);
      throw new Error('模拟的恢复点写入失败');
    }
    const id = `cp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const fingerprints: Record<string, string> = {};
    for (const segment of model.segments) {
      fingerprints[segment.id] = fingerprint(segment.corrected || segment.original);
    }
    const point: RecoveryPoint = {
      id,
      schemaVersion: SCHEMA_VERSION,
      savedAt: Date.now(),
      kind,
      label,
      reason,
      model: cloneModel(model),
      counts: {
        confirmed: model.segments.filter((item) => item.state === 'confirmed').length,
        pending: model.segments.filter((item) => item.state === 'pending' || item.state === 'stale' || item.state === 'duplicate').length,
        rules: model.rules.length,
      },
      fingerprints,
    };
    writeCheckpointList([...readCheckpointList(), point]);
    return { ok: true, id };
  } catch {
    return { ok: false };
  }
}

/** 恢复点写失败后从上一版重试：再尝试写一次。 */
export function writeCheckpointWithRetry(model: DeskModel, kind: RecoveryPointKind, label: string): CheckpointWriteResult {
  const first = saveCheckpoint(model, kind, label);
  if (first.ok) return first;
  return saveCheckpoint(model, kind, label);
}

export function loadCheckpoints(): RecoveryPoint[] {
  return readCheckpointList().sort((a, b) => b.savedAt - a.savedAt);
}

/** 回滚到最近一版恢复点（当前稿写入失败时使用）。 */
export function rollbackFromCheckpoints(): DeskModel | undefined {
  const [latest] = loadCheckpoints();
  if (!latest) return undefined;
  return cloneModel(latest.model);
}

// ─────────────────────────────────────────────────────────────
// 播控已播清单对账
// ─────────────────────────────────────────────────────────────

export function normalizeCompare(text: string): string {
  return text.replace(/[\s，。！？；：,.;:!?、（）()"'“”‘’-]/gu, '').toLocaleLowerCase();
}

/** 播控清单与本地稿子在同一处对账：已上屏的锁定，本地新确认的排到清单后重新送播，对不上的列出来等人处理。 */
export function reconcileAiredList(model: DeskModel, items: AiredItem[]): { model: DeskModel; report: ReconcileReport } {
  const now = Date.now();
  const matched: string[] = [];
  const redeliver: string[] = [];
  const mismatches: ReconcileMismatch[] = [];

  const segments = model.segments.map((segment) => {
    const hit = items.find((item) => item.segmentId === segment.id);
    if (!hit) return segment;
    if (normalizeCompare(hit.text) === normalizeCompare(segment.corrected)) {
      matched.push(segment.id);
      return { ...segment, aired: true, locked: true, airedAt: hit.airedAt || now };
    }
    mismatches.push({
      kind: 'text-diff',
      segmentId: segment.id,
      sequence: segment.sequence,
      localText: segment.corrected,
      airedText: hit.text,
      reason: `第 ${segment.sequence} 段播控上屏文本与本地校对文本不一致`,
    });
    return segment;
  });

  for (const item of items) {
    if (!model.segments.some((segment) => segment.id === item.segmentId)) {
      mismatches.push({
        kind: 'aired-only',
        segmentId: item.segmentId,
        sequence: item.sequence,
        airedText: item.text,
        reason: `播控清单中有第 ${item.sequence} 段，但本地稿子找不到对应片段`,
      });
    }
  }

  for (const segment of segments) {
    if (segment.state === 'confirmed' && !items.some((item) => item.segmentId === segment.id)) {
      redeliver.push(segment.id);
    }
  }

  return {
    model: { ...model, segments, airedList: items, reconciledAt: now, redeliveryQueue: redeliver, updatedAt: now },
    report: { matched, redeliver, mismatches, reconciledAt: now },
  };
}

export function parseAiredList(text: string): AiredItem[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('不是合法的 JSON，请粘贴播控带回的已播清单');
  }
  const rawItems = Array.isArray(data) ? data : (data as { items?: unknown }).items;
  if (!Array.isArray(rawItems)) throw new Error('清单中没有 items 数组');
  return rawItems.map((raw, index) => {
    const item = raw as Partial<AiredItem>;
    if (typeof item.segmentId !== 'string' || !item.segmentId) throw new Error(`第 ${index + 1} 条缺少 segmentId`);
    if (typeof item.text !== 'string') throw new Error(`第 ${index + 1} 条缺少文本`);
    return {
      segmentId: item.segmentId,
      sequence: typeof item.sequence === 'number' ? item.sequence : index + 1,
      startTime: typeof item.startTime === 'number' ? item.startTime : 0,
      speaker: typeof item.speaker === 'string' ? item.speaker : '未知发言人',
      text: item.text,
      airedAt: typeof item.airedAt === 'number' ? item.airedAt : Date.now(),
    };
  });
}

/** 生成一份模拟的播控已播清单：最后一段留给本地重新送播，并人为制造一处文本差异和一条孤儿记录。 */
export function generateSimulatedAiredList(model: DeskModel): string {
  const confirmed = [...model.segments]
    .filter((segment) => segment.state === 'confirmed')
    .sort((a, b) => a.startTime - b.startTime);
  const items: AiredItem[] = [];
  const aired = confirmed.slice(0, -1);
  const diffIndex = aired.findIndex((segment) =>
    segment.original !== segment.corrected && normalizeCompare(segment.original) !== normalizeCompare(segment.corrected),
  );
  aired.forEach((segment, index) => {
    const useOriginal = index === diffIndex;
    const fallbackText = `${segment.corrected}（播控上屏版本与本地不一致）`;
    items.push({
      segmentId: segment.id,
      sequence: segment.sequence,
      startTime: segment.startTime,
      speaker: segment.speaker,
      text: useOriginal ? (normalizeCompare(segment.original) !== normalizeCompare(segment.corrected) ? segment.original : fallbackText) : segment.corrected,
      airedAt: Date.now() - (aired.length - index) * 60_000,
    });
  });
  items.push({
    segmentId: 'seg-aired-orphan-001',
    sequence: 999,
    startTime: 999,
    speaker: '播控',
    text: '播控系统带回的本地缺失片段，等待值班员核对。',
    airedAt: Date.now() - 30_000,
  });
  return JSON.stringify({ eventName: model.eventName, airedAt: Date.now(), items }, null, 2);
}
