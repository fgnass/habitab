// Serializable snapshot of all sessions for the UI views.
import { canPush } from '../shared/ipc';
import { sidebarMode } from './prefs';
import { gpuShown, isActiveTab, newProblems, type Session, type SessionManager } from './sessions';

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
        id: t.id, title: wc.getTitle(), url, loading: wc.isLoading(), active: t === s.active, inactive: !isActiveTab(s, t) && !gpuShown(t), debuggerPaused: !!t.debuggerPaused, busy: !!t.busy, gpu: gpuShown(t), gpuPaused: t.gpuPaused ?? 0, gpuStopped: t.gpuLevel === 3, hung: !!t.hungSince, gone: !!t.gone,
        isBlank: !url || url === 'about:blank', targetUrl: t.targetUrl ?? '',
        /** Console errors the user has not seen (badge); repeated ones count once per entry. */
        own: !!t.own,
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
      agentSessionId: s.meta.agentSessionId ?? null,
      agentSessionSource: s.meta.agentSessionSource ?? null,
      phase: phase(s),
      currentTool: s.currentTool ?? null,
      /** The card that shows the session's status: the agent's tab, else the front tab. */
      statusTab: (s.agentTab ?? s.active)?.id ?? null,
      lastActivity: s.lastActivity ?? null,
      activity: s.activity.slice(0, 30),
      /** The timeline of the selected session's front tab (other sessions: only the count). */
      timeline: s.id === m.selected ? s.timeline.filter(x => x.tab === s.active?.id) : null,
      timelineCount: s.timeline.length,
      held: s.held,
      /** The user has control and the agent wants to go on (a held command, or Codex reports a call while all tabs are held). */
      waiting: s.held && (!!s.waiting || (!s.heldTabs && !!s.currentTool)),
      /** Feedback reaches the agent as a note (Claude Code inbox, Codex app-server). */
      push: canPush(s.meta),
      autoResumeIn: s.autoResumeAt ? Math.max(0, s.autoResumeAt - Date.now()) : null,
      pinned: s.pinned,
      muted: s.muted,
      persistentProfile: m.hasPersistentProfile(s),
      pausesDebugger: m.pausesDebugger(s),
      endReason: s.endReason ?? null,
      /** Still served through a launcher of Habitab 0.2: restart the agent's MCP server. */
      legacy: !!s.legacy,
      protectedBy: s.protectedBy ?? null,
      devtools: !!s.devtools,
      browser: !!s.ctx,
      tabs,
      nav: awc ? { url: awc.getURL(), canGoBack: awc.navigationHistory.canGoBack(), canGoForward: awc.navigationHistory.canGoForward(), loading: awc.isLoading(), emulation: s.active?.emulation ?? null, targetUrl: s.active?.targetUrl ?? '', debuggerPaused: !!s.active?.debuggerPaused, busy: !!s.active?.busy, gpuPaused: s.active?.gpuPaused ?? 0, gpuStopped: s.active?.gpuLevel === 3, hung: !!s.active?.hungSince, gone: !!s.active?.gone, own: !!s.active?.own, frame: s.active?.emulation ? s.active.frame ?? null : null,
        // The front tab's console errors in full (texts shortened).
        problems: (s.active?.problems ?? []).map(p => ({ ...p, text: p.text.slice(0, 600) })),
        newProblems: s.active ? newProblems(s, s.active) : 0,
        find: s.active?.find ?? null } : null,
    };
  });
  return { selected: m.selected ?? null, sessions, now: Date.now(), sidebar: sidebarMode() };
}

export type UiState = ReturnType<typeof uiState>;
