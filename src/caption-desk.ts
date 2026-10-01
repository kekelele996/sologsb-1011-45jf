import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import {
  applyRules,
  CHECKPOINT_FAULT_KEY,
  cloneModel,
  createInitialModel,
  generateSimulatedAiredList,
  loadCheckpoints,
  mergeConfirmedSegments,
  migrateDraft,
  normalizeNumbers,
  parseAiredList,
  queueStats,
  reconcileAiredList,
  rollbackFromCheckpoints,
  saveCheckpoint,
  SCHEMA_VERSION,
  STORAGE_KEY,
  simulateLatency,
  toSrt,
  writeCheckpointWithRetry,
  type CaptionSegment,
  type ConnectionState,
  type DeskModel,
  type ReconcileMismatch,
  type ReconcileReport,
  type RecoveryPoint,
  type RecoveryPointKind,
  type SegmentState,
  type ToastMessage,
} from './model';

const HISTORY_LIMIT = 80;

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
      display: grid;
      grid-template-rows: auto auto 1fr;
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
    .delivery-status.redelivery { background: #fff8e1; border-left-color: #f1c21b; color: #684e00; }
    .delivery-status.reconciled { background: #e6f4ea; border-left-color: #42be65; color: #198038; }
    .live-item.locked { border-left-color: #42be65; background: color-mix(in srgb, #42be65 8%, var(--cds-layer-02, #f4f4f4)); }
    .redelivery-tag { color: #8d6e00 !important; }

    .recovery-tabs { display: flex; gap: 6px; margin-bottom: 14px; border-bottom: 1px solid var(--cds-border-subtle, #e0e0e0); }
    .recovery-tabs button {
      border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--cds-text-secondary, #525252);
      font: 500 12px/1 "IBM Plex Sans", "PingFang SC", sans-serif; padding: 8px 12px; cursor: pointer; margin-bottom: -1px;
    }
    .recovery-tabs button.active { color: #0f62fe; border-bottom-color: #0f62fe; }
    .recovery-tab { display: flex; flex-direction: column; gap: 12px; }
    .recovery-help { margin: 0; padding: 10px 12px; background: var(--cds-layer-02, #f4f4f4); border-left: 3px solid #0f62fe; font-size: 11px; line-height: 1.6; color: var(--cds-text-secondary, #525252); }
    .recovery-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .checkpoint-list { display: flex; flex-direction: column; gap: 8px; }
    .checkpoint-card { border: 1px solid var(--cds-border-subtle, #e0e0e0); background: var(--cds-layer, #fff); padding: 10px 12px; }
    .checkpoint-card.current { border-color: #0f62fe; outline: 1px solid #78a9ff; }
    .checkpoint-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .checkpoint-head strong { font-size: 12px; }
    .checkpoint-head span { color: var(--cds-text-secondary, #525252); font-size: 10px; font-variant-numeric: tabular-nums; }
    .checkpoint-counts { display: flex; gap: 16px; margin-top: 8px; font-size: 11px; color: var(--cds-text-secondary, #525252); }
    .checkpoint-counts b { color: var(--cds-text-primary, #161616); font-weight: 600; font-variant-numeric: tabular-nums; }
    .checkpoint-reason { margin: 6px 0 0; font-size: 10px; color: #8d6e00; line-height: 1.5; }
    .checkpoint-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 8px; }
    .checkpoint-foot > span { color: var(--cds-text-secondary, #525252); font-size: 10px; }
    .reconcile-summary { display: flex; gap: 16px; flex-wrap: wrap; padding: 10px 12px; background: var(--cds-layer-02, #f4f4f4); font-size: 12px; }
    .reconcile-summary .ok { color: #198038; }
    .reconcile-summary .warn { color: #8d6e00; }
    .reconcile-summary .bad { color: #da1e28; font-weight: 600; }
    .redelivery-note { padding: 9px 12px; background: #fff8e1; border-left: 3px solid #f1c21b; color: #684e00; font-size: 11px; line-height: 1.6; }
    .mismatch-list { display: flex; flex-direction: column; gap: 8px; }
    .mismatch-card { border: 1px solid var(--cds-border-subtle, #e0e0e0); border-left: 3px solid #da1e28; background: var(--cds-layer, #fff); padding: 10px 12px; }
    .mismatch-head { display: flex; align-items: center; gap: 10px; }
    .mismatch-head strong { font-size: 12px; }
    .mismatch-reason { margin: 6px 0 0; font-size: 11px; color: var(--cds-text-secondary, #525252); line-height: 1.5; }
    .mismatch-compare { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; font-size: 11px; line-height: 1.5; }
    .mismatch-compare span { color: var(--cds-text-secondary, #525252); }
    .mismatch-actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
    .migration-list { margin: 0; padding: 10px 12px 10px 28px; background: var(--cds-layer, #fff); border: 1px solid var(--cds-border-subtle, #e0e0e0); font-size: 11px; line-height: 1.7; }
    .migration-list li { margin: 2px 0; }

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

  @state() private model: DeskModel = this.loadDesk().model;
  @state() private dark = localStorage.getItem(`${STORAGE_KEY}-theme`) === 'dark';
  @state() private toasts: ToastMessage[] = [];
  @state() private ruleSource = '';
  @state() private ruleReplacement = '';
  @state() private ruleSpeaker = '';
  @state() private filter: 'active' | 'all' | 'attention' = 'active';
  @state() private showRuleForm = false;
  @state() private showRecoveryCenter = false;
  @state() private recoveryTab: 'checkpoints' | 'reconcile' | 'migration' = 'checkpoints';
  @state() private checkpoints: RecoveryPoint[] = [];
  @state() private migrationNotes: string[] = this.loadDesk().notes;
  @state() private airedDraft = '';
  @state() private reconcileReport: ReconcileReport | null = null;
  @state() private faultArmed = localStorage.getItem(CHECKPOINT_FAULT_KEY) === '1';
  private past: DeskModel[] = [];
  private future: DeskModel[] = [];
  private ticker?: number;

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('keydown', this.handleShortcut);
    this.checkpoints = loadCheckpoints();

    if (this.migrationNotes.length) {
      // 旧稿升级：落库并写一份迁移恢复点，接不上的片段原因已记录。
      this.persist();
      const result = saveCheckpoint(this.model, 'migrate', '旧稿升级后首次保存', this.migrationNotes.join('；'));
      if (result.ok) {
        this.model = { ...this.model, lastCheckpointId: result.id };
        this.persist();
        this.checkpoints = loadCheckpoints();
      }
      this.recoveryTab = 'migration';
      this.showRecoveryCenter = true;
    } else {
      // 崩溃检测：恢复点比当前稿新，说明关机前写了恢复点但没来得及更新当前稿。
      const crashPoint = this.checkpoints.find((cp) => cp.savedAt > (this.model.updatedAt ?? 0) + 1000);
      if (crashPoint) {
        this.recoveryTab = 'checkpoints';
        this.showRecoveryCenter = true;
      }
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

  private loadDesk(): { model: DeskModel; notes: string[] } {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const result = migrateDraft(JSON.parse(raw));
        if (result.migrated || result.model.segments?.length) {
          return {
            model: result.model,
            notes: result.notes.length ? result.notes : (result.model.migrationNotes ?? []),
          };
        }
      }
    } catch {
      // 损坏草稿会回退到演示数据。
    }
    return { model: createInitialModel(), notes: [] };
  }

  private persist(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...this.model, updatedAt: Date.now() }));
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

  /**
   * 确认等关键操作：先写恢复点，再动当前稿。
   * 恢复点写失败时从上一版重试一次；仍失败则回滚当前稿，本次修改不落地。
   */
  private commitWithCheckpoint(label: string, kind: RecoveryPointKind, update: (current: DeskModel) => DeskModel): boolean {
    const previous = cloneModel(this.model);
    const checkpoint = writeCheckpointWithRetry(previous, kind, label);
    if (!checkpoint.ok) {
      const rolled = rollbackFromCheckpoints();
      if (rolled) {
        this.model = rolled;
        this.persist();
      }
      this.checkpoints = loadCheckpoints();
      this.pushToast('error', '恢复点写入失败', '当前稿未改动，已从上一版恢复点重试');
      return false;
    }
    const next = update(cloneModel(this.model));
    next.updatedAt = Date.now();
    next.lastCheckpointId = checkpoint.id;
    this.past = [...this.past, previous].slice(-HISTORY_LIMIT);
    this.future = [];
    this.model = next;
    this.persist();
    this.checkpoints = loadCheckpoints();
    return true;
  }

  private guardLocked(segment: CaptionSegment | undefined): boolean {
    if (segment?.locked) {
      this.pushToast('warning', '该片段已上屏锁定', '播控已确认播出，内容不能再修改；如需改动请先处理播控对账');
      return true;
    }
    return false;
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
    if (this.guardLocked(selected)) return;
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
    if (this.guardLocked(selected)) return;
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
    if (this.guardLocked(selected)) return;
    const { text, used } = applyRules(selected.corrected, this.model);
    const offline = this.model.connection === 'offline';
    const nextOrder = this.pendingSegments.filter((item) => item.id !== selected.id);
    const ok = this.commitWithCheckpoint('确认并送入直播区', 'confirm', (current) => ({
      ...current,
      segments: current.segments.map((item) => item.id === selected.id ? {
        ...item,
        corrected: text,
        state: 'confirmed',
        source: offline ? 'offline' : item.source,
        confirmedAt: Date.now(),
        staleReason: item.state === 'stale' ? item.staleReason : undefined,
        tags: used.length ? [...new Set([...item.tags, '术语已应用'])] : item.tags,
        revision: item.revision + 1,
      } : item),
      rules: current.rules.map((rule) => used.includes(rule.id) ? { ...rule, usageCount: rule.usageCount + 1 } : rule),
      selectedId: nextOrder[0]?.id ?? selected.id,
    }));
    if (!ok) return;
    this.pushToast(offline ? 'warning' : 'success', offline ? '已加入离线发件箱' : '字幕已进入直播区', offline ? '恢复连接后将按时间顺序合并' : `第 ${selected.sequence} 段已确认，恢复点已先于当前稿写入`);
  }

  private ignoreSelected(): void {
    const selected = this.selected;
    if (!selected) return;
    if (this.guardLocked(selected)) return;
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
    const merged = mergeConfirmedSegments(this.model);
    this.past = [...this.past, cloneModel(this.model)].slice(-HISTORY_LIMIT);
    this.future = [];
    this.model = merged;
    this.persist();
    const outboxCount = this.model.segments.filter((item) => item.source === 'offline' && item.state === 'confirmed').length;
    this.pushToast('success', '离线队列已合并', `${outboxCount} 个片段仍标记为离线来源，过期修改会继续显示提示`);
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

  // ── 恢复中心 ──────────────────────────────────────────────

  private openRecoveryCenter(tab: 'checkpoints' | 'reconcile' | 'migration'): void {
    this.recoveryTab = tab;
    this.showRecoveryCenter = true;
    this.checkpoints = loadCheckpoints();
  }

  private adoptCheckpoint(point: RecoveryPoint): void {
    this.model = cloneModel(point.model);
    this.past = [];
    this.future = [];
    this.persist();
    this.checkpoints = loadCheckpoints();
    this.showRecoveryCenter = false;
    this.reconcileReport = null;
    this.pushToast('success', '已采用所选恢复点', `${point.label} · ${new Date(point.savedAt).toLocaleString('zh-CN')}`);
  }

  private createManualCheckpoint(): void {
    const result = saveCheckpoint(this.model, 'manual', '值班员手动创建恢复点');
    if (result.ok) {
      this.model = { ...this.model, lastCheckpointId: result.id, updatedAt: Date.now() };
      this.persist();
      this.checkpoints = loadCheckpoints();
      this.pushToast('success', '恢复点已创建', '当前确认记录、术语规则和待确认队列已存档');
    } else {
      this.pushToast('error', '恢复点写入失败', '请检查浏览器存储后重试');
    }
  }

  private toggleFault(): void {
    this.faultArmed = !this.faultArmed;
    if (this.faultArmed) localStorage.setItem(CHECKPOINT_FAULT_KEY, '1');
    else localStorage.removeItem(CHECKPOINT_FAULT_KEY);
  }

  private fillSimulatedAiredList(): void {
    this.airedDraft = generateSimulatedAiredList(this.model);
    this.pushToast('info', '已生成模拟播控清单', '可在文本框中修改后开始对账');
  }

  private runReconcile(): void {
    let items;
    try {
      items = parseAiredList(this.airedDraft);
    } catch (error) {
      this.pushToast('error', '清单无法解析', (error as Error).message);
      return;
    }
    if (!items.length) {
      this.pushToast('warning', '清单为空', '请先粘贴或生成播控已播清单');
      return;
    }
    const result = reconcileAiredList(this.model, items);
    this.model = result.model;
    this.persist();
    this.reconcileReport = result.report;
    this.pushToast(
      'success',
      '对账完成',
      `已上屏锁定 ${result.report.matched.length} 段 · 待重新送播 ${result.report.redeliver.length} 段 · 异常 ${result.report.mismatches.length} 条`,
    );
  }

  private resolveMismatch(mismatch: ReconcileMismatch, adoptAired: boolean): void {
    if (mismatch.kind === 'text-diff' && adoptAired && mismatch.segmentId) {
      this.model = {
        ...this.model,
        segments: this.model.segments.map((item) => item.id === mismatch.segmentId ? {
          ...item,
          corrected: mismatch.airedText,
          locked: true,
          aired: true,
          airedAt: Date.now(),
          revision: item.revision + 1,
        } : item),
        updatedAt: Date.now(),
      };
      this.persist();
    }
    if (this.reconcileReport) {
      this.reconcileReport = { ...this.reconcileReport, mismatches: this.reconcileReport.mismatches.filter((item) => item !== mismatch) };
    }
  }

  private checkpointKindLabel(kind: RecoveryPointKind): string {
    return {
      confirm: '确认存档',
      rule: '规则存档',
      ignore: '忽略存档',
      edit: '修改存档',
      manual: '手动存档',
      migrate: '升级存档',
    }[kind];
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
              <span class="segment-state ${item.state}">${stateLabel(item.state)}${item.locked ? ' · 已上屏锁定' : ''}</span>
            </div>
            <p class="segment-text">${item.original}</p>
            ${item.corrected !== item.original ? html`<p class="segment-corrected">${item.corrected}</p>` : nothing}
            <div class="segment-foot">
              <span>${item.speaker}</span>
              <span>·</span>
              <span>${formatAge(item.receivedAt)}</span>
              ${item.revision > 0 ? html`<span>· <b>修改 ${item.revision} 次</b></span>` : nothing}
            </div>
            ${item.state === 'stale' && item.staleReason ? html`<div class="issue-note">${item.staleReason}。确认前请核对直播上下文。</div>` : nothing}
            ${item.state === 'duplicate' ? html`<div class="issue-note duplicate-note">${item.staleReason || '检测到重复片段'}，请保留或忽略。</div>` : nothing}
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
              <cds-inline-notification kind="success" low-contrast title="该片段已上屏锁定" subtitle="播控已确认播出，内容不可再修改。如需改动，请先到恢复中心处理播控对账。"></cds-inline-notification>
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
              <cds-select label-text="发言人" value=${item.speaker} ?disabled=${item.locked} @cds-select-selected=${(event: CustomEvent<{ value: string }>) => this.updateSelected({ speaker: event.detail.value }, '修改发言人')}>
                ${['主持人', '主讲人', '嘉宾 / 周然', '现场提问', '未知发言人'].map((speaker) => html`<cds-select-item value=${speaker}>${speaker}</cds-select-item>`)}
              </cds-select>
              <cds-number-input class="number-input" label="延迟（秒）" .value=${this.model.simulatedDelay} step="0.1" min="0" max="9" @input=${(event: Event) => this.automatic({ ...this.model, simulatedDelay: Number((event.currentTarget as any).value) })}></cds-number-input>
            </div>
            <cds-textarea
              class="caption-input"
              label-text="校对后的字幕文本"
              helper-text=${item.locked ? '已上屏锁定，不能修改' : 'Ctrl/⌘ + 1–4 快速插入标点；术语规则将从左到右自动应用'}
              .value=${item.corrected}
              ?disabled=${item.locked}
              @input=${(event: Event) => this.updateSelected({ corrected: (event.currentTarget as any).value }, '')}
            ></cds-textarea>
            <div class="edit-toolbar">
              <span>快速标点</span>
              <cds-button kind="ghost" size="sm" ?disabled=${item.locked} @click=${() => this.insertPunctuation('，')}>，逗号</cds-button>
              <cds-button kind="ghost" size="sm" ?disabled=${item.locked} @click=${() => this.insertPunctuation('。')}>。句号</cds-button>
              <cds-button kind="ghost" size="sm" ?disabled=${item.locked} @click=${() => this.insertPunctuation('？')}>？问号</cds-button>
              <cds-button kind="ghost" size="sm" ?disabled=${item.locked} @click=${() => this.insertPunctuation('…')}>…省略</cds-button>
              <cds-button kind="ghost" size="sm" ?disabled=${item.locked} @click=${() => this.wrapSelection('（', '）')}>（）括注</cds-button>
              <cds-button kind="secondary" size="sm" ?disabled=${item.locked} @click=${this.normalizeCurrentNumbers}>规范化数字</cds-button>
            </div>
            <div class="rule-suggestions">
              <small>术语快捷替换</small>
              ${applicableRules.length ? applicableRules.map((rule) => html`
                <cds-button kind="tertiary" size="sm" ?disabled=${item.locked} @click=${() => this.applyTerm(rule.id)}>${rule.source} → ${rule.replacement}</cds-button>
              `) : html`<small>当前发言人的规则为空</small>`}
              <cds-button kind="ghost" size="sm" ?disabled=${item.locked} @click=${this.addRuleFromSelection}>＋ 从当前文本新建</cds-button>
            </div>
          </div>
          <div class="confirm-bar">
            <div class="confirm-hint"><kbd>⌘/Ctrl Enter</kbd> 确认并进入直播区 · <kbd>Alt J/K</kbd> 切换片段</div>
            <div>
              <cds-button kind="danger--tertiary" size="sm" ?disabled=${item.locked} @click=${this.ignoreSelected}>忽略片段</cds-button>
              <cds-button kind="primary" ?disabled=${item.locked} @click=${this.confirmSelected}>${item.locked ? '已上屏锁定' : '确认并送入直播区'}</cds-button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  private renderInspector() {
    const item = this.selected;
    const confirmed = this.model.segments.filter((segment) => segment.state === 'confirmed').sort((a, b) => a.startTime - b.startTime);
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
            <span>${confirmed.length} 段已确认</span>
          </div>
          <div class="live-timeline">
            ${confirmed.length ? confirmed.slice(-12).reverse().map((segment) => html`
              <article class="live-item ${segment.locked ? 'locked' : ''}">
                <time>${formatClock(segment.startTime)} · ${segment.speaker}</time>
                <p>${segment.corrected}</p>
                ${segment.locked ? html`<small>已上屏 · 播控已确认并锁定</small>` : nothing}
                ${!segment.locked && this.model.redeliveryQueue.includes(segment.id) ? html`<small class="redelivery-tag">待重新送播 · 排在播控清单之后</small>` : nothing}
                ${!segment.locked && segment.source === 'offline' ? html`<small>离线来源 · 恢复后合并</small>` : nothing}
              </article>
            `) : html`<div class="empty"><strong>直播区等待内容</strong><p>确认一块字幕后，它会从这里进入实时输出。</p></div>`}
          </div>
          ${this.stats.offline > 0 ? html`<div class="delivery-status">离线发件箱有 ${this.stats.offline} 段待合并。恢复连接后按时间顺序提交，不会覆盖已确认内容。</div>` : nothing}
          ${this.model.redeliveryQueue.length ? html`<div class="delivery-status redelivery">${this.model.redeliveryQueue.length} 段本地新确认内容未上屏，已排在播控清单之后重新送播。</div>` : nothing}
          ${this.model.reconciledAt ? html`<div class="delivery-status reconciled">最近一次播控对账于 ${new Date(this.model.reconciledAt).toLocaleTimeString('zh-CN')} 完成，已上屏片段锁定。</div>` : nothing}
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

  private renderCheckpointsTab() {
    return html`
      <div class="recovery-tab">
        <p class="recovery-help">每次确认前都会先写一份恢复点，完整保存确认记录、术语规则和待确认队列。强制关机后重开，从这里挑一版接着往下用；恢复点写入失败时会自动从上一版重试，当前稿不会被改坏。</p>
        <div class="recovery-actions">
          <cds-button kind="primary" size="sm" @click=${this.createManualCheckpoint}>立即创建恢复点</cds-button>
          <cds-button kind=${this.faultArmed ? 'danger' : 'ghost'} size="sm" @click=${this.toggleFault}>
            ${this.faultArmed ? '已武装：下次确认将模拟写入失败' : '模拟恢复点写入失败'}
          </cds-button>
        </div>
        ${this.checkpoints.length ? html`
          <div class="checkpoint-list">
            ${this.checkpoints.map((point) => html`
              <div class="checkpoint-card ${point.id === this.model.lastCheckpointId ? 'current' : ''}">
                <div class="checkpoint-head">
                  <cds-tag size="sm" type=${point.kind === 'confirm' ? 'green' : point.kind === 'migrate' ? 'purple' : 'blue'}>${this.checkpointKindLabel(point.kind)}</cds-tag>
                  <strong>${point.label}</strong>
                  <span>${new Date(point.savedAt).toLocaleString('zh-CN')}</span>
                  ${point.id === this.model.lastCheckpointId ? html`<cds-tag size="sm" type="outline">当前版本</cds-tag>` : nothing}
                </div>
                <div class="checkpoint-counts">
                  <span>已确认 <b>${point.counts.confirmed}</b></span>
                  <span>待确认 <b>${point.counts.pending}</b></span>
                  <span>规则 <b>${point.counts.rules}</b></span>
                </div>
                ${point.reason ? html`<p class="checkpoint-reason">${point.reason}</p>` : nothing}
                <div class="checkpoint-foot">
                  <span>${Object.keys(point.fingerprints).length} 个片段快照</span>
                  <cds-button kind="tertiary" size="sm" @click=${() => this.adoptCheckpoint(point)}>采用此版本继续</cds-button>
                </div>
              </div>
            `)}
          </div>
        ` : html`<div class="empty"><strong>暂无恢复点</strong><p>确认字幕后会自动生成，也可以点上方按钮手动创建。</p></div>`}
      </div>
    `;
  }

  private renderReconcileTab() {
    const redeliverySequences = (this.reconcileReport?.redeliver ?? [])
      .map((id) => `#${this.model.segments.find((item) => item.id === id)?.sequence ?? '?'}`)
      .join('、');
    return html`
      <div class="recovery-tab">
        <p class="recovery-help">把播控带回的已播清单贴到下面（或生成模拟清单演示）。对账在同一处进行：已上屏的片段就地锁定、不再修改；本地新确认而清单里没有的，排到清单后面重新送播；两边对不上的逐条列出，等人处理后再继续。</p>
        <div class="recovery-actions">
          <cds-button kind="secondary" size="sm" @click=${this.fillSimulatedAiredList}>生成模拟播控清单</cds-button>
          <cds-button kind="primary" size="sm" @click=${this.runReconcile}>开始对账</cds-button>
        </div>
        <cds-textarea
          label-text="播控已播清单（JSON，含 items 数组）"
          helper-text="清单由播控系统带回；可直接粘贴，或先生成模拟清单再修改"
          .value=${this.airedDraft}
          @input=${(event: Event) => { this.airedDraft = (event.currentTarget as any).value; }}
        ></cds-textarea>
        ${this.reconcileReport ? html`
          <div class="reconcile-summary">
            <span class="ok">已上屏锁定 ${this.reconcileReport.matched.length} 段</span>
            <span class="warn">待重新送播 ${this.reconcileReport.redeliver.length} 段${redeliverySequences ? `（${redeliverySequences}）` : ''}</span>
            <span class=${this.reconcileReport.mismatches.length ? 'bad' : ''}>异常 ${this.reconcileReport.mismatches.length} 条</span>
          </div>
          ${this.reconcileReport.redeliver.length ? html`
            <div class="redelivery-note">
              ${redeliverySequences} 为崩溃后本地新确认、但播控清单里没有的片段，已排在已播清单之后，恢复播出时重新送播，不会覆盖已上屏内容。
            </div>
          ` : nothing}
          <div class="mismatch-list">
            ${this.reconcileReport.mismatches.map((mismatch) => html`
              <div class="mismatch-card">
                <div class="mismatch-head">
                  <cds-tag size="sm" type="red">${mismatch.kind === 'text-diff' ? '文本不一致' : '播控有本地无'}</cds-tag>
                  <strong>第 ${mismatch.sequence} 段</strong>
                </div>
                <p class="mismatch-reason">${mismatch.reason}，请人工核对后选择处理方式。</p>
                ${mismatch.kind === 'text-diff' ? html`
                  <div class="mismatch-compare">
                    <div><span>本地校对：</span>${mismatch.localText}</div>
                    <div><span>播控上屏：</span>${mismatch.airedText}</div>
                  </div>
                  <div class="mismatch-actions">
                    <cds-button kind="primary" size="sm" @click=${() => this.resolveMismatch(mismatch, true)}>按播控文本修正并锁定</cds-button>
                    <cds-button kind="ghost" size="sm" @click=${() => this.resolveMismatch(mismatch, false)}>仅标记已知悉，稍后人工处理</cds-button>
                  </div>
                ` : html`
                  <div class="mismatch-compare"><div><span>播控文本：</span>${mismatch.airedText}</div></div>
                  <div class="mismatch-actions">
                    <cds-button kind="ghost" size="sm" @click=${() => this.resolveMismatch(mismatch, false)}>已知悉</cds-button>
                  </div>
                `}
              </div>
            `)}
          </div>
        ` : nothing}
      </div>
    `;
  }

  private renderMigrationTab() {
    return html`
      <div class="recovery-tab">
        <p class="recovery-help">旧稿首次打开已升级到恢复点格式（v${SCHEMA_VERSION}）。接不上的片段原样保留在当前稿中，原因逐条列在下面；确认记录、术语规则和待确认队列从升级时刻起受恢复点保护。</p>
        ${this.migrationNotes.length ? html`
          <ul class="migration-list">
            ${this.migrationNotes.map((note) => html`<li>${note}</li>`)}
          </ul>
        ` : html`<div class="empty"><strong>当前草稿无需升级</strong><p>已是恢复点格式，每次确认都会自动存档。</p></div>`}
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
            <cds-button kind="ghost" size="sm" @click=${() => this.openRecoveryCenter('checkpoints')}>恢复中心${this.checkpoints.length ? `（${this.checkpoints.length}）` : ''}</cds-button>
            <cds-button kind="ghost" size="sm" @click=${this.toggleTheme}>${this.dark ? '浅色界面' : '深色值守'}</cds-button>
            <cds-button kind="ghost" size="sm" @click=${this.undo}>撤销</cds-button>
            <cds-button kind="ghost" size="sm" @click=${this.redo}>重做</cds-button>
            <cds-button kind="primary" size="sm" @click=${this.exportSrt}>导出 SRT</cds-button>
          </div>
        </header>

        <section class="status-strip">
          <div class="status-cell hero">
            <strong>${this.model.connection === 'offline' ? '离线校正中，确认后暂存发件箱' : stats.backlog > 8 ? '队列积压，建议优先处理过期片段' : '队列节奏正常，可以继续逐段确认'}</strong>
            <span>待确认 ${stats.pending} · 过期 ${stats.stale} · 重复 ${stats.duplicate} · 离线待合并 ${stats.offline}</span>
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

        <cds-modal ?open=${this.showRecoveryCenter} size="lg" @cds-modal-closed=${() => { this.showRecoveryCenter = false; }}>
          <cds-modal-header><h3>恢复中心 · 崩溃后续接</h3></cds-modal-header>
          <cds-modal-body>
            <div class="recovery-tabs">
              <button class=${this.recoveryTab === 'checkpoints' ? 'active' : ''} @click=${() => { this.recoveryTab = 'checkpoints'; }}>恢复点${this.checkpoints.length ? ` ${this.checkpoints.length}` : ''}</button>
              <button class=${this.recoveryTab === 'reconcile' ? 'active' : ''} @click=${() => { this.recoveryTab = 'reconcile'; }}>播控对账${this.reconcileReport?.mismatches.length ? ` ${this.reconcileReport.mismatches.length}` : ''}</button>
              <button class=${this.recoveryTab === 'migration' ? 'active' : ''} @click=${() => { this.recoveryTab = 'migration'; }}>升级记录${this.migrationNotes.length ? ` ${this.migrationNotes.length}` : ''}</button>
            </div>
            ${this.recoveryTab === 'checkpoints' ? this.renderCheckpointsTab() : nothing}
            ${this.recoveryTab === 'reconcile' ? this.renderReconcileTab() : nothing}
            ${this.recoveryTab === 'migration' ? this.renderMigrationTab() : nothing}
          </cds-modal-body>
          <cds-modal-footer>
            <cds-button kind="secondary" @click=${() => { this.showRecoveryCenter = false; }}>关闭并继续使用当前稿</cds-button>
          </cds-modal-footer>
        </cds-modal>

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
