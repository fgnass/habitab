// Serializable snapshot of all sessions for the UI views.
import { sidebarMode } from './prefs';
import type { Session, SessionManager } from './sessions';

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
        id: t.id, title: wc.getTitle(), url, loading: wc.isLoading(), active: t === s.active,
        isBlank: !url || url === 'about:blank', fixedSize: t.fixedSize ?? null,
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
      lastActivity: s.lastActivity ?? null,
      activity: s.activity.slice(0, 30),
      held: s.held,
      feedback: s.feedback ? { question: s.feedback.question ?? null, since: s.feedback.since } : null,
      feedbackQueued: s.feedbackQueue.length,
      channel: !!s.meta.channel,
      autoResumeIn: s.autoResumeAt ? Math.max(0, s.autoResumeAt - Date.now()) : null,
      pinned: s.pinned,
      persistentProfile: m.hasPersistentProfile(s),
      endReason: s.endReason ?? null,
      protectedBy: s.protectedBy ?? null,
      devtools: !!s.devtools,
      browser: !!s.ctx,
      tabs,
      nav: awc ? { url: awc.getURL(), canGoBack: awc.navigationHistory.canGoBack(), canGoForward: awc.navigationHistory.canGoForward(), loading: awc.isLoading(), fixedSize: s.active?.fixedSize ?? null, emulation: s.active?.emulation ?? null, frame: s.active?.emulation ? s.active.frame ?? null : null } : null,
    };
  });
  return { selected: m.selected ?? null, sessions, now: Date.now(), sidebar: sidebarMode() };
}

export type UiState = ReturnType<typeof uiState>;
