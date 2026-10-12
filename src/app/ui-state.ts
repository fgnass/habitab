// Serializable snapshot of all sessions for the UI views.
import { canPush } from '../shared/ipc';
import { sidebarMode } from './prefs';
import { isActiveTab, type Problem, type Session, type SessionManager } from './sessions';

export type Phase = 'connected' | 'tool' | 'idle' | 'disconnected' | 'ended' | 'kept';

export function phase(s: Session): Phase {
  if (s.ended) return s.tabs.length ? 'kept' : 'ended';
  if (!s.line) return 'disconnected';
  if (s.currentTool) return 'tool';
  const last = Math.max(s.lastActivity ?? 0, Date.parse(s.meta.startedAt ?? '') || 0);
  return Date.now() - last > 120_000 ? 'idle' : 'connected';
}

export function uiState(m: SessionManager) {
  const sessions = [...m.sessions.values()].map(s => {
    const tabs = s.tabs.map(t => {
      const wc = t.view.webContents;
      const url = wc.getURL();
      return {
        id: t.id, title: wc.getTitle(), url, loading: wc.isLoading(), active: t === s.active, inactive: !isActiveTab(s, t), debuggerPaused: !!t.debuggerPaused, busy: !!t.busy,
        isBlank: !url || url === 'about:blank', fixedSize: t.fixedSize ?? null, targetUrl: t.targetUrl ?? '',
        problems: problemCounts(t.problems),
      };
    });
    const awc = s.active?.view.webContents;
    return {
      id: s.id,
      // The sidebar names a session by its page; the project comes from the agent's directory.
      title: (awc && awc.getURL() !== 'about:blank' && (awc.getTitle() || awc.getURL())) || s.meta.projectName || 'New Session',
      project: s.meta.projectName ?? 'No Project',
      projectPath: s.meta.projectRoot ?? s.meta.cwd ?? '',
      client: s.meta.client ?? null,
      clientName: s.meta.clientName ?? null,
      clientVersion: s.meta.clientVersion ?? null,
      agentSessionId: s.meta.agentSessionId ?? null,
      agentSessionSource: s.meta.agentSessionSource ?? null,
      phase: phase(s),
      currentTool: s.currentTool ?? null,
      /** The card that shows the session's status: the agent's tab, else the front tab. */
      statusTab: (s.agentTab ?? s.active)?.id ?? null,
      lastActivity: s.lastActivity ?? null,
      activity: s.activity.slice(0, 30),
      /** The selected session's timeline (other sessions: only the count). */
      timeline: s.id === m.selected ? s.timeline : null,
      timelineCount: s.timeline.length,
      held: s.held,
      feedback: s.feedback ? { question: s.feedback.question ?? null, since: s.feedback.since } : null,
      feedbackQueued: s.feedbackQueue.length,
      channel: !!s.meta.channel,
      /** Feedback reaches the agent at once, also when no call waits. */
      push: canPush(s.meta),
      autoResumeIn: s.autoResumeAt ? Math.max(0, s.autoResumeAt - Date.now()) : null,
      pinned: s.pinned,
      muted: s.muted,
      persistentProfile: m.hasPersistentProfile(s),
      pausesDebugger: m.pausesDebugger(s),
      endReason: s.endReason ?? null,
      protectedBy: s.protectedBy ?? null,
      devtools: !!s.devtools,
      browser: !!s.ctx,
      tabs,
      nav: awc ? { url: awc.getURL(), canGoBack: awc.navigationHistory.canGoBack(), canGoForward: awc.navigationHistory.canGoForward(), loading: awc.isLoading(), fixedSize: s.active?.fixedSize ?? null, emulation: s.active?.emulation ?? null, targetUrl: s.active?.targetUrl ?? '', debuggerPaused: !!s.active?.debuggerPaused, busy: !!s.active?.busy, frame: s.active?.emulation ? s.active.frame ?? null : null,
        // The front tab's problems in full (texts shortened), for the problem list.
        problems: (s.active?.problems ?? []).map(p => ({ ...p, text: p.text.slice(0, 600) })) } : null,
    };
  });
  return { selected: m.selected ?? null, sessions, now: Date.now(), sidebar: sidebarMode() };
}

/** Problems of a tab by kind; repeated ones count once per entry. */
function problemCounts(problems: Problem[]) {
  const console = problems.filter(p => p.kind === 'console').length;
  return { total: problems.length, console, network: problems.length - console };
}

export type UiState = ReturnType<typeof uiState>;
