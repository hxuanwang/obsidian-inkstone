import { PluginSettingTab, Setting } from 'obsidian';
import type InkstonePlugin from './main';
import type { InkstoneSettings } from './settings';
export class InkstoneSettingsTab extends PluginSettingTab {
  constructor(private inkstone: InkstonePlugin) {super(inkstone.app,inkstone);}
  display(): void {
    this.containerEl.empty();
    const dropdown=(name:string,key:'eraserMode'|'toolbarSize'|'doubleTap'|'squeeze',choices:Record<string,string>,desc='')=>{
      new Setting(this.containerEl).setName(name).setDesc(desc).addDropdown(control=>control.addOptions(choices).setValue(this.inkstone.settings[key]).onChange(async value=>{await this.inkstone.updateSettings({[key]:value} as Partial<InkstoneSettings>);}));
    };
    dropdown('Eraser mode','eraserMode',{object:'Object eraser',pixel:'Pixel eraser'});
    dropdown('Toolbar size','toolbarSize',{system:'Follow Obsidian',compact:'Compact',comfortable:'Comfortable'});
    this.containerEl.createEl('h3',{text:'Live recognition'});
    new Setting(this.containerEl).setName('Real-time handwriting recognition').setDesc('Recognize local English handwriting after you pause writing. No page images leave this device. Disable to use manual recognition only and reduce CPU use.').addToggle(control=>control.setValue(this.inkstone.settings.realTimeOCR).onChange(async value=>{await this.inkstone.updateSettings({realTimeOCR:value});}));
    new Setting(this.containerEl).setName('Recognition delay').setDesc('Wait after the last ink change. A longer delay reduces repeated OCR while writing.').addSlider(control=>control.setLimits(800,10000,200).setValue(this.inkstone.settings.recognitionDelayMs).setDynamicTooltip().onChange(async value=>{await this.inkstone.updateSettings({recognitionDelayMs:value});}));
    new Setting(this.containerEl).setName('Real-time spell-check').setDesc('Check handwriting transcripts and typed text using the available local and system dictionaries.').addToggle(control=>control.setValue(this.inkstone.settings.spellcheck).onChange(async value=>{await this.inkstone.updateSettings({spellcheck:value});}));
    this.containerEl.createEl('h3',{text:'Apple Pencil actions'});
    this.containerEl.createEl('p',{text:'Obsidian’s web plugin API does not expose native Apple Pencil squeeze, double-tap, or the iPad system Pencil preference. These action mappings can be invoked through Inkstone commands and a future native host bridge. Hardware gestures require host support.'});
    const actions={eraser:'Switch current tool / eraser',previous:'Switch current / previous tool',palette:'Show tool palette',undo:'Undo',none:'Do nothing'};
    dropdown('Double-tap action','doubleTap',actions);dropdown('Squeeze action','squeeze',actions);
    this.containerEl.createEl('h3',{text:'AI Markdown and math'});
    this.containerEl.createEl('p',{text:'Optional. Use a vision-capable provider with the Chat Completions image format. Only pages you explicitly submit are sent. API keys are stored in this plugin’s data.json; vault sync may copy that file.'});
    for(const [key,name,placeholder] of [['aiEndpoint','Chat Completions endpoint','https://your-provider/v1/chat/completions'],['aiModel','Vision model','Provider model ID'],['aiKey','API key','Optional for local providers']] as const) {
      new Setting(this.containerEl).setName(name).addText(control=>{control.setPlaceholder(placeholder).setValue(this.inkstone.settings[key]);if(key==='aiKey')control.inputEl.type='password';control.onChange(async value=>{await this.inkstone.updateSettings({[key]:value.trim()});});});
    }
    new Setting(this.containerEl).setName('Additional transcription instructions').setDesc('Optional style or language preferences, for example: preserve Chinese text and use ATX headings. Applied alongside the transcription and page-content safeguards.').addTextArea(control=>{control.setPlaceholder('Preserve the original language and notation.').setValue(this.inkstone.settings.aiPrompt);control.inputEl.rows=4;control.onChange(async value=>{await this.inkstone.updateSettings({aiPrompt:value});});});
  }
}
