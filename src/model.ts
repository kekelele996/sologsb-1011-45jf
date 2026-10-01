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
  /** 播控已播清单核对后标记为已上屏 */
  aired?: boolean;
  /** 已上屏片段锁定，不允许再改 */
  locked?: boolean;
  /** 本地已确认但不在已播清单中，排在清单后面重新送 */
  resend?: boolean;
  /** 旧稿升级时无法接入恢复点的片段保留原因 */
  migrationNote?: string;
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
  schemaVersion: number;
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
  reconciliation?: ReconciliationReport;
  updatedAt: number;
}

export type RecoveryKind = 'confirm' | 'merge' | 'reconcile' | 'migrate' | 'restore';

/** 每次确认前先落盘的恢复点：确认记录、术语规则和待确认队列的快照 */
export interface RecoveryPoint {
  id: string;
  createdAt: number;
  label: string;
  kind: RecoveryKind;
  counts: { confirmed: number; pending: number; rules: number };
  snapshot: RecoverySnapshot;
  status: 'complete' | 'failed';
  error?: string;
}

export interface RecoverySnapshot {
  segments: CaptionSegment[];
  rules: TermRule[];
  nextSequence: number;
  selectedId: string;
  connection: ConnectionState;
  reconciliation?: ReconciliationReport;
}

/** 播控带回的已播清单中的一条记录 */
export interface AiredEntry {
  id: string;
  sequence: number;
  text: string;
  airedAt: number;
}

/** 已播清单与本地稿的对账结果 */
export interface ReconciliationReport {
  importedAt: number;
  entryCount: number;
  matched: { entryId: string; segmentId: string }[];
  /** 本地已确认但未上屏，排在已播清单后面重新送 */
  resend: string[];
  /** 播控清单有记录但本地对不上，列出来等人处理 */
  unmatched: AiredEntry[];
}

export interface ToastMessage {
  id: string;
  kind: 'info' | 'success' | 'warning' | 'error';
  title: string;
  subtitle: string;
}

const now = Date.now();
export const STORAGE_KEY = 'sologsb-1011-live-caption-desk-v1';
export const RECOVERY_KEY = `${STORAGE_KEY}-recovery-log`;
export const SCHEMA_VERSION = 2;

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
    schemaVersion: SCHEMA_VERSION,
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

export function normalizeForMatch(value: string): string {
  return value.replace(/[\s，。！？；：,.;:!?]/g, '').toLocaleLowerCase();
}

export function isDuplicate(candidate: CaptionSegment, existing: CaptionSegment[]): CaptionSegment | undefined {
  const candidateText = normalizeForMatch(candidate.corrected || candidate.original);
  return existing.find((segmentItem) => {
    if (segmentItem.id === candidate.id || segmentItem.state === 'ignored') return false;
    const text = normalizeForMatch(segmentItem.corrected || segmentItem.original);
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
      if (item.source === 'offline' && item.state === 'confirmed' && !item.locked) {
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
  const locked = model.segments.filter((item) => item.locked);
  const resend = model.segments.filter((item) => item.resend && !item.aired && item.state === 'confirmed');
  return {
    pending: pending.length,
    stale: stale.length,
    duplicate: duplicate.length,
    offline: offline.length,
    locked: locked.length,
    resend: resend.length,
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

/** 生成一份恢复点，快照里带齐确认记录、术语规则和待确认队列 */
export function createRecoveryPoint(label: string, kind: RecoveryKind, model: DeskModel): RecoveryPoint {
  return {
    id: `rp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    createdAt: Date.now(),
    label,
    kind,
    counts: {
      confirmed: model.segments.filter((item) => item.state === 'confirmed').length,
      pending: model.segments.filter((item) => item.state === 'pending' || item.state === 'stale' || item.state === 'duplicate').length,
      rules: model.rules.length,
    },
    snapshot: {
      segments: structuredClone(model.segments),
      rules: structuredClone(model.rules),
      nextSequence: model.nextSequence,
      selectedId: model.selectedId,
      connection: model.connection,
      reconciliation: model.reconciliation ? structuredClone(model.reconciliation) : undefined,
    },
    status: 'complete',
  };
}

/** 解析播控带回的已播清单，每行一条，支持“序号 文本”“序号，文本”或纯文本 */
export function parseAiredList(raw: string): AiredEntry[] {
  const importedAt = Date.now();
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const matched = line.match(/^(\d{1,4})\s*[,，、.．]?\s+(.+)$/u) ?? line.match(/^(\d{1,4})[,，、.．](.+)$/u);
      return {
        id: `aired-${importedAt.toString(36)}-${index + 1}`,
        sequence: matched ? Number(matched[1]) : index + 1,
        text: (matched ? matched[2] : line).trim(),
        airedAt: importedAt,
      };
    });
}

/**
 * 已播清单与本地稿对账：
 * 对上的片段标记已上屏并锁定；本地已确认但没上屏的排进重送队列；
 * 清单里对不上的记录原样留在报告里等人处理。
 */
export function reconcileAiredList(model: DeskModel, entries: AiredEntry[]): DeskModel {
  const matched: ReconciliationReport['matched'] = [];
  const unmatched: AiredEntry[] = [];
  const usedSegments = new Set<string>();
  const confirmed = model.segments.filter((item) => item.state === 'confirmed');

  for (const entry of entries) {
    const target = normalizeForMatch(entry.text);
    let hit = confirmed.find((item) => !usedSegments.has(item.id) && item.sequence === entry.sequence);
    if (!hit && target) {
      hit = confirmed.find((item) => !usedSegments.has(item.id) && normalizeForMatch(item.corrected || item.original) === target);
    }
    if (hit) {
      matched.push({ entryId: entry.id, segmentId: hit.id });
      usedSegments.add(hit.id);
    } else {
      unmatched.push(entry);
    }
  }

  const matchedIds = new Set(matched.map((item) => item.segmentId));
  const resend = confirmed.filter((item) => !matchedIds.has(item.id) && !item.aired).map((item) => item.id);
  const resendIds = new Set(resend);

  const segments = model.segments.map((item) => {
    if (matchedIds.has(item.id)) return { ...item, aired: true, locked: true, resend: false };
    if (resendIds.has(item.id)) return { ...item, resend: true };
    return item;
  });

  return {
    ...model,
    segments,
    reconciliation: {
      importedAt: Date.now(),
      entryCount: entries.length,
      matched,
      resend,
      unmatched,
    },
    updatedAt: Date.now(),
  };
}

const SEGMENT_STATES: SegmentState[] = ['pending', 'confirmed', 'duplicate', 'stale', 'ignored'];
const SEGMENT_SOURCES: SegmentSource[] = ['live', 'offline', 'manual'];

/**
 * 旧稿（没有 schemaVersion 的 v1 数据）第一次打开时升级到恢复点体系。
 * 字段齐全的片段正常接入；接不上的片段按原样保留并写上 migrationNote 说明原因。
 */
export function migrateLegacyModel(raw: unknown): { model: DeskModel; notes: string[] } {
  const source = (raw ?? {}) as Record<string, unknown>;
  const fallback = createInitialModel();
  const migratedAt = Date.now();
  const notes: string[] = [];

  const segments: CaptionSegment[] = (Array.isArray(source.segments) ? source.segments : []).map((item: unknown, index: number) => {
    const record = (item ?? {}) as Record<string, unknown>;
    const missing: string[] = [];
    if (typeof record.id !== 'string' || !record.id) missing.push('ID');
    if (typeof record.sequence !== 'number') missing.push('序号');
    if (typeof record.original !== 'string' && typeof record.corrected !== 'string') missing.push('字幕文本');
    const segmentItem: CaptionSegment = {
      id: typeof record.id === 'string' && record.id ? record.id : `legacy-${migratedAt.toString(36)}-${index + 1}`,
      sequence: typeof record.sequence === 'number' ? record.sequence : index + 1,
      startTime: typeof record.startTime === 'number' ? record.startTime : index * 8,
      receivedAt: typeof record.receivedAt === 'number' ? record.receivedAt : migratedAt,
      confirmedAt: typeof record.confirmedAt === 'number' ? record.confirmedAt : undefined,
      speaker: typeof record.speaker === 'string' && record.speaker ? record.speaker : '未知发言人',
      original: typeof record.original === 'string' ? record.original : String(record.corrected ?? ''),
      corrected: typeof record.corrected === 'string' ? record.corrected : String(record.original ?? ''),
      numberHints: typeof record.numberHints === 'string' ? record.numberHints : '',
      source: SEGMENT_SOURCES.includes(record.source as SegmentSource) ? (record.source as SegmentSource) : 'live',
      state: SEGMENT_STATES.includes(record.state as SegmentState) ? (record.state as SegmentState) : 'pending',
      duplicateOf: typeof record.duplicateOf === 'string' ? record.duplicateOf : undefined,
      staleReason: typeof record.staleReason === 'string' ? record.staleReason : undefined,
      revision: typeof record.revision === 'number' ? record.revision : 0,
      tags: Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      aired: record.aired === true,
      locked: record.locked === true,
      resend: record.resend === true,
    };
    if (missing.length) {
      segmentItem.migrationNote = `旧稿缺少${missing.join('、')}，无法完整接入恢复点，已按原样保留`;
      notes.push(`第 ${index + 1} 段（${segmentItem.id}）：${segmentItem.migrationNote}`);
    }
    return segmentItem;
  });

  const rules: TermRule[] = (Array.isArray(source.rules) ? source.rules : []).map((item: unknown, index: number) => {
    const record = (item ?? {}) as Record<string, unknown>;
    return {
      id: typeof record.id === 'string' && record.id ? record.id : `term-legacy-${migratedAt.toString(36)}-${index + 1}`,
      source: typeof record.source === 'string' ? record.source : '',
      replacement: typeof record.replacement === 'string' ? record.replacement : '',
      speaker: typeof record.speaker === 'string' ? record.speaker : '',
      enabled: record.enabled !== false,
      caseSensitive: record.caseSensitive === true,
      usageCount: typeof record.usageCount === 'number' ? record.usageCount : 0,
      createdAt: typeof record.createdAt === 'number' ? record.createdAt : migratedAt,
    };
  }).filter((rule) => rule.source && rule.replacement);

  const model: DeskModel = {
    schemaVersion: SCHEMA_VERSION,
    eventName: typeof source.eventName === 'string' && source.eventName ? source.eventName : fallback.eventName,
    eventDate: typeof source.eventDate === 'string' && source.eventDate ? source.eventDate : fallback.eventDate,
    segments,
    rules,
    selectedId: typeof source.selectedId === 'string' ? source.selectedId : (segments[0]?.id ?? ''),
    connection: source.connection === 'degraded' || source.connection === 'offline' ? source.connection : 'connected',
    simulatedDelay: typeof source.simulatedDelay === 'number' ? source.simulatedDelay : fallback.simulatedDelay,
    fontSize: typeof source.fontSize === 'number' ? Math.max(14, Math.min(28, source.fontSize)) : fallback.fontSize,
    nextSequence: typeof source.nextSequence === 'number' ? source.nextSequence : segments.length + 1,
    autoStream: source.autoStream !== false,
    lastMergedAt: typeof source.lastMergedAt === 'number' ? source.lastMergedAt : undefined,
    reconciliation: undefined,
    updatedAt: typeof source.updatedAt === 'number' ? source.updatedAt : migratedAt,
  };
  return { model, notes };
}
