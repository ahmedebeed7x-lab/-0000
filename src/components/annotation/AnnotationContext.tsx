import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_ERASER_SETTINGS,
  DEFAULT_HIGHLIGHTER_SETTINGS,
  DEFAULT_LASER_SETTINGS,
  DEFAULT_PEN_SETTINGS,
  SIZE_DIAL_STEP,
  pxToSizeLevel,
  sizeLevelToPx,
  snapSizeLevel,
  type AnnotationStroke,
  type AnnotationTool,
  type EraserSettings,
  type HighlighterSettings,
  type LaserSettings,
  type PenSettings,
} from './types';
import { toArabicDigits } from '../../utils/mushafData';
import { translateStroke } from './strokeEngine';

export interface SelectedStrokeTarget {
  surfaceId: string;
  strokeId: string;
}

interface SurfaceHistory {
  strokes: AnnotationStroke[];
  past: AnnotationStroke[][];
  future: AnnotationStroke[][];
}

export interface ShortcutFeedback {
  label: string;
  keycap: string;
  seq: number;
}

const EMPTY_STROKES: AnnotationStroke[] = [];
const MAX_HISTORY_STEPS = 45;

function isTextTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLTextAreaElement || target.isContentEditable) {
    return true;
  }
  if (target instanceof HTMLInputElement) {
    const inputType = (target.type || 'text').toLowerCase();
    return !['range', 'button', 'checkbox', 'radio', 'submit', 'reset', 'color', 'file'].includes(
      inputType
    );
  }
  return false;
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (isTextTypingTarget(target)) return true;
  return target instanceof HTMLSelectElement;
}

function releaseTrappedFormFocus(): void {
  if (typeof window.focus === 'function' && !document.hasFocus()) {
    window.focus();
  }
  const activeEl = document.activeElement;
  if (
    activeEl instanceof HTMLElement &&
    (isEditableKeyboardTarget(activeEl) || activeEl instanceof HTMLSelectElement)
  ) {
    activeEl.blur();
  }
}

interface AnnotationContextValue {
  activeTool: AnnotationTool;
  setActiveTool: (tool: AnnotationTool) => void;
  isPaletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  penSettings: PenSettings;
  updatePenSettings: (patch: Partial<PenSettings>) => void;
  highlighterSettings: HighlighterSettings;
  updateHighlighterSettings: (patch: Partial<HighlighterSettings>) => void;
  laserSettings: LaserSettings;
  updateLaserSettings: (patch: Partial<LaserSettings>) => void;
  eraserSettings: EraserSettings;
  updateEraserSettings: (patch: Partial<EraserSettings>) => void;
  activeSurfaceId: string;
  hasBoundedSurface: boolean;
  setFallbackSurfaceId: (surfaceId: string) => void;
  registerBoundedSurface: (surfaceId: string) => void;
  unregisterBoundedSurface: (surfaceId: string) => void;
  getStrokes: (surfaceId: string) => AnnotationStroke[];
  addStroke: (surfaceId: string, stroke: AnnotationStroke, replaceIds?: string[]) => void;
  updateStroke: (
    surfaceId: string,
    strokeId: string,
    updater: (stroke: AnnotationStroke) => AnnotationStroke,
    recordHistory?: boolean
  ) => void;
  removeStrokes: (surfaceId: string, strokeIds: string[]) => void;
  undo: (surfaceId?: string) => void;
  redo: (surfaceId?: string) => void;
  clearSurface: (surfaceId?: string) => void;
  canUndo: boolean;
  canRedo: boolean;
  activeStrokeCount: number;
  selectedStroke: SelectedStrokeTarget | null;
  selectedStrokeData: AnnotationStroke | null;
  setSelectedStroke: (target: SelectedStrokeTarget | null) => void;
  duplicateSelectedStroke: () => boolean;
  shortcutFeedback: ShortcutFeedback | null;
}

export interface AnnotationActionsValue {
  setActiveTool: (tool: AnnotationTool) => void;
  setPaletteOpen: (open: boolean) => void;
  updatePenSettings: (patch: Partial<PenSettings>) => void;
  updateHighlighterSettings: (patch: Partial<HighlighterSettings>) => void;
  updateLaserSettings: (patch: Partial<LaserSettings>) => void;
  updateEraserSettings: (patch: Partial<EraserSettings>) => void;
  setFallbackSurfaceId: (surfaceId: string) => void;
  registerBoundedSurface: (surfaceId: string) => void;
  unregisterBoundedSurface: (surfaceId: string) => void;
  addStroke: (surfaceId: string, stroke: AnnotationStroke, replaceIds?: string[]) => void;
  updateStroke: (
    surfaceId: string,
    strokeId: string,
    updater: (stroke: AnnotationStroke) => AnnotationStroke,
    recordHistory?: boolean
  ) => void;
  removeStrokes: (surfaceId: string, strokeIds: string[]) => void;
  setSelectedStroke: (target: SelectedStrokeTarget | null) => void;
  duplicateSelectedStroke: () => boolean;
  undo: (surfaceId?: string) => void;
  redo: (surfaceId?: string) => void;
  clearSurface: (surfaceId?: string) => void;
}

export interface AnnotationToolStateValue {
  activeTool: AnnotationTool;
  isPaletteOpen: boolean;
  penSettings: PenSettings;
  highlighterSettings: HighlighterSettings;
  laserSettings: LaserSettings;
  eraserSettings: EraserSettings;
  hasBoundedSurface: boolean;
  selectedStroke: SelectedStrokeTarget | null;
  selectedStrokeData: AnnotationStroke | null;
  shortcutFeedback: ShortcutFeedback | null;
}

export interface AnnotationDockStateValue {
  canUndo: boolean;
  canRedo: boolean;
  hasActiveStrokes: boolean;
}

const AnnotationContext = createContext<AnnotationContextValue | null>(null);
const AnnotationActionsContext = createContext<AnnotationActionsValue | null>(null);
const AnnotationToolStateContext = createContext<AnnotationToolStateValue | null>(null);
const AnnotationDockStateContext = createContext<AnnotationDockStateValue | null>(null);

interface AnnotationProviderProps {
  children: React.ReactNode;
  defaultOpen?: boolean;
}

export const AnnotationProvider: React.FC<AnnotationProviderProps> = ({
  children,
  defaultOpen = false,
}) => {
  const [activeTool, setActiveToolState] = useState<AnnotationTool>('cursor');
  const [isPaletteOpen, setIsPaletteOpenState] = useState<boolean>(defaultOpen);
  const [penSettings, setPenSettings] = useState<PenSettings>(DEFAULT_PEN_SETTINGS);
  const [highlighterSettings, setHighlighterSettings] = useState<HighlighterSettings>(
    DEFAULT_HIGHLIGHTER_SETTINGS
  );
  const [laserSettings, setLaserSettings] = useState<LaserSettings>(DEFAULT_LASER_SETTINGS);
  const [eraserSettings, setEraserSettings] = useState<EraserSettings>(DEFAULT_ERASER_SETTINGS);
  const [shortcutFeedback, setShortcutFeedback] = useState<ShortcutFeedback | null>(null);

  const [fallbackSurfaceId, setFallbackSurfaceId] = useState<string>('global:home');
  const [boundedSurfaces, setBoundedSurfaces] = useState<string[]>([]);
  const [lastTouchedSurfaceId, setLastTouchedSurfaceId] = useState<string | null>(null);
  const [surfaces, setSurfaces] = useState<Record<string, SurfaceHistory>>({});
  const [selectedStroke, setSelectedStrokeState] = useState<SelectedStrokeTarget | null>(null);

  const selectedStrokeRef = useRef<SelectedStrokeTarget | null>(null);
  selectedStrokeRef.current = selectedStroke;

  const feedbackTimerRef = useRef<number | null>(null);
  const feedbackSeqRef = useRef<number>(0);

  const emitShortcutFeedback = useCallback((label: string, keycap: string) => {
    if (feedbackTimerRef.current !== null) {
      window.clearTimeout(feedbackTimerRef.current);
    }
    feedbackSeqRef.current += 1;
    setShortcutFeedback({ label, keycap, seq: feedbackSeqRef.current });
    feedbackTimerRef.current = window.setTimeout(() => {
      setShortcutFeedback(null);
      feedbackTimerRef.current = null;
    }, 1250);
  }, []);

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current !== null) {
        window.clearTimeout(feedbackTimerRef.current);
      }
    };
  }, []);

  const setActiveTool = useCallback((tool: AnnotationTool) => {
    setActiveToolState(tool);
    if (tool !== 'select') {
      setSelectedStrokeState(null);
    }
    if (tool !== 'cursor') {
      releaseTrappedFormFocus();
    }
  }, []);

  const setSelectedStroke = useCallback((target: SelectedStrokeTarget | null) => {
    setSelectedStrokeState(target);
    if (target) {
      setLastTouchedSurfaceId(target.surfaceId);
    }
  }, []);

  const setPaletteOpen = useCallback((open: boolean) => {
    setIsPaletteOpenState(open);
  }, []);

  const updatePenSettings = useCallback((patch: Partial<PenSettings>) => {
    setPenSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  const updateHighlighterSettings = useCallback((patch: Partial<HighlighterSettings>) => {
    setHighlighterSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  const updateLaserSettings = useCallback((patch: Partial<LaserSettings>) => {
    setLaserSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  const updateEraserSettings = useCallback((patch: Partial<EraserSettings>) => {
    setEraserSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  const registerBoundedSurface = useCallback((surfaceId: string) => {
    setBoundedSurfaces((prev) => (prev.includes(surfaceId) ? prev : [...prev, surfaceId]));
  }, []);

  const unregisterBoundedSurface = useCallback((surfaceId: string) => {
    setBoundedSurfaces((prev) => prev.filter((id) => id !== surfaceId));
  }, []);

  const hasBoundedSurface = boundedSurfaces.length > 0;

  const activeSurfaceId = useMemo(() => {
    if (boundedSurfaces.length > 0) {
      if (lastTouchedSurfaceId && boundedSurfaces.includes(lastTouchedSurfaceId)) {
        return lastTouchedSurfaceId;
      }
      return boundedSurfaces[boundedSurfaces.length - 1];
    }
    return fallbackSurfaceId;
  }, [boundedSurfaces, lastTouchedSurfaceId, fallbackSurfaceId]);

  const activeSurfaceRef = useRef(activeSurfaceId);
  activeSurfaceRef.current = activeSurfaceId;

  const boundedSurfacesRef = useRef(boundedSurfaces);
  boundedSurfacesRef.current = boundedSurfaces;

  const getStrokes = useCallback(
    (surfaceId: string): AnnotationStroke[] => {
      return surfaces[surfaceId]?.strokes ?? EMPTY_STROKES;
    },
    [surfaces]
  );

  const addStroke = useCallback(
    (surfaceId: string, stroke: AnnotationStroke, replaceIds?: string[]) => {
      setLastTouchedSurfaceId(surfaceId);
      const replaceSet = replaceIds && replaceIds.length > 0 ? new Set(replaceIds) : null;
      setSurfaces((prev) => {
        const cur = prev[surfaceId] || { strokes: [], past: [], future: [] };
        const baseStrokes = replaceSet
          ? cur.strokes.filter((s) => !replaceSet.has(s.id))
          : cur.strokes;
        const isReversibleSnappedShape =
          !replaceSet && Boolean(stroke.shape) && stroke.points.length >= 2;
        let nextPast: AnnotationStroke[][];
        if (isReversibleSnappedShape) {
          // Two-step undo for auto-snapped shapes: 1st Ctrl+Z -> freehand, 2nd Ctrl+Z -> erase
          const { shape: _discardShape, ...freehandBase } = stroke;
          const freehandStroke: AnnotationStroke = freehandBase;
          nextPast = [...cur.past, cur.strokes, [...baseStrokes, freehandStroke]].slice(
            -MAX_HISTORY_STEPS
          );
        } else {
          nextPast = [...cur.past.slice(-(MAX_HISTORY_STEPS - 1)), cur.strokes];
        }
        return {
          ...prev,
          [surfaceId]: {
            strokes: [...baseStrokes, stroke],
            past: nextPast,
            future: [],
          },
        };
      });
    },
    []
  );

  const updateStroke = useCallback(
    (
      surfaceId: string,
      strokeId: string,
      updater: (stroke: AnnotationStroke) => AnnotationStroke,
      recordHistory = true
    ) => {
      setLastTouchedSurfaceId(surfaceId);
      setSurfaces((prev) => {
        const cur = prev[surfaceId];
        if (!cur) return prev;
        const idx = cur.strokes.findIndex((s) => s.id === strokeId);
        if (idx === -1) return prev;
        const nextStroke = updater(cur.strokes[idx]);
        if (nextStroke === cur.strokes[idx]) return prev;
        const nextStrokes = cur.strokes.slice();
        nextStrokes[idx] = nextStroke;
        return {
          ...prev,
          [surfaceId]: {
            strokes: nextStrokes,
            past: recordHistory
              ? [...cur.past.slice(-(MAX_HISTORY_STEPS - 1)), cur.strokes]
              : cur.past,
            future: recordHistory ? [] : cur.future,
          },
        };
      });
    },
    []
  );

  const removeStrokes = useCallback((surfaceId: string, strokeIds: string[]) => {
    if (strokeIds.length === 0) return;
    setLastTouchedSurfaceId(surfaceId);
    const idSet = new Set(strokeIds);
    setSurfaces((prev) => {
      const cur = prev[surfaceId];
      if (!cur || !cur.strokes.some((s) => idSet.has(s.id))) return prev;
      const nextPast = [...cur.past.slice(-(MAX_HISTORY_STEPS - 1)), cur.strokes];
      return {
        ...prev,
        [surfaceId]: {
          strokes: cur.strokes.filter((s) => !idSet.has(s.id)),
          past: nextPast,
          future: [],
        },
      };
    });
  }, []);

  const resolveHistoryTarget = useCallback(
    (
      prev: Record<string, SurfaceHistory>,
      kind: 'past' | 'future',
      explicitSurfaceId?: string
    ): string | null => {
      const primaryId = explicitSurfaceId ?? activeSurfaceRef.current;
      const primary = prev[primaryId];
      if (primary && primary[kind].length > 0) return primaryId;
      if (explicitSurfaceId) return null;

      // In double-page Mushaf spreads, seamlessly fall back to the other visible page
      const mounted = boundedSurfacesRef.current;
      for (let i = mounted.length - 1; i >= 0; i--) {
        const id = mounted[i];
        if (id !== primaryId && prev[id] && prev[id][kind].length > 0) {
          return id;
        }
      }
      return null;
    },
    []
  );

  const undo = useCallback(
    (surfaceId?: string) => {
      setSurfaces((prev) => {
        const targetId = resolveHistoryTarget(prev, 'past', surfaceId);
        if (!targetId) return prev;
        const cur = prev[targetId];
        const previous = cur.past[cur.past.length - 1];
        return {
          ...prev,
          [targetId]: {
            strokes: previous,
            past: cur.past.slice(0, -1),
            future: [cur.strokes, ...cur.future.slice(0, MAX_HISTORY_STEPS - 1)],
          },
        };
      });
    },
    [resolveHistoryTarget]
  );

  const redo = useCallback(
    (surfaceId?: string) => {
      setSurfaces((prev) => {
        const targetId = resolveHistoryTarget(prev, 'future', surfaceId);
        if (!targetId) return prev;
        const cur = prev[targetId];
        const next = cur.future[0];
        return {
          ...prev,
          [targetId]: {
            strokes: next,
            past: [...cur.past.slice(-(MAX_HISTORY_STEPS - 1)), cur.strokes],
            future: cur.future.slice(1),
          },
        };
      });
    },
    [resolveHistoryTarget]
  );

  const clearSurface = useCallback((surfaceId?: string) => {
    const targetId = surfaceId ?? activeSurfaceRef.current;
    setSurfaces((prev) => {
      const cur = prev[targetId];
      if (!cur || cur.strokes.length === 0) return prev;
      const nextPast = [...cur.past.slice(-(MAX_HISTORY_STEPS - 1)), cur.strokes];
      return {
        ...prev,
        [targetId]: {
          strokes: [],
          past: nextPast,
          future: [],
        },
      };
    });
  }, []);

  const surfacesRef = useRef(surfaces);
  surfacesRef.current = surfaces;

  const selectedStrokeData = useMemo<AnnotationStroke | null>(() => {
    if (!selectedStroke) return null;
    return (
      (surfaces[selectedStroke.surfaceId]?.strokes ?? EMPTY_STROKES).find(
        (s) => s.id === selectedStroke.strokeId
      ) ?? null
    );
  }, [surfaces, selectedStroke]);

  useEffect(() => {
    if (selectedStroke && !selectedStrokeData) {
      setSelectedStrokeState(null);
    }
  }, [selectedStroke, selectedStrokeData]);

  const duplicateSelectedStroke = useCallback((): boolean => {
    const sel = selectedStrokeRef.current;
    if (!sel) return false;
    const curSurface = surfacesRef.current[sel.surfaceId];
    const orig = curSurface?.strokes.find((s) => s.id === sel.strokeId);
    if (!orig) return false;

    const prefix = sel.surfaceId.startsWith('global:') ? 'gst_' : 'st_';
    const offset = sel.surfaceId.startsWith('global:') ? 20 : 18;
    const clonedBase = translateStroke(orig, offset, offset);
    const cloned: AnnotationStroke = {
      ...clonedBase,
      id: `${prefix}${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    };

    setLastTouchedSurfaceId(sel.surfaceId);
    setSurfaces((prev) => {
      const cur = prev[sel.surfaceId] || { strokes: [], past: [], future: [] };
      const nextPast = [...cur.past.slice(-(MAX_HISTORY_STEPS - 1)), cur.strokes];
      return {
        ...prev,
        [sel.surfaceId]: {
          strokes: [...cur.strokes, cloned],
          past: nextPast,
          future: [],
        },
      };
    });
    setSelectedStrokeState({ surfaceId: sel.surfaceId, strokeId: cloned.id });
    return true;
  }, []);

  const visibleSurfaceIds = boundedSurfaces.length > 0 ? boundedSurfaces : [activeSurfaceId];
  const canUndo = visibleSurfaceIds.some((id) => (surfaces[id]?.past.length ?? 0) > 0);
  const canRedo = visibleSurfaceIds.some((id) => (surfaces[id]?.future.length ?? 0) > 0);
  const activeStrokeCount = surfaces[activeSurfaceId]?.strokes.length ?? 0;

  // Live refs for the capture-phase keyboard listener (avoids listener churn)
  const liveStateRef = useRef({
    activeTool,
    isPaletteOpen,
    canUndo,
    canRedo,
    activeStrokeCount,
    selectedStroke,
    selectedStrokeData,
    penSettings,
    highlighterSettings,
    laserSettings,
    eraserSettings,
  });
  liveStateRef.current = {
    activeTool,
    isPaletteOpen,
    canUndo,
    canRedo,
    activeStrokeCount,
    selectedStroke,
    selectedStrokeData,
    penSettings,
    highlighterSettings,
    laserSettings,
    eraserSettings,
  };

  const stepActiveToolSize = useCallback(
    (delta: -1 | 1) => {
      const state = liveStateRef.current;
      const keycap = delta > 0 ? ']' : '[';
      const step = delta * SIZE_DIAL_STEP;
      if (state.activeTool === 'select' && state.selectedStroke && state.selectedStrokeData) {
        const targetKind = state.selectedStrokeData.kind;
        const curLevel = pxToSizeLevel(targetKind, state.selectedStrokeData.size);
        const nextLevel = snapSizeLevel(curLevel + step);
        updateStroke(
          state.selectedStroke.surfaceId,
          state.selectedStroke.strokeId,
          (st) => ({ ...st, size: sizeLevelToPx(targetKind, nextLevel) }),
          true
        );
        emitShortcutFeedback(`سُمك الشكل: ${toArabicDigits(nextLevel)}٪`, keycap);
        return true;
      }
      if (state.activeTool === 'pen') {
        const curLevel = pxToSizeLevel('pen', state.penSettings.size);
        const nextLevel = snapSizeLevel(curLevel + step);
        updatePenSettings({ size: sizeLevelToPx('pen', nextLevel) });
        emitShortcutFeedback(`سُمك القلم: ${toArabicDigits(nextLevel)}٪`, keycap);
        return true;
      }
      if (state.activeTool === 'highlighter') {
        const curLevel = pxToSizeLevel('highlighter', state.highlighterSettings.size);
        const nextLevel = snapSizeLevel(curLevel + step);
        updateHighlighterSettings({ size: sizeLevelToPx('highlighter', nextLevel) });
        emitShortcutFeedback(`عرض التظليل: ${toArabicDigits(nextLevel)}٪`, keycap);
        return true;
      }
      if (state.activeTool === 'eraser') {
        const curLevel = pxToSizeLevel('eraser', state.eraserSettings.size);
        const nextLevel = snapSizeLevel(curLevel + step);
        updateEraserSettings({ size: sizeLevelToPx('eraser', nextLevel) });
        emitShortcutFeedback(`حجم الممحاة: ${toArabicDigits(nextLevel)}٪`, keycap);
        return true;
      }
      if (state.activeTool === 'laser') {
        const curLevel = pxToSizeLevel('laser', state.laserSettings.size);
        const nextLevel = snapSizeLevel(curLevel + step);
        updateLaserSettings({ size: sizeLevelToPx('laser', nextLevel) });
        emitShortcutFeedback(`سُمك الليزر: ${toArabicDigits(nextLevel)}٪`, keycap);
        return true;
      }
      return false;
    },
    [
      updateStroke,
      updatePenSettings,
      updateHighlighterSettings,
      updateEraserSettings,
      updateLaserSettings,
      emitShortcutFeedback,
    ]
  );

  // Release trapped <select>/<input> focus & keep iframe keyboard focus whenever user clicks/draws outside editable inputs
  useEffect(() => {
    const onPointerDownFocus = (e: PointerEvent) => {
      if (!isEditableKeyboardTarget(e.target)) {
        releaseTrappedFormFocus();
      }
    };
    window.addEventListener('pointerdown', onPointerDownFocus, { capture: true, passive: true });
    return () => window.removeEventListener('pointerdown', onPointerDownFocus, { capture: true });
  }, []);

  // Global layout-independent keyboard shortcuts (Arabic + English keyboard layouts)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const state = liveStateRef.current;
      const code = e.code || '';
      const key = (e.key || '').toLowerCase();
      const keyCode = e.keyCode || e.which || 0;
      const isMod = e.metaKey || e.ctrlKey;

      // 1) Undo / Redo / Clear (Ctrl or Cmd modifiers) — only skip inside active text-typing fields (never block on <select> or sliders)
      if (isMod && !e.altKey) {
        if (isTextTypingTarget(e.target)) return;

        const isZ =
          code === 'KeyZ' ||
          keyCode === 90 ||
          key === 'z' ||
          key === 'ئ' ||
          key === 'ظ' ||
          key === 'ز';
        const isY = code === 'KeyY' || keyCode === 89 || key === 'y' || key === 'غ';

        if (isZ) {
          if (e.shiftKey) {
            if (state.canRedo) {
              e.preventDefault();
              e.stopPropagation();
              redo();
              emitShortcutFeedback('إعادة خطوة', 'Ctrl+Shift+Z');
            } else if (state.activeTool !== 'cursor' || state.isPaletteOpen) {
              e.preventDefault();
            }
          } else {
            if (state.canUndo) {
              e.preventDefault();
              e.stopPropagation();
              const willRevertSnap = (() => {
                const curSurfaces = surfacesRef.current;
                const targetId = resolveHistoryTarget(curSurfaces, 'past');
                if (!targetId) return false;
                const cur = curSurfaces[targetId];
                if (!cur || cur.past.length === 0) return false;
                const prev = cur.past[cur.past.length - 1];
                if (prev.length !== cur.strokes.length || prev.length === 0) return false;
                const lastCur = cur.strokes[cur.strokes.length - 1];
                const lastPrev = prev[prev.length - 1];
                return lastCur.id === lastPrev.id && Boolean(lastCur.shape) && !lastPrev.shape;
              })();
              undo();
              emitShortcutFeedback(
                willRevertSnap ? 'الرجوع للرسم الحر' : 'تراجع خطوة',
                'Ctrl+Z'
              );
            } else if (state.activeTool !== 'cursor' || state.isPaletteOpen) {
              e.preventDefault();
            }
          }
          return;
        }

        if (isY && !e.shiftKey) {
          if (state.canRedo) {
            e.preventDefault();
            e.stopPropagation();
            redo();
            emitShortcutFeedback('إعادة خطوة', 'Ctrl+Y');
          } else if (state.activeTool !== 'cursor' || state.isPaletteOpen) {
            e.preventDefault();
          }
          return;
        }

        const isD = code === 'KeyD' || keyCode === 68 || key === 'd' || key === 'ي';
        if (isD && !e.shiftKey && !e.repeat) {
          if (duplicateSelectedStroke()) {
            e.preventDefault();
            e.stopPropagation();
            emitShortcutFeedback('تكرار الشكل المحدد', 'Ctrl+D');
          }
          return;
        }

        if (
          e.shiftKey &&
          !e.repeat &&
          (code === 'Delete' ||
            code === 'Backspace' ||
            keyCode === 46 ||
            keyCode === 8 ||
            key === 'delete' ||
            key === 'backspace')
        ) {
          if (state.activeStrokeCount > 0) {
            e.preventDefault();
            e.stopPropagation();
            clearSurface();
            emitShortcutFeedback('مسح رسومات الصفحة', 'Ctrl+Shift+Del');
          }
          return;
        }
        return;
      }

      // 2) Single-key tool & brush shortcuts (skip inside text inputs / selects / IME composition)
      if (e.altKey || e.isComposing || isEditableKeyboardTarget(e.target)) return;

      if (code === 'Escape' || keyCode === 27 || key === 'escape') {
        if (state.activeTool !== 'cursor') {
          e.preventDefault();
          setActiveTool('cursor');
          emitShortcutFeedback('وضع التصفح', 'Esc');
        }
        return;
      }

      if (e.shiftKey) return;

      // Brush / Nib size steppers: [ and ] (Arabic ج and د)
      if (code === 'BracketRight' || keyCode === 221 || key === ']' || key === 'د') {
        if (stepActiveToolSize(1)) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      if (code === 'BracketLeft' || keyCode === 219 || key === '[' || key === 'ج') {
        if (stepActiveToolSize(-1)) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }

      if (e.repeat) return;

      if (code === 'KeyP' || keyCode === 80 || key === 'p' || key === 'ح') {
        e.preventDefault();
        e.stopPropagation();
        setActiveTool('pen');
        emitShortcutFeedback('قلم أبل', 'P');
      } else if (code === 'KeyH' || keyCode === 72 || key === 'h' || key === 'ا') {
        e.preventDefault();
        e.stopPropagation();
        setActiveTool('highlighter');
        emitShortcutFeedback('تظليل أبل', 'H');
      } else if (code === 'KeyL' || keyCode === 76 || key === 'l' || key === 'م') {
        e.preventDefault();
        e.stopPropagation();
        setActiveTool('laser');
        emitShortcutFeedback('ليزر ضوئي', 'L');
      } else if (code === 'KeyE' || keyCode === 69 || key === 'e' || key === 'ث') {
        e.preventDefault();
        e.stopPropagation();
        setActiveTool('eraser');
        emitShortcutFeedback('ممحاة ذكية', 'E');
      } else if (code === 'KeyS' || keyCode === 83 || key === 's' || key === 'س') {
        e.preventDefault();
        e.stopPropagation();
        setActiveTool('select');
        emitShortcutFeedback('تعديل الأشكال', 'S');
      } else if (code === 'KeyV' || keyCode === 86 || key === 'v' || key === 'ر') {
        if (state.activeTool !== 'cursor') {
          e.preventDefault();
          e.stopPropagation();
          setActiveTool('cursor');
          emitShortcutFeedback('وضع التصفح', 'V');
        }
      }
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [
    undo,
    redo,
    clearSurface,
    duplicateSelectedStroke,
    setActiveTool,
    resolveHistoryTarget,
    stepActiveToolSize,
    emitShortcutFeedback,
  ]);

  const value = useMemo<AnnotationContextValue>(
    () => ({
      activeTool,
      setActiveTool,
      isPaletteOpen,
      setPaletteOpen,
      penSettings,
      updatePenSettings,
      highlighterSettings,
      updateHighlighterSettings,
      laserSettings,
      updateLaserSettings,
      eraserSettings,
      updateEraserSettings,
      activeSurfaceId,
      hasBoundedSurface,
      setFallbackSurfaceId,
      registerBoundedSurface,
      unregisterBoundedSurface,
      getStrokes,
      addStroke,
      updateStroke,
      removeStrokes,
      undo,
      redo,
      clearSurface,
      canUndo,
      canRedo,
      activeStrokeCount,
      selectedStroke,
      selectedStrokeData,
      setSelectedStroke,
      duplicateSelectedStroke,
      shortcutFeedback,
    }),
    [
      activeTool,
      setActiveTool,
      isPaletteOpen,
      setPaletteOpen,
      penSettings,
      updatePenSettings,
      highlighterSettings,
      updateHighlighterSettings,
      laserSettings,
      updateLaserSettings,
      eraserSettings,
      updateEraserSettings,
      activeSurfaceId,
      hasBoundedSurface,
      registerBoundedSurface,
      unregisterBoundedSurface,
      getStrokes,
      addStroke,
      updateStroke,
      removeStrokes,
      undo,
      redo,
      clearSurface,
      canUndo,
      canRedo,
      activeStrokeCount,
      selectedStroke,
      selectedStrokeData,
      setSelectedStroke,
      duplicateSelectedStroke,
      shortcutFeedback,
    ]
  );

  const actionsValue = useMemo<AnnotationActionsValue>(
    () => ({
      setActiveTool,
      setPaletteOpen,
      updatePenSettings,
      updateHighlighterSettings,
      updateLaserSettings,
      updateEraserSettings,
      setFallbackSurfaceId,
      registerBoundedSurface,
      unregisterBoundedSurface,
      addStroke,
      updateStroke,
      removeStrokes,
      setSelectedStroke,
      duplicateSelectedStroke,
      undo,
      redo,
      clearSurface,
    }),
    [
      setActiveTool,
      setPaletteOpen,
      updatePenSettings,
      updateHighlighterSettings,
      updateLaserSettings,
      updateEraserSettings,
      registerBoundedSurface,
      unregisterBoundedSurface,
      addStroke,
      updateStroke,
      removeStrokes,
      setSelectedStroke,
      duplicateSelectedStroke,
      undo,
      redo,
      clearSurface,
    ]
  );

  const hasActiveStrokes = activeStrokeCount > 0;

  const toolStateValue = useMemo<AnnotationToolStateValue>(
    () => ({
      activeTool,
      isPaletteOpen,
      penSettings,
      highlighterSettings,
      laserSettings,
      eraserSettings,
      hasBoundedSurface,
      selectedStroke,
      selectedStrokeData,
      shortcutFeedback,
    }),
    [
      activeTool,
      isPaletteOpen,
      penSettings,
      highlighterSettings,
      laserSettings,
      eraserSettings,
      hasBoundedSurface,
      selectedStroke,
      selectedStrokeData,
      shortcutFeedback,
    ]
  );

  const dockStateValue = useMemo<AnnotationDockStateValue>(
    () => ({
      canUndo,
      canRedo,
      hasActiveStrokes,
    }),
    [canUndo, canRedo, hasActiveStrokes]
  );

  return (
    <AnnotationActionsContext.Provider value={actionsValue}>
      <AnnotationToolStateContext.Provider value={toolStateValue}>
        <AnnotationDockStateContext.Provider value={dockStateValue}>
          <AnnotationContext.Provider value={value}>{children}</AnnotationContext.Provider>
        </AnnotationDockStateContext.Provider>
      </AnnotationToolStateContext.Provider>
    </AnnotationActionsContext.Provider>
  );
};

export function useAnnotation(): AnnotationContextValue {
  const ctx = useContext(AnnotationContext);
  if (!ctx) {
    throw new Error('useAnnotation must be used within an AnnotationProvider');
  }
  return ctx;
}

export function useAnnotationActions(): AnnotationActionsValue {
  const ctx = useContext(AnnotationActionsContext);
  if (!ctx) {
    throw new Error('useAnnotationActions must be used within an AnnotationProvider');
  }
  return ctx;
}

export function useAnnotationToolState(): AnnotationToolStateValue {
  const ctx = useContext(AnnotationToolStateContext);
  if (!ctx) {
    throw new Error('useAnnotationToolState must be used within an AnnotationProvider');
  }
  return ctx;
}

export function useAnnotationDockState(): AnnotationDockStateValue {
  const ctx = useContext(AnnotationDockStateContext);
  if (!ctx) {
    throw new Error('useAnnotationDockState must be used within an AnnotationProvider');
  }
  return ctx;
}
