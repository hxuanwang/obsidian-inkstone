import { PluginSettingTab, Setting, requestUrl } from 'obsidian';
import { fetchModels, testProvider } from './ai-provider';
import type InkstonePlugin from './main';
import type { InkstoneSettings } from './settings';
export class InkstoneSettingsTab extends PluginSettingTab {
  constructor(private inkstone: InkstonePlugin) {super(inkstone.app,inkstone);}
  private displayVersion=0;
  private requestController?: AbortController;
  hide(): void {this.displayVersion++;this.requestController?.abort();this.requestController=undefined;}
  display(): void {
    this.requestController?.abort();this.requestController=undefined;
    const displayVersion=++this.displayVersion;
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
    let configurationVersion=0;
    let modelInput: import('obsidian').TextComponent;
    let modelsRow: Setting|undefined;
    let status: HTMLElement|undefined;
    let modelChoices: import('obsidian').DropdownComponent;
    const configurationChanged=()=>{configurationVersion++;this.requestController?.abort();if(status)status.textContent='';};
    for(const [key,name,placeholder] of [['aiEndpoint','Chat Completions endpoint','https://your-provider/v1/chat/completions'],['aiModel','Vision model','Provider model ID'],['aiKey','API key','Optional for local providers']] as const) {
      new Setting(this.containerEl).setName(name).addText(control=>{control.setPlaceholder(placeholder).setValue(this.inkstone.settings[key]);if(key==='aiKey')control.inputEl.type='password';if(key==='aiModel')modelInput=control;control.onChange(async value=>{configurationChanged();if(key==='aiModel')modelChoices.setValue(value.trim());else if(modelsRow)modelsRow.settingEl.hidden=true;await this.inkstone.updateSettings({[key]:value.trim()});});});
    }
    modelsRow=new Setting(this.containerEl).setName('Available models').setDesc('The provider may list text-only models too. Choose a vision model and test it.').addDropdown(control=>{
      modelChoices=control;control.onChange(async value=>{if(!value)return;configurationChanged();modelInput.setValue(value);await this.inkstone.updateSettings({aiModel:value});});
    });
    modelsRow.settingEl.hidden=true;
    let busy=false;
    let fetchButton: import('obsidian').ButtonComponent;
    let testButton: import('obsidian').ButtonComponent;
    const run=async(kind:'models'|'test')=>{
      if(busy||this.displayVersion!==displayVersion)return;
      busy=true;fetchButton.setDisabled(true);testButton.setDisabled(true);
      const controller=new AbortController();this.requestController=controller;
      const version=configurationVersion;
      const config={...this.inkstone.settings};
      const current=()=>this.displayVersion===displayVersion&&configurationVersion===version;
      status!.textContent=kind==='models'?'Fetching models…':'Testing the model with a built-in sample image…';
      try {
        if(kind==='models') {
          const models=await fetchModels(config,requestUrl,controller.signal);
          if(!current())return;
          modelChoices.selectEl.empty();
          modelChoices.addOption('','Choose a model');
          for(const model of models)modelChoices.addOption(model,model);
          if(config.aiModel&&!models.includes(config.aiModel))modelChoices.addOption(config.aiModel,`${config.aiModel} (current)`);
          modelChoices.setValue(config.aiModel);modelsRow!.settingEl.hidden=false;
          status!.textContent=`Found ${models.length} models. Choose one above or keep your manually entered model ID.`;
        } else {
          await testProvider(config,requestUrl,controller.signal);
          if(current())status!.textContent='Connection successful. The model accepted the sample image and returned text.';
        }
      } catch(error) {if(current())status!.textContent=error instanceof Error?error.message:'Provider check failed.';}
      finally {busy=false;if(this.requestController===controller)this.requestController=undefined;if(this.displayVersion===displayVersion){fetchButton.setDisabled(false);testButton.setDisabled(false);}}
    };
    new Setting(this.containerEl).setName('Check AI configuration').setDesc('Fetch models from this provider, or test your chosen model with a built-in sample image. No notebook content is sent. The test may incur a small provider charge.').addButton(button=>{fetchButton=button;button.setButtonText('Fetch models').onClick(()=>run('models'));}).addButton(button=>{testButton=button;button.setButtonText('Test connection').onClick(()=>run('test'));});
    status=this.containerEl.createEl('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    new Setting(this.containerEl).setName('Additional transcription instructions').setDesc('Optional style or language preferences, for example: preserve Chinese text and use ATX headings. Applied alongside the transcription and page-content safeguards.').addTextArea(control=>{control.setPlaceholder('Preserve the original language and notation.').setValue(this.inkstone.settings.aiPrompt);control.inputEl.rows=4;control.onChange(async value=>{await this.inkstone.updateSettings({aiPrompt:value});});});
  }
}
