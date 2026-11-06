// Sources of a page's context menu (Electron's menuSourceType) that are touch
// gestures: in touch emulation the mouse sends touches, and a long press is a
// gesture of the app under test, not a request for Habitab's menu.
const TOUCH_SOURCES = new Set(['touch', 'touchMenu', 'longPress', 'longTap', 'touchHandle']);

/** Habitab shows its context menu for a right click or the menu key, not for a touch gesture. */
export const showsContextMenu = (source: string | undefined): boolean => !TOUCH_SOURCES.has(source ?? '');
