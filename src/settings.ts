import type { EraserMode } from './eraser';
export type PencilAction = 'eraser' | 'previous' | 'palette' | 'undo' | 'none';
export interface InkstoneSettings {
  eraserMode: EraserMode;
  toolbarSize: 'system' | 'compact' | 'comfortable';
  doubleTap: PencilAction;
  squeeze: PencilAction;
  realTimeOCR: boolean;
  recognitionDelayMs: number;
  spellcheck: boolean;
  aiPrompt: string;
  aiEndpoint: string;
  aiModel: string;
  aiKey: string;
}
export const DEFAULT_SETTINGS: InkstoneSettings = {
  eraserMode: 'object', toolbarSize: 'system', doubleTap: 'eraser', squeeze: 'palette',
  realTimeOCR: true, recognitionDelayMs: 1800, spellcheck: true, aiPrompt: '',
  aiEndpoint: '', aiModel: '', aiKey: '',
};
export function parseSettings(value: Partial<InkstoneSettings> | null): InkstoneSettings {
  const s = {...DEFAULT_SETTINGS, ...value};
  if(!['pixel','object'].includes(s.eraserMode))s.eraserMode='object';
  if(!['system','compact','comfortable'].includes(s.toolbarSize))s.toolbarSize='system';
  for(const key of ['doubleTap','squeeze'] as const)if(!['eraser','previous','palette','undo','none'].includes(s[key]))s[key]=DEFAULT_SETTINGS[key];
  for(const key of ['realTimeOCR','spellcheck'] as const)if(typeof s[key]!=='boolean')s[key]=DEFAULT_SETTINGS[key];
  s.recognitionDelayMs=typeof s.recognitionDelayMs==='number' && Number.isFinite(s.recognitionDelayMs) ? Math.max(800,Math.min(10000,Math.round(s.recognitionDelayMs))) : DEFAULT_SETTINGS.recognitionDelayMs;
  for(const key of ['aiEndpoint','aiModel','aiKey','aiPrompt'] as const)if(typeof s[key]!=='string')s[key]='';
  return s;
}
