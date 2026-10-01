import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import {
  applyRules,
  cloneModel,
  createInitialModel,
  createRecoveryPoint,
  mergeConfirmedSegments,
  migrateLegacyModel,
  normalizeNumbers,
  parseAiredList,
  queueStats,
  reconcileAiredList,
  RECOVERY_KEY,
  SCHEMA_VERSION,
  STORAGE_KEY,
  simulateLatency,
  toSrt,
  type CaptionSegment,
  type ConnectionState,
  type DeskModel,
  type RecoveryKind,
  type RecoveryPoint,
  type SegmentState,
  type ToastMessage,
} from './model';

const HISTORY_LIMIT = 80;
const RECOVERY_LIMIT = 30;

function formatClock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

function formatAge(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒前`;
}

function stateLabel(state: SegmentState): string {
  return {
    pending: '待确认',
    confirmed: '已确认',
    duplicate: '重复片段',
    stale: '过期修改',
    ignored: '已忽略',
  }[state];
}

function recoveryKindLabel(kind: RecoveryKind): string {
  return {
    confirm: '确认',
    merge: '离线合并',
    reconcile: '播控对账',
    migrate: '旧稿升级',
    restore: '恢复点还原',
  }[kind];
}

function connectionLabel(state: ConnectionState): string {
  return { connected: '连接稳定', degraded: '延迟波动', offline: '离线校正' }[state];
}

@customElement('caption-desk')
export class CaptionDesk extends LitElement {
  static styles = css`
    :host {
      display: block;
      min-height: 100vh;
      --caption-font-size: 18px;
      color: var(--cds-text-primary, #161616);
      background: var(--cds-background, #f4f4f4);
      font-family: "IBM Plex Sans", "PingFang SC", sans-serif;
    }

    * { box-sizing: border-box; }

    .shell {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      background:
        linear-gradient(90deg, rgba(15,98,254,.025) 1px, transparent 1px),
        linear-gradient(rgba(15,98,254,.025) 1px, transparent 1px),
        var(--cds-background, #f4f4f4);
      background-size: 24px 24px;
    }

    .shell.dark {
      --cds-background: #161616;
      --cds-layer: #262626;
      --cds-layer-01: #262626;
      --cds-layer-02: #393939;
      --cds-field: #262626;
      --cds-text-primary: #f4f4f4;
      --cds-text-secondary: #c6c6c6;
      --cds-border-subtle: #393939;
      --cds-border-strong: #6f6f6f;
      color: #f4f4f4;
    }

    .topbar {
      min-height: 64px;
      padding: 8px 18px 8px 20px;
      display: grid;
      grid-template-columns: minmax(330px, 1fr) auto minmax(420px, 1fr);
      align-items: center;
      gap: 20px;
      background: #161616;
      color: #f4f4f4;
      border-bottom: 1px solid #393939;
      position: relative;
      z-index: 5;
    }

    .brand { display: flex; align-items: center; gap: 14px; min-width: 0; }
    .brand-mark {
      width: 38px; height: 38px; display: grid; place-items: center;
      border: 1px solid #78a9ff; color: #78a9ff; font: 600 11px/1 "IBM Plex Mono", monospace;
      clip-path: polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%);
    }
    .brand-copy { min-width: 0; }
    .brand-copy strong { display: block; font-size: 15px; letter-spacing: .015em; white-space: nowrap; }
    .brand-copy span { display: block; color: #a8a8a8; font-size: 11px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    .connection-pill {
      justify-self: center; display: flex; align-items: center; gap: 10px; padding: 8px 13px;
      min-width: 260px; background: #262626; border: 1px solid #525252;
    }
    .connection-dot { width: 9px; height: 9px; flex: 0 0 auto; border-radius: 50%; background: #42be65; box-shadow: 0 0 0 4px rgba(66,190,101,.13); }
    .connection-pill.degraded .connection-dot { background: #f1c21b; box-shadow: 0 0 0 4px rgba(241,194,27,.14); }
    .connection-pill.offline .connection-dot { background: #fa4d56; box-shadow: 0 0 0 4px rgba(250,77,86,.14); }
    .connection-copy { min-width: 0; }
    .connection-copy strong { display: block; font-size: 12px; }
    .connection-copy small { display: block; color: #c6c6c6; margin-top: 2px; font-size: 10px; }

    .header-actions { justify-self: end; display: flex; align-items: center; gap: 8px; }
    .header-actions cds-button { --cds-button-primary: #0f62fe; }

    .status-strip {
      min-height: 60px; padding: 8px 20px; display: grid; grid-template-columns: 1.5fr repeat(4, minmax(118px, .6fr)) auto;
      gap: 0; align-items: stretch; background: var(--cds-layer, #fff); border-bottom: 1px solid var(--cds-border-subtle, #e0e0e0);
    }
    .status-cell { padding: 7px 16px; border-right: 1px solid var(--cds-border-subtle, #e0e0e0); display: flex; flex-direction: column; justify-content: center; }
    .status-cell:first-child { padding-left: 4px; }
    .status-cell:last-child { border-right: 0; }
    .status-cell strong { font-size: 20px; font-weight: 400; line-height: 1.05; font-variant-numeric: tabular-nums; }
    .status-cell span { margin-top: 3px; color: var(--cds-text-secondary, #525252); font-size: 10px; letter-spacing: .03em; }
    .status-cell.warning strong, .status-cell.warning span { color: #b28600; }
    .status-cell.danger strong, .status-cell.danger span { color: #da1e28; }
    .status-cell.hero strong { font-size: 14px; }
    .queue-track { width: 100%; height: 3px; margin-top: 6px; background: #e0e0e0; }
    .queue-track > span { display: block; height: 100%; background: #0f62fe; transition: width .3s ease; }
    .font-controls { min-width: 190px; padding: 7px 4px 7px 18px; display: flex; align-items: center; gap: 8px; }
    .font-controls label { color: var(--cds-text-secondary, #525252); font-size: 10px; }

    .workspace {
      flex: 1;
      min-height: 0; display: grid; grid-template-columns: minmax(390px, .95fr) minmax(430px, 1.05fr) minmax(370px, .9fr);
      gap: 1px; background: var(--cds-border-subtle, #e0e0e0); overflow: hidden;
    }

    .column { min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--cds-background, #f4f4f4); }
    .column-head {
      min-height: 62px; padding: 11px 14px 9px 18px; display: flex; align-items: center; justify-content: space-between; gap: 12px;
      background: var(--cds-layer, #fff); border-bottom: 1px solid var(--cds-border-subtle, #e0e0e0);
    }
    .column-head h2 { margin: 0; font-size: 14px; font-weight: 600; }
    .column-head p { margin: 4px 0 0; color: var(--cds-text-secondary, #525252); font-size: 10px; }
    .column-body { min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-color: #8d8d8d transparent; }

    .segment-list { padding: 8px; display: flex; flex-direction: column; gap: 1px; }
    .segment-card {
      width: 100%; border: 0; border-left: 3px solid transparent; background: var(--cds-layer, #fff);
      color: inherit; text-align: left; padding: 11px 12px 10px 14px; cursor: pointer; position: relative;
    }
    .segment-card:hover { background: var(--cds-layer-hover, #e8e8e8); }
    .segment-card.selected { border-left-color: #0f62fe; background: var(--cds-layer-selected, #edf5ff); outline: 1px solid #78a9ff; }
    .segment-card.duplicate { border-left-color: #a56eff; }
    .segment-card.stale { border-left-color: #f1c21b; background: color-mix(in srgb, #fff 92%, #f1c21b 8%); }
    .segment-card.confirmed { border-left-color: #42be65; }
    .segment-meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 7px; }
    .segment-meta > span:first-child { color: var(--cds-text-secondary, #525252); font: 500 10px/1 "IBM Plex Mono", monospace; }
    .segment-state { font-size: 10px; color: #525252; }
    .segment-state.stale { color: #8d6e00; }
    .segment-state.duplicate { color: #6929c4; }
    .segment-state.confirmed { color: #198038; }
    .segment-text { margin: 0; font-size: var(--caption-font-size); line-height: 1.5; }
    .segment-corrected { margin: 6px 0 0; padding-left: 8px; border-left: 2px solid #42be65; color: #198038; font-size: calc(var(--caption-font-size) * .88); line-height: 1.45; }
    .segment-foot { display: flex; align-items: center; gap: 8px; margin-top: 8px; color: var(--cds-text-secondary, #525252); font-size: 10px; }
    .segment-foot b { color: #0f62fe; font-weight: 500; }
    .issue-note { margin-top: 8px; padding: 7px 8px; background: #fff8e1; border-left: 2px solid #f1c21b; color: #684e00; font-size: 10px; line-height: 1.45; }
    .duplicate-note { background: #f6f2ff; border-color: #a56eff; color: #491d8b; }

    .empty { padding: 48px 24px; text-align: center; color: var(--cds-text-secondary, #525252); }
    .empty strong { display: block; color: var(--cds-text-primary, #161616); margin-bottom: 6px; }
    .empty p { margin: 0; font-size: 11px; line-height: 1.5; }

    .editor-scroll { padding: 14px; overflow: auto; }
    .editor-card { background: var(--cds-layer, #fff); border: 1px solid var(--cds-border-subtle, #e0e0e0); }
    .editor-top { padding: 12px 14px; border-bottom: 1px solid var(--cds-border-subtle, #e0e0e0); display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: start; }
    .editor-time { color: #0f62fe; font: 500 12px/1.4 "IBM Plex Mono", monospace; }
    .editor-title { margin: 4px 0 0; font-size: 12px; color: var(--cds-text-secondary, #525252); }
    .editor-status { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
    .editor-form { padding: 14px; display: flex; flex-direction: column; gap: 13px; }
    .form-grid { display: grid; grid-template-columns: minmax(130px, .6fr) 1fr; gap: 12px; align-items: end; }
    .caption-input { min-height: 158px; --cds-body-compact-01-font-size: var(--caption-font-size); --cds-body-compact-02-font-size: var(--caption-font-size); }
    .edit-toolbar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .edit-toolbar > span { margin-right: 5px; color: var(--cds-text-secondary, #525252); font-size: 10px; }
    .number-input { width: 110px; }
    .rule-suggestions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .rule-suggestions small { color: var(--cds-text-secondary, #525252); }
    .confirm-bar { padding: 12px 14px 14px; display: flex; align-items: center; justify-content: space-between; gap: 12px; border-top: 1px solid var(--cds-border-subtle, #e0e0e0); background: var(--cds-layer-02, #f4f4f4); }
    .confirm-hint { color: var(--cds-text-secondary, #525252); font-size: 10px; line-height: 1.4; }
    .confirm-hint kbd { padding: 3px 5px; border: 1px solid var(--cds-border-strong, #8d8d8d); background: var(--cds-layer, #fff); color: var(--cds-text-primary, #161616); font: 10px/1 "IBM Plex Mono", monospace; }

    .inspector { padding: 12px 14px 20px; display: flex; flex-direction: column; gap: 14px; }
    .inspector-section { background: var(--cds-layer, #fff); border: 1px solid var(--cds-border-subtle, #e0e0e0); }
    .inspector-section-head { padding: 10px 12px; border-bottom: 1px solid var(--cds-border-subtle, #e0e0e0); display: flex; justify-content: space-between; align-items: center; gap: 10px; }
    .inspector-section-head h3 { margin: 0; font-size: 12px; }
    .inspector-section-head span { color: var(--cds-text-secondary, #525252); font-size: 10px; }
    .rule-list { padding: 5px 0; }
    .rule-item { padding: 8px 10px; display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center; border-bottom: 1px solid var(--cds-border-subtle, #e0e0e0); }
    .rule-item:last-child { border-bottom: 0; }
    .rule-item strong { display: block; font-size: 11px; }
    .rule-item p { margin: 3px 0 0; color: var(--cds-text-secondary, #525252); font-size: 10px; }
    .rule-item-actions { display: flex; gap: 3px; }
    .rule-form { padding: 10px; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .rule-form cds-text-input, .rule-form cds-button { width: 100%; }
    .rule-form .full { grid-column: 1 / -1; }
    .live-timeline { padding: 6px 0; }
    .live-item { padding: 8px 11px; border-left: 3px solid #42be65; margin: 0 10px 7px; background: var(--cds-layer-02, #f4f4f4); }
    .live-item time { color: #198038; font: 500 9px/1 "IBM Plex Mono", monospace; }
    .live-item p { margin: 5px 0 0; font-size: var(--caption-font-size); line-height: 1.45; }
    .live-item small { display: block; margin-top: 4px; color: var(--cds-text-secondary, #525252); font-size: 9px; }
    .delivery-status { margin: 0 10px 10px; padding: 9px 10px; background: #edf5ff; border-left: 3px solid #0f62fe; color: #0043ce; font-size: 10px; line-height: 1.45; }

    .recovery-banner {
      padding: 9px 20px; display: flex; align-items: center; gap: 12px;
      background: #fff1f1; border-bottom: 1px solid #ffb3b8; color: #a2191f; font-size: 12px;
    }
    .recovery-banner strong { font-weight: 600; }
    .recovery-banner span { flex: 1; min-width: 0; }

    .recovery-overlay {
      position: fixed; inset: 0; z-index: 30; display: grid; place-items: center;
      background: rgba(0, 0, 0, .52); padding: 24px;
    }
    .recovery-dialog {
      width: min(720px, 94vw); max-height: 84vh; display: flex; flex-direction: column;
      background: var(--cds-layer, #fff); color: var(--cds-text-primary, #161616);
      border: 1px solid var(--cds-border-subtle, #e0e0e0); box-shadow: 0 16px 40px rgba(0, 0, 0, .3);
    }
    .recovery-head { padding: 16px 18px 12px; display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; border-bottom: 1px solid var(--cds-border-subtle, #e0e0e0); }
    .recovery-head h2 { margin: 0; font-size: 16px; font-weight: 600; }
    .recovery-head p { margin: 6px 0 0; color: var(--cds-text-secondary, #525252); font-size: 11px; line-height: 1.5; }
    .recovery-list { min-height: 0; overflow: auto; padding: 12px 18px; display: flex; flex-direction: column; gap: 8px; }
    .recovery-item {
      display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: center;
      padding: 11px 12px; background: var(--cds-background, #f4f4f4);
      border: 1px solid var(--cds-border-subtle, #e0e0e0); border-left: 3px solid #42be65;
    }
    .recovery-item.failed { border-left-color: #da1e28; }
    .recovery-item-copy { min-width: 0; }
    .recovery-item-copy strong { display: block; font-size: 12px; }
    .recovery-item-copy p { margin: 4px 0 0; color: var(--cds-text-secondary, #525252); font-size: 10px; line-height: 1.5; }
    .recovery-item-copy .recovery-error { color: #da1e28; }
    .recovery-item-actions { display: flex; gap: 6px; }
    .recovery-foot {
      padding: 10px 18px; display: flex; justify-content: space-between; align-items: center; gap: 12px;
      border-top: 1px solid var(--cds-border-subtle, #e0e0e0); color: var(--cds-text-secondary, #525252); font-size: 10px;
    }

    .timeline-divider {
      margin: 10px 10px 7px; padding: 7px 10px; background: #edf5ff; border-left: 3px solid #0f62fe;
      color: #0043ce; font-size: 10px; line-height: 1.4;
    }
    .timeline-divider.resend-divider { background: #fff8e1; border-left-color: #f1c21b; color: #684e00; }
    .live-item.locked { border-left-color: #0f62fe; }
    .live-item.locked time { color: #0043ce; }
    .live-item.resend { border-left-color: #f1c21b; }
    .live-item.resend time { color: #8d6e00; }

    .reconcile-box { padding: 10px; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
    .reconcile-box cds-textarea { width: 100%; }
    .reconcile-summary { display: flex; gap: 14px; padding: 8px 10px; background: var(--cds-layer-02, #f4f4f4); font-size: 10px; color: var(--cds-text-secondary, #525252); }
    .reconcile-summary b { color: var(--cds-text-primary, #161616); font-size: 12px; }
    .reconcile-ok { padding: 8px 10px; background: #defbe6; border-left: 3px solid #42be65; color: #044317; font-size: 10px; }
    .unmatched-list { width: 100%; padding: 8px 10px; background: #fff8e1; border-left: 3px solid #f1c21b; }
    .unmatched-list > p { margin: 0 0 6px; color: #684e00; font-size: 10px; }
    .unmatched-item { display: grid; grid-template-columns: auto 1fr; gap: 8px; padding: 5px 0; border-top: 1px solid rgba(0, 0, 0, .08); }
    .unmatched-item span { color: #8d6e00; font: 500 10px/1.5 "IBM Plex Mono", monospace; }
    .unmatched-item p { margin: 0; font-size: 11px; line-height: 1.5; color: var(--cds-text-primary, #161616); }

    .migrate-note { background: #e8daff; border-color: #8a3ffc; color: #491d8b; }

    .toast-stack { position: fixed; right: 18px; bottom: 18px; z-index: 20; width: 380px; display: flex; flex-direction: column; gap: 8px; }
    cds-toast-notification { box-shadow: 0 8px 22px rgba(0,0,0,.18); }

    @media (max-width: 1280px) {
      .workspace { grid-template-columns: minmax(340px, .85fr) minmax(410px, 1fr) minmax(330px, .85fr); }
      .status-strip { grid-template-columns: 1.4fr repeat(4, minmax(100px, .55fr)); }
      .font-controls { display: none; }
    }

    @media (max-width: 980px) {
      .topbar { grid-template-columns: 1fr auto; }
      .connection-pill { grid-row: 2; grid-column: 1 / -1; justify-self: stretch; min-width: 0; }
      .workspace { grid-template-columns: 1fr; overflow: visible; }
      .column { min-height: 520px; }
      .shell { display: block; }
      .status-strip { grid-template-columns: repeat(4, 1fr); }
      .status-cell.hero { grid-column: 1 / -1; }
    }
  `;

  private draftCorrupt = false;
  private pendingMigration = false;
  private migrationNotes: string[] = [];
  @state() private model: DeskModel = this.loadModel();
  @state() private dark = localStorage.getItem(`${STORAGE_KEY}-theme`) === 'dark';
  @state() private toasts: ToastMessage[] = [];
  @state() private ruleSource = '';
  @state() private ruleReplacement = '';
  @state() private ruleSpeaker = '';
  @state() private filter: 'active' | 'all' | 'attention' = 'active';
  @state() private showRuleForm = false;
  @state() private recoveryOpen = false;
  @state() private recoveryPoints: RecoveryPoint[] = [];
  @state() private failedPoint: RecoveryPoint | null = null;
  @state() private airedDraft = '';
  private past: DeskModel[] = [];
  private future: DeskModel[] = [];
  private ticker?: number;

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('keydown', this.handleShortcut);
    if (this.pendingMigration) {
      this.pendingMigration = false;
      // 旧稿第一次打开：升级后立即补一份恢复点，让旧数据接入恢复体系
      try {
        this.appendRecoveryPoint(createRecoveryPoint('旧稿升级接入恢复点', 'migrate', this.model));
      } catch {
        // 恢复点写不进去不阻塞升级，当前稿仍会正常保存
      }
      this.persist();
      if (this.migrationNotes.length) {
        this.pushToast('warning', '旧稿已升级接入恢复点', `${this.migrationNotes.length} 个片段接不上，已原样保留并注明原因`);
      } else {
        this.pushToast('info', '旧稿已升级接入恢复点', '全部片段和术语规则已纳入恢复体系');
      }
    }
    const points = this.readRecoveryLog();
    const latestComplete = points.filter((point) => point.status === 'complete').sort((a, b) => b.createdAt - a.createdAt)[0];
    const crashed = Boolean(latestComplete && latestComplete.createdAt > this.model.updatedAt);
    const hasFailed = points.some((point) => point.status === 'failed');
    if (crashed || hasFailed || (this.draftCorrupt && points.length)) {
      // 崩溃或草稿损坏后重开：列出能找回的内容，由值班员挑一版接着用
      this.recoveryPoints = points;
      this.recoveryOpen = true;
      if (crashed) this.pushToast('warning', '检测到上次未正常保存', '恢复点里有崩溃前的确认记录，请挑选一版继续');
    }
    this.ticker = window.setInterval(() => {
      const next = simulateLatency(this.model);
      const changed = JSON.stringify(next.segments) !== JSON.stringify(this.model.segments) || next.connection !== this.model.connection;
      if (!changed) return;
      this.model = next;
      this.persist();
    }, 5_000);
  }

  disconnectedCallback(): void {
    window.removeEventListener('keydown', this.handleShortcut);
    if (this.ticker) window.clearInterval(this.ticker);
    super.disconnectedCallback();
  }

  private loadModel(): DeskModel {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as DeskModel;
        if (parsed.segments?.length) {
          if (parsed.schemaVersion === SCHEMA_VERSION) return parsed;
          // 旧稿第一次打开：先升级到恢复点体系，接不上的片段原样保留
          const { model, notes } = migrateLegacyModel(parsed);
          this.pendingMigration = true;
          this.migrationNotes = notes;
          return model;
        }
      }
    } catch {
      // 损坏草稿会回退到演示数据，恢复点日志仍可用来找回内容。
      this.draftCorrupt = true;
    }
    return createInitialModel();
  }

  private persist(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...this.model, updatedAt: Date.now() }));
  }

  private readRecoveryLog(): RecoveryPoint[] {
    try {
      const raw = localStorage.getItem(RECOVERY_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as RecoveryPoint[];
      return Array.isArray(parsed) ? parsed.filter((point) => point && point.snapshot) : [];
    } catch {
      return [];
    }
  }

  private appendRecoveryPoint(point: RecoveryPoint): void {
    const points = this.readRecoveryLog().filter((item) => item.id !== point.id);
    localStorage.setItem(RECOVERY_KEY, JSON.stringify([...points, point].slice(-RECOVERY_LIMIT)));
  }

  /**
   * 先写恢复点再动当前稿：恢复点落盘成功才应用修改；
   * 写失败时当前稿保持上一版不动，可稍后用 failedPoint 重试。
   */
  private commitWithRecovery(label: string, kind: RecoveryKind, update: (current: DeskModel) => DeskModel): boolean {
    const previous = cloneModel(this.model);
    const next = update(cloneModel(this.model));
    next.updatedAt = Date.now();
    const point = createRecoveryPoint(label, kind, next);
    try {
      this.appendRecoveryPoint(point);
    } catch (error) {
      const failed: RecoveryPoint = { ...point, status: 'failed', error: error instanceof Error ? error.message : String(error) };
      this.failedPoint = failed;
      try {
        this.appendRecoveryPoint(failed);
      } catch {
        // 日志整体不可写时至少保留内存里的失败记录供重试
      }
      this.pushToast('error', '恢复点写入失败', '当前稿未改动，可清理存储后从上一版重试');
      return false;
    }
    this.failedPoint = null;
    this.past = [...this.past, previous].slice(-HISTORY_LIMIT);
    this.future = [];
    this.model = next;
    this.persist();
    return true;
  }

  /** 恢复点写失败后，用失败时保存的快照从上一版重试 */
  private retryRecoveryPoint(point?: RecoveryPoint): void {
    const target = point ?? this.failedPoint ?? this.recoveryPoints.find((item) => item.status === 'failed');
    if (!target) return;
    const completed: RecoveryPoint = { ...target, status: 'complete', error: undefined };
    try {
      this.appendRecoveryPoint(completed);
    } catch {
      this.pushToast('error', '恢复点仍写不进去', '请清理浏览器存储空间后再重试');
      return;
    }
    this.failedPoint = null;
    this.past = [...this.past, cloneModel(this.model)].slice(-HISTORY_LIMIT);
    this.future = [];
    this.model = { ...this.model, ...structuredClone(completed.snapshot), updatedAt: Date.now() };
    this.persist();
    this.recoveryPoints = this.readRecoveryLog();
    this.pushToast('success', '恢复点已补写', `「${target.label}」已从上一版重新应用`);
  }

  private openRecoveryCenter(): void {
    this.recoveryPoints = this.readRecoveryLog();
    this.recoveryOpen = true;
  }

  /** 值班员挑一版恢复点接着往下用 */
  private restoreRecoveryPoint(point: RecoveryPoint): void {
    this.past = [...this.past, cloneModel(this.model)].slice(-HISTORY_LIMIT);
    this.future = [];
    this.model = { ...this.model, ...structuredClone(point.snapshot), updatedAt: Date.now() };
    this.persist();
    try {
      this.appendRecoveryPoint(createRecoveryPoint(`还原到「${point.label}」`, 'restore', this.model));
    } catch {
      // 还原本身已成功，记录失败不影响使用
    }
    this.recoveryOpen = false;
    this.pushToast('success', '已接着所选恢复点继续', `${point.label} · ${new Date(point.createdAt).toLocaleTimeString('zh-CN')}`);
  }

  private commit(label: string, update: (current: DeskModel) => DeskModel): void {
    const previous = cloneModel(this.model);
    const next = update(cloneModel(this.model));
    next.updatedAt = Date.now();
    this.past = [...this.past, previous].slice(-HISTORY_LIMIT);
    this.future = [];
    this.model = next;
    this.persist();
    if (label) this.pushToast('info', label, '已写入浏览器本地草稿');
  }

  private automatic(next: DeskModel): void {
    this.model = next;
    this.persist();
  }

  private undo(): void {
    const previous = this.past.pop();
    if (!previous) return this.pushToast('info', '没有可撤销的修改', '历史记录为空');
    this.future = [cloneModel(this.model), ...this.future].slice(0, HISTORY_LIMIT);
    this.model = previous;
    this.persist();
  }

  private redo(): void {
    const next = this.future.shift();
    if (!next) return;
    this.past = [...this.past, cloneModel(this.model)].slice(-HISTORY_LIMIT);
    this.model = next;
    this.persist();
  }

  private pushToast(kind: ToastMessage['kind'], title: string, subtitle: string): void {
    const toast = { id: `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, kind, title, subtitle };
    this.toasts = [toast, ...this.toasts].slice(0, 3);
    window.setTimeout(() => {
      this.toasts = this.toasts.filter((item) => item.id !== toast.id);
    }, 4_500);
  }

  private get selected(): CaptionSegment | undefined {
    return this.model.segments.find((item) => item.id === this.model.selectedId);
  }

  private get stats() {
    return queueStats(this.model);
  }

  private get pendingSegments(): CaptionSegment[] {
    const items = this.model.segments.filter((item) => {
      if (this.filter === 'active') return item.state === 'pending' || item.state === 'stale' || item.state === 'duplicate';
      if (this.filter === 'attention') return item.state === 'stale' || item.state === 'duplicate';
      return true;
    });
    return [...items].sort((a, b) => a.sequence - b.sequence);
  }

  private updateSelected(patch: Partial<CaptionSegment>, label = ''): void {
    const selected = this.selected;
    if (!selected) return;
    if (selected.locked) {
      this.pushToast('warning', '片段已上屏锁定', '播控已播清单中的内容不能再改');
      return;
    }
    this.commit(label, (current) => ({
      ...current,
      segments: current.segments.map((item) => item.id === selected.id ? { ...item, ...patch, revision: item.revision + 1 } : item),
    }));
  }

  private selectSegment(id: string): void {
    this.model = { ...this.model, selectedId: id };
    this.persist();
  }

  private navigate(direction: number): void {
    const candidates = this.pendingSegments.length ? this.pendingSegments : [...this.model.segments].sort((a, b) => a.sequence - b.sequence);
    const index = candidates.findIndex((item) => item.id === this.model.selectedId);
    const next = candidates[Math.max(0, Math.min(candidates.length - 1, index + direction))];
    if (next) this.selectSegment(next.id);
  }

  private applyTerm(ruleId: string): void {
    const selected = this.selected;
    const rule = this.model.rules.find((item) => item.id === ruleId);
    if (!selected || !rule) return;
    if (selected.locked) {
      this.pushToast('warning', '片段已上屏锁定', '播控已播清单中的内容不能再改');
      return;
    }
    const flags = rule.caseSensitive ? 'g' : 'gi';
    const expression = new RegExp(rule.source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    if (!expression.test(selected.corrected)) {
      this.pushToast('warning', '当前字幕没有该术语', `${rule.source} → ${rule.replacement}`);
      return;
    }
    this.commit('应用术语替换', (current) => ({
      ...current,
      rules: current.rules.map((item) => item.id === rule.id ? { ...item, usageCount: item.usageCount + 1 } : item),
      segments: current.segments.map((item) => item.id === selected.id ? { ...item, corrected: item.corrected.replace(expression, rule.replacement), revision: item.revision + 1 } : item),
    }));
  }

  private applyInlineEdit(transform: (value: string) => string, label: string, cursorShift = 0): void {
    const selected = this.selected;
    if (!selected) return;
    const host = this.renderRoot.querySelector('cds-textarea');
    const textarea = host?.shadowRoot?.querySelector('textarea') as HTMLTextAreaElement | undefined;
    let value = selected.corrected;
    let cursor = value.length;

    if (textarea) {
      value = `${value.slice(0, textarea.selectionStart)}${transform('')}${value.slice(textarea.selectionEnd)}`;
      cursor = textarea.selectionStart + transform('').length + cursorShift;
    } else {
      value = transform(value);
    }

    this.updateSelected({ corrected: value }, label);
    this.updateComplete.then(() => {
      const nextTextarea = this.renderRoot.querySelector('cds-textarea')?.shadowRoot?.querySelector('textarea') as HTMLTextAreaElement | undefined;
      if (nextTextarea && textarea) {
        nextTextarea.focus();
        nextTextarea.setSelectionRange(cursor, cursor);
      }
    });
  }

  private insertPunctuation(mark: string): void {
    this.applyInlineEdit(() => mark, `插入${mark}`);
  }

  private wrapSelection(open: string, close: string): void {
    const host = this.renderRoot.querySelector('cds-textarea');
    const textarea = host?.shadowRoot?.querySelector('textarea') as HTMLTextAreaElement | undefined;
    const selected = this.selected;
    if (!textarea || !selected) return;
    const selectedText = selected.corrected.slice(textarea.selectionStart, textarea.selectionEnd) || '重点';
    const value = `${selected.corrected.slice(0, textarea.selectionStart)}${open}${selectedText}${close}${selected.corrected.slice(textarea.selectionEnd)}`;
    this.updateSelected({ corrected: value }, '添加强调标点');
  }

  private normalizeCurrentNumbers(): void {
    const selected = this.selected;
    if (!selected) return;
    const normalized = normalizeNumbers(selected.corrected);
    if (normalized === selected.corrected) {
      this.pushToast('info', '没有需要规范化的数字', '已检查全角数字和中文数字');
      return;
    }
    this.updateSelected({ corrected: normalized, numberHints: normalized }, '规范化数字');
  }

  private confirmSelected(): void {
    const selected = this.selected;
    if (!selected) {
      this.pushToast('warning', '没有可确认的片段', '请先从待确认区选择字幕');
      return;
    }
    if (selected.locked) {
      this.pushToast('warning', '片段已上屏锁定', '已播清单中的内容无需再次确认');
      return;
    }
    const { text, used } = applyRules(selected.corrected, this.model);
    const offline = this.model.connection === 'offline';
    // 对账之后新确认的片段排在已播清单后面重新送
    const needsResend = Boolean(this.model.reconciliation);
    const nextOrder = this.pendingSegments.filter((item) => item.id !== selected.id);
    const confirmed = this.commitWithRecovery(`确认第 ${selected.sequence} 段`, 'confirm', (current) => ({
      ...current,
      segments: current.segments.map((item) => item.id === selected.id ? {
        ...item,
        corrected: text,
        state: 'confirmed' as const,
        source: offline ? 'offline' as const : item.source,
        confirmedAt: Date.now(),
        resend: needsResend ? true : item.resend,
        staleReason: item.state === 'stale' ? item.staleReason : undefined,
        tags: used.length ? [...new Set([...item.tags, '术语已应用'])] : item.tags,
        revision: item.revision + 1,
      } : item),
      rules: current.rules.map((rule) => used.includes(rule.id) ? { ...rule, usageCount: rule.usageCount + 1 } : rule),
      selectedId: nextOrder[0]?.id ?? selected.id,
    }));
    if (!confirmed) return;
    this.pushToast(offline ? 'warning' : 'success', offline ? '已加入离线发件箱' : '字幕已进入直播区', offline ? '恢复点已写入，恢复连接后将按时间顺序合并' : `第 ${selected.sequence} 段已确认，恢复点已写入`);
  }

  private ignoreSelected(): void {
    const selected = this.selected;
    if (!selected) return;
    if (selected.locked) {
      this.pushToast('warning', '片段已上屏锁定', '已播清单中的内容不能忽略');
      return;
    }
    const next = this.pendingSegments.find((item) => item.id !== selected.id);
    this.commit('忽略问题片段', (current) => ({
      ...current,
      segments: current.segments.map((item) => item.id === selected.id ? { ...item, state: 'ignored', staleReason: '已人工忽略' } : item),
      selectedId: next?.id ?? selected.id,
    }));
  }

  private recoverDuplicate(): void {
    const selected = this.selected;
    if (!selected) return;
    this.commit('保留重复片段', (current) => ({
      ...current,
      segments: current.segments.map((item) => item.id === selected.id ? { ...item, state: 'pending', duplicateOf: undefined, staleReason: '重复提示已由校对员确认保留' } : item),
    }));
  }

  private setConnection(connection: ConnectionState): void {
    this.commit(connection === 'offline' ? '切换到离线校正' : connection === 'degraded' ? '模拟延迟波动' : '连接已恢复', (current) => ({
      ...current,
      connection,
      simulatedDelay: connection === 'connected' ? 0.8 : connection === 'degraded' ? 4.6 : current.simulatedDelay,
    }));
  }

  private mergeOffline(): void {
    const merged = this.commitWithRecovery('恢复连接并合并离线队列', 'merge', (current) => mergeConfirmedSegments(current));
    if (!merged) return;
    const outboxCount = this.model.segments.filter((item) => item.source === 'offline' && item.state === 'confirmed').length;
    this.pushToast('success', '离线队列已合并', `${outboxCount} 个片段仍标记为离线来源，过期修改会继续显示提示`);
  }

  /** 播控带回的已播清单与本地稿在同一处对账 */
  private importAiredList(): void {
    const entries = parseAiredList(this.airedDraft);
    if (!entries.length) {
      this.pushToast('warning', '已播清单为空', '请粘贴播控带回的清单，每行一条（可带序号）');
      return;
    }
    const done = this.commitWithRecovery(`对账播控已播清单（${entries.length} 条）`, 'reconcile', (current) => reconcileAiredList(current, entries));
    if (!done) return;
    const report = this.model.reconciliation;
    this.airedDraft = '';
    this.pushToast(
      report?.unmatched.length ? 'warning' : 'success',
      '已播清单对账完成',
      `已上屏锁定 ${report?.matched.length ?? 0} 段 · 待重新送 ${report?.resend.length ?? 0} 段 · 对不上 ${report?.unmatched.length ?? 0} 条`,
    );
  }

  private addRuleFromSelection(): void {
    const selected = this.selected;
    if (!selected) return;
    this.ruleSource = selected.corrected.length > 24 ? selected.corrected.slice(0, 24) : selected.corrected;
    this.ruleReplacement = selected.corrected;
    this.ruleSpeaker = selected.speaker;
    this.showRuleForm = true;
  }

  private addRule(): void {
    const source = this.ruleSource.trim();
    const replacement = this.ruleReplacement.trim();
    if (!source || !replacement) {
      this.pushToast('warning', '规则不完整', '原文和替换文本均不能为空');
      return;
    }
    this.commit('新增术语快捷规则', (current) => ({
      ...current,
      rules: [{
        id: `term-${Date.now().toString(36)}`,
        source,
        replacement,
        speaker: this.ruleSpeaker,
        enabled: true,
        caseSensitive: false,
        usageCount: 0,
        createdAt: Date.now(),
      }, ...current.rules],
    }));
    this.ruleSource = '';
    this.ruleReplacement = '';
    this.ruleSpeaker = '';
    this.showRuleForm = false;
  }

  private deleteRule(id: string): void {
    this.commit('删除术语规则', (current) => ({ ...current, rules: current.rules.filter((item) => item.id !== id) }));
  }

  private exportSrt(): void {
    const content = toSrt(this.model);
    if (!content) {
      this.pushToast('warning', '暂无已确认字幕', '先确认至少一个片段再导出');
      return;
    }
    const blob = new Blob([content], { type: 'application/x-subrip;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${this.model.eventName.replace(/[^\p{L}\p{N}-]+/gu, '-')}.srt`;
    anchor.click();
    URL.revokeObjectURL(url);
    this.pushToast('success', 'SRT 已导出', `${toSrt(this.model).split('\n\n').length} 段字幕`);
  }

  private adjustFont(delta: number): void {
    const fontSize = Math.max(14, Math.min(28, this.model.fontSize + delta));
    this.automatic({ ...this.model, fontSize });
  }

  private toggleTheme(): void {
    this.dark = !this.dark;
    localStorage.setItem(`${STORAGE_KEY}-theme`, this.dark ? 'dark' : 'light');
  }

  private handleShortcut = (event: KeyboardEvent): void => {
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLocaleLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? this.redo() : this.undo();
      return;
    }
    if (modifier && event.key.toLocaleLowerCase() === 'y') {
      event.preventDefault();
      this.redo();
      return;
    }
    if (modifier && event.key === 'Enter') {
      event.preventDefault();
      this.confirmSelected();
      return;
    }
    if (event.altKey && event.key.toLocaleLowerCase() === 'j') {
      event.preventDefault();
      this.navigate(1);
      return;
    }
    if (event.altKey && event.key.toLocaleLowerCase() === 'k') {
      event.preventDefault();
      this.navigate(-1);
      return;
    }
    const punctuation: Record<string, string> = { '1': '，', '2': '。', '3': '？', '4': '！' };
    if (modifier && punctuation[event.key]) {
      event.preventDefault();
      this.insertPunctuation(punctuation[event.key]);
    }
  };

  private renderPendingList() {
    const segments = this.pendingSegments;
    if (!segments.length) {
      return html`<div class="empty"><strong>待确认区已清空</strong><p>新的实时片段到达时会自动进入这里。</p></div>`;
    }
    return html`
      <div class="segment-list">
        ${segments.map((item) => html`
          <button class="segment-card ${item.id === this.model.selectedId ? 'selected' : ''} ${item.state}" @click=${() => this.selectSegment(item.id)}>
            <div class="segment-meta">
              <span>${formatClock(item.startTime)} · #${String(item.sequence).padStart(3, '0')}</span>
              <span class="segment-state ${item.state}">${item.locked ? '已上屏锁定' : stateLabel(item.state)}</span>
            </div>
            <p class="segment-text">${item.original}</p>
            ${item.corrected !== item.original ? html`<p class="segment-corrected">${item.corrected}</p>` : nothing}
            <div class="segment-foot">
              <span>${item.speaker}</span>
              <span>·</span>
              <span>${formatAge(item.receivedAt)}</span>
              ${item.revision > 0 ? html`<span>· <b>修改 ${item.revision} 次</b></span>` : nothing}
              ${item.resend && !item.aired ? html`<span>· <b>待重新送</b></span>` : nothing}
            </div>
            ${item.state === 'stale' && item.staleReason ? html`<div class="issue-note">${item.staleReason}。确认前请核对直播上下文。</div>` : nothing}
            ${item.state === 'duplicate' ? html`<div class="issue-note duplicate-note">${item.staleReason || '检测到重复片段'}，请保留或忽略。</div>` : nothing}
            ${item.migrationNote ? html`<div class="issue-note migrate-note">旧稿升级：${item.migrationNote}</div>` : nothing}
          </button>
        `)}
      </div>
    `;
  }

  private renderEditor() {
    const item = this.selected;
    if (!item) {
      return html`<div class="empty"><strong>选择一条待确认字幕</strong><p>可以使用 Alt+J / Alt+K 在片段之间移动。</p></div>`;
    }
    const applicableRules = this.model.rules.filter((rule) => rule.enabled && (!rule.speaker || rule.speaker === item.speaker));
    return html`
      <div class="editor-scroll">
        <div class="editor-card">
          <div class="editor-top">
            <div>
              <div class="editor-time">${formatClock(item.startTime)} — ${formatClock(item.startTime + 7)}</div>
              <p class="editor-title">实时片段 #${String(item.sequence).padStart(3, '0')} · 到达于 ${formatAge(item.receivedAt)}</p>
            </div>
            <div class="editor-status">
              <cds-tag type=${item.state === 'stale' ? 'warm-gray' : item.state === 'duplicate' ? 'purple' : 'blue'} size="sm">${stateLabel(item.state)}</cds-tag>
              <cds-tag type="outline" size="sm">修改 ${item.revision} 次</cds-tag>
            </div>
          </div>
          <div class="editor-form">
            ${item.locked ? html`
              <cds-inline-notification kind="info" low-contrast title="已上屏锁定" subtitle="该片段已在播控已播清单中，内容锁定不再修改；如需调整请走播控流程。"></cds-inline-notification>
            ` : nothing}
            ${item.migrationNote ? html`
              <cds-inline-notification kind="warning" low-contrast title="旧稿片段未完全接入恢复点" subtitle=${item.migrationNote}></cds-inline-notification>
            ` : nothing}
            ${item.state === 'duplicate' ? html`
              <cds-inline-notification kind="warning" low-contrast title="重复片段提示" subtitle=${item.staleReason || '与已确认片段高度相似'}>
                <cds-button slot="action" size="sm" @click=${this.recoverDuplicate}>保留并继续校对</cds-button>
              </cds-inline-notification>
            ` : nothing}
            ${item.state === 'stale' ? html`
              <cds-inline-notification kind="warning" low-contrast title="过期修改" subtitle=${`${item.staleReason || '该片段已超过 90 秒未确认'}。请结合上下文确认，或忽略以避免污染直播区。`}></cds-inline-notification>
            ` : nothing}
            <div class="form-grid">
              <cds-select label-text="发言人" ?disabled=${item.locked} value=${item.speaker} @cds-select-selected=${(event: CustomEvent<{ value: string }>) => this.updateSelected({ speaker: event.detail.value }, '修改发言人')}>
                ${['主持人', '主讲人', '嘉宾 / 周然', '现场提问', '未知发言人'].map((speaker) => html`<cds-select-item value=${speaker}>${speaker}</cds-select-item>`)}
              </cds-select>
              <cds-number-input class="number-input" label="延迟（秒）" .value=${this.model.simulatedDelay} step="0.1" min="0" max="9" @input=${(event: Event) => this.automatic({ ...this.model, simulatedDelay: Number((event.currentTarget as any).value) })}></cds-number-input>
            </div>
            <cds-textarea
              class="caption-input"
              label-text="校对后的字幕文本"
              helper-text="Ctrl/⌘ + 1–4 快速插入标点；术语规则将从左到右自动应用"
              ?disabled=${item.locked}
              .value=${item.corrected}
              @input=${(event: Event) => this.updateSelected({ corrected: (event.currentTarget as any).value }, '')}
            ></cds-textarea>
            <div class="edit-toolbar">
              <span>快速标点</span>
              <cds-button kind="ghost" size="sm" @click=${() => this.insertPunctuation('，')}>，逗号</cds-button>
              <cds-button kind="ghost" size="sm" @click=${() => this.insertPunctuation('。')}>。句号</cds-button>
              <cds-button kind="ghost" size="sm" @click=${() => this.insertPunctuation('？')}>？问号</cds-button>
              <cds-button kind="ghost" size="sm" @click=${() => this.insertPunctuation('…')}>…省略</cds-button>
              <cds-button kind="ghost" size="sm" @click=${() => this.wrapSelection('（', '）')}>（）括注</cds-button>
              <cds-button kind="secondary" size="sm" @click=${this.normalizeCurrentNumbers}>规范化数字</cds-button>
            </div>
            <div class="rule-suggestions">
              <small>术语快捷替换</small>
              ${applicableRules.length ? applicableRules.map((rule) => html`
                <cds-button kind="tertiary" size="sm" @click=${() => this.applyTerm(rule.id)}>${rule.source} → ${rule.replacement}</cds-button>
              `) : html`<small>当前发言人的规则为空</small>`}
              <cds-button kind="ghost" size="sm" @click=${this.addRuleFromSelection}>＋ 从当前文本新建</cds-button>
            </div>
          </div>
          <div class="confirm-bar">
            <div class="confirm-hint"><kbd>⌘/Ctrl Enter</kbd> 确认并进入直播区 · <kbd>Alt J/K</kbd> 切换片段 · 确认前先写恢复点</div>
            <div>
              <cds-button kind="danger--tertiary" size="sm" ?disabled=${item.locked} @click=${this.ignoreSelected}>忽略片段</cds-button>
              <cds-button kind="primary" ?disabled=${item.locked} @click=${this.confirmSelected}>确认并送入直播区</cds-button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  private renderLiveItem(segment: CaptionSegment) {
    return html`
      <article class="live-item ${segment.locked ? 'locked' : ''} ${segment.resend && !segment.aired ? 'resend' : ''}">
        <time>${formatClock(segment.startTime)} · ${segment.speaker}</time>
        <p>${segment.corrected}</p>
        ${segment.locked ? html`<small>已上屏 · 锁定不再改</small>` : nothing}
        ${segment.resend && !segment.aired ? html`<small>本地新确认 · 排在已播清单后面重新送</small>` : nothing}
        ${segment.source === 'offline' ? html`<small>离线来源 · 恢复后合并</small>` : nothing}
      </article>
    `;
  }

  private renderInspector() {
    const item = this.selected;
    const confirmed = this.model.segments.filter((segment) => segment.state === 'confirmed').sort((a, b) => a.startTime - b.startTime);
    const report = this.model.reconciliation;
    const resendIds = new Set(report?.resend ?? []);
    const isResend = (segment: CaptionSegment) => !segment.aired && !segment.locked && (resendIds.has(segment.id) || segment.resend === true);
    const aired = confirmed.filter((segment) => segment.aired || segment.locked);
    const resend = confirmed.filter(isResend);
    const regular = confirmed.filter((segment) => !aired.includes(segment) && !resend.includes(segment));
    return html`
      <div class="inspector">
        <section class="inspector-section">
          <div class="inspector-section-head">
            <h3>术语快捷规则</h3>
            <span>${this.model.rules.filter((rule) => rule.enabled).length} 条启用</span>
          </div>
          <div class="rule-list">
            ${this.model.rules.map((rule) => html`
              <div class="rule-item">
                <div>
                  <strong>${rule.source} → ${rule.replacement}</strong>
                  <p>${rule.speaker || '全部发言人'} · 已使用 ${rule.usageCount} 次</p>
                </div>
                <div class="rule-item-actions">
                  <cds-button kind="ghost" size="sm" @click=${() => this.applyTerm(rule.id)}>应用</cds-button>
                  <cds-button kind="danger--ghost" size="xs" @click=${() => this.deleteRule(rule.id)}>删除</cds-button>
                </div>
              </div>
            `)}
          </div>
          ${this.showRuleForm ? html`
            <div class="rule-form">
              <cds-text-input label-text="原文" .value=${this.ruleSource} @input=${(event: Event) => { this.ruleSource = (event.currentTarget as any).value; }}></cds-text-input>
              <cds-text-input label-text="替换为" .value=${this.ruleReplacement} @input=${(event: Event) => { this.ruleReplacement = (event.currentTarget as any).value; }}></cds-text-input>
              <cds-text-input class="full" label-text="仅对某发言人应用（可空）" .value=${this.ruleSpeaker} @input=${(event: Event) => { this.ruleSpeaker = (event.currentTarget as any).value; }}></cds-text-input>
              <cds-button class="full" size="sm" kind="primary" @click=${this.addRule}>保存规则</cds-button>
            </div>
          ` : html`
            <div style="padding: 10px;"><cds-button kind="tertiary" size="sm" @click=${() => { this.showRuleForm = true; }}>＋ 新增术语规则</cds-button></div>
          `}
        </section>

        <section class="inspector-section">
          <div class="inspector-section-head">
            <h3>直播区时间线</h3>
            <span>${confirmed.length} 段已确认${report ? ` · 已上屏 ${aired.length}` : ''}</span>
          </div>
          <div class="live-timeline">
            ${!confirmed.length ? html`<div class="empty"><strong>直播区等待内容</strong><p>确认一块字幕后，它会从这里进入实时输出。</p></div>` : nothing}
            ${regular.slice(-12).reverse().map((segment) => this.renderLiveItem(segment))}
            ${aired.length ? html`
              <div class="timeline-divider">已播清单 · 与播控对上的 ${aired.length} 段已锁定</div>
              ${aired.map((segment) => this.renderLiveItem(segment))}
            ` : nothing}
            ${resend.length ? html`
              <div class="timeline-divider resend-divider">已播清单结束 · 以下 ${resend.length} 段排在清单后面重新送</div>
              ${resend.map((segment) => this.renderLiveItem(segment))}
            ` : nothing}
          </div>
          ${this.stats.offline > 0 ? html`<div class="delivery-status">离线发件箱有 ${this.stats.offline} 段待合并。恢复连接后按时间顺序提交，不会覆盖已确认内容。</div>` : nothing}
        </section>

        <section class="inspector-section">
          <div class="inspector-section-head">
            <h3>播控已播清单对账</h3>
            <span>${report ? `对账于 ${new Date(report.importedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '未对账'}</span>
          </div>
          <div class="reconcile-box">
            <cds-textarea
              label-text="粘贴播控带回的已播清单"
              helper-text="每行一条，可带序号，例如 “4 我们使用 Studio Cloud 作为演示环境。”"
              rows="3"
              .value=${this.airedDraft}
              @input=${(event: Event) => { this.airedDraft = (event.currentTarget as any).value; }}
            ></cds-textarea>
            <cds-button size="sm" kind="primary" @click=${this.importAiredList}>导入清单并对账</cds-button>
            ${report ? html`
              <div class="reconcile-summary">
                <span>已上屏锁定 <b>${report.matched.length}</b></span>
                <span>待重新送 <b>${report.resend.length}</b></span>
                <span>对不上 <b>${report.unmatched.length}</b></span>
              </div>
              ${report.unmatched.length ? html`
                <div class="unmatched-list">
                  <p>以下播控记录与本地稿对不上，先列出来等人处理：</p>
                  ${report.unmatched.map((entry) => html`
                    <div class="unmatched-item">
                      <span>#${entry.sequence}</span>
                      <p>${entry.text}</p>
                    </div>
                  `)}
                </div>
              ` : html`<div class="reconcile-ok">清单与本地稿全部对上，没有待人工处理的记录。</div>`}
            ` : nothing}
          </div>
        </section>

        <section class="inspector-section">
          <div class="inspector-section-head">
            <h3>当前片段上下文</h3>
            <span>${item ? `#${item.sequence}` : '未选择'}</span>
          </div>
          <div style="padding: 12px; line-height: 1.5; font-size: 11px;">
            ${item ? html`
              <div><strong>原始字幕：</strong>${item.original}</div>
              <div style="margin-top: 8px;"><strong>修改前校正：</strong>${item.corrected}</div>
              <div style="margin-top: 8px; color: var(--cds-text-secondary);">${item.tags.length ? `标签：${item.tags.join('、')}` : '尚未应用术语标签'}</div>
            ` : html`<span>请选择片段以查看上下文。</span>`}
          </div>
        </section>
      </div>
    `;
  }

  private renderRecoveryCenter() {
    if (!this.recoveryOpen) return nothing;
    const points = [...this.recoveryPoints].sort((a, b) => b.createdAt - a.createdAt);
    return html`
      <div class="recovery-overlay" @click=${(event: Event) => { if (event.target === event.currentTarget) this.recoveryOpen = false; }}>
        <div class="recovery-dialog" role="dialog" aria-modal="true" aria-label="恢复中心">
          <div class="recovery-head">
            <div>
              <h2>恢复中心</h2>
              <p>重开后能找回的确认记录、术语规则和待确认队列都在下面，挑一版接着往下用。</p>
            </div>
            <cds-button kind="ghost" size="sm" @click=${() => { this.recoveryOpen = false; }}>关闭</cds-button>
          </div>
          <div class="recovery-list">
            ${!points.length ? html`<div class="empty"><strong>还没有恢复点</strong><p>每次确认、合并或对账前都会先写一份恢复点。</p></div>` : nothing}
            ${points.map((point) => html`
              <div class="recovery-item ${point.status}">
                <div class="recovery-item-copy">
                  <strong>${point.label}</strong>
                  <p>
                    ${new Date(point.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    · ${recoveryKindLabel(point.kind)}
                    · 确认记录 ${point.counts.confirmed} · 术语规则 ${point.counts.rules} · 待确认 ${point.counts.pending}
                  </p>
                  ${point.status === 'failed' ? html`<p class="recovery-error">写入失败：${point.error || '存储不可用'}，可从上一版重试。</p>` : nothing}
                </div>
                <div class="recovery-item-actions">
                  ${point.status === 'failed'
                    ? html`<cds-button kind="secondary" size="sm" @click=${() => this.retryRecoveryPoint(point)}>重试写入</cds-button>`
                    : html`<cds-button kind="primary" size="sm" @click=${() => this.restoreRecoveryPoint(point)}>接着用这一版</cds-button>`}
                </div>
              </div>
            `)}
          </div>
          <div class="recovery-foot">
            <span>当前稿更新于 ${new Date(this.model.updatedAt).toLocaleTimeString('zh-CN')}</span>
            <cds-button kind="tertiary" size="sm" @click=${() => { this.recoveryOpen = false; }}>继续用当前稿</cds-button>
          </div>
        </div>
      </div>
    `;
  }

  render() {
    const stats = this.stats;
    const backlogRatio = Math.min(100, stats.backlog * 8);
    return html`
      <div class="shell ${this.dark ? 'dark' : ''}" style=${`--caption-font-size: ${this.model.fontSize}px`}>
        <header class="topbar">
          <div class="brand">
            <div class="brand-mark">CC</div>
            <div class="brand-copy">
              <strong>LiveCaption Desk</strong>
              <span>${this.model.eventName} · ${this.model.eventDate}</span>
            </div>
          </div>
          <div class="connection-pill ${this.model.connection}">
            <span class="connection-dot"></span>
            <div class="connection-copy">
              <strong>${connectionLabel(this.model.connection)} · ${this.model.simulatedDelay.toFixed(1)} 秒延迟</strong>
              <small>${this.model.connection === 'offline' ? '仍可编辑，确认内容进入离线发件箱' : `待确认队列 ${stats.pending} 段 · 最近自动保存 ${new Date(this.model.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`}</small>
            </div>
          </div>
          <div class="header-actions">
            <cds-button kind="ghost" size="sm" @click=${this.openRecoveryCenter}>恢复中心</cds-button>
            <cds-button kind="ghost" size="sm" @click=${this.toggleTheme}>${this.dark ? '浅色界面' : '深色值守'}</cds-button>
            <cds-button kind="ghost" size="sm" @click=${this.undo}>撤销</cds-button>
            <cds-button kind="ghost" size="sm" @click=${this.redo}>重做</cds-button>
            <cds-button kind="primary" size="sm" @click=${this.exportSrt}>导出 SRT</cds-button>
          </div>
        </header>

        ${this.failedPoint ? html`
          <div class="recovery-banner" role="alert">
            <strong>恢复点写入失败</strong>
            <span>「${this.failedPoint.label}」没有落盘，当前稿保持上一版未动。</span>
            <cds-button kind="danger" size="sm" @click=${() => this.retryRecoveryPoint()}>从上一版重试</cds-button>
          </div>
        ` : nothing}

        <section class="status-strip">
          <div class="status-cell hero">
            <strong>${this.model.connection === 'offline' ? '离线校正中，确认后暂存发件箱' : stats.backlog > 8 ? '队列积压，建议优先处理过期片段' : '队列节奏正常，可以继续逐段确认'}</strong>
            <span>待确认 ${stats.pending} · 过期 ${stats.stale} · 重复 ${stats.duplicate} · 离线待合并 ${stats.offline}${stats.locked ? ` · 已上屏 ${stats.locked}` : ''}${stats.resend ? ` · 待重送 ${stats.resend}` : ''}</span>
            <div class="queue-track"><span style=${`width:${backlogRatio}%`}></span></div>
          </div>
          <div class="status-cell"><strong>${stats.pending}</strong><span>待确认片段</span></div>
          <div class="status-cell warning"><strong>${stats.oldestWaitSeconds}s</strong><span>最长等待时间</span></div>
          <div class="status-cell danger"><strong>${stats.stale + stats.duplicate}</strong><span>需要明确处理</span></div>
          <div class="status-cell"><strong>${this.model.simulatedDelay.toFixed(1)}s</strong><span>当前流延迟</span></div>
          <div class="font-controls">
            <label>字幕字号</label>
            <cds-button kind="ghost" size="sm" @click=${() => this.adjustFont(-1)}>A−</cds-button>
            <strong>${this.model.fontSize}</strong>
            <cds-button kind="ghost" size="sm" @click=${() => this.adjustFont(1)}>A＋</cds-button>
          </div>
        </section>

        <main class="workspace">
          <section class="column">
            <div class="column-head">
              <div>
                <h2>待确认区</h2>
                <p>按收到顺序排列，重复和过期内容不会被静默覆盖</p>
              </div>
              <cds-dropdown value=${this.filter} @cds-dropdown-selected=${(event: CustomEvent<{ item: { value: string } }>) => { this.filter = event.detail.item.value as typeof this.filter; }}>
                <cds-dropdown-item value="active">仅需处理</cds-dropdown-item>
                <cds-dropdown-item value="attention">异常优先</cds-dropdown-item>
                <cds-dropdown-item value="all">全部片段</cds-dropdown-item>
              </cds-dropdown>
            </div>
            <div class="column-body">${this.renderPendingList()}</div>
          </section>

          <section class="column">
            <div class="column-head">
              <div>
                <h2>校对编辑台</h2>
                <p>标点、专有名词、发言人和数字均可在确认前修改</p>
              </div>
              <cds-tag type="green" size="sm">本地草稿</cds-tag>
            </div>
            <div class="column-body" style=${`font-size:${this.model.fontSize}px`}>${this.renderEditor()}</div>
          </section>

          <section class="column">
            <div class="column-head">
              <div>
                <h2>规则与直播区</h2>
                <p>确认后进入直播输出；离线内容恢复后统一合并</p>
              </div>
              ${this.model.connection === 'offline'
                ? html`<cds-button kind="primary" size="sm" @click=${this.mergeOffline}>恢复并合并</cds-button>`
                : html`<cds-button kind="danger--tertiary" size="sm" @click=${() => this.setConnection('offline')}>模拟断线</cds-button>`}
            </div>
            <div class="column-body">${this.renderInspector()}</div>
          </section>
        </main>

        ${this.renderRecoveryCenter()}

        <div class="toast-stack">
          ${this.toasts.map((toast) => html`
            <cds-toast-notification
              kind=${toast.kind}
              title=${toast.title}
              subtitle=${toast.subtitle}
              @cds-notification-closed=${() => { this.toasts = this.toasts.filter((item) => item.id !== toast.id); }}
            ></cds-toast-notification>
          `)}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'caption-desk': CaptionDesk;
  }
}
