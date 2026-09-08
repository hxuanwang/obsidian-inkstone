import { PAGE_SIZES, pageColor, pageDimensions, type InkPage, type PageFormat, type PageSize, type Paper } from './model';
import { PAPER_TEMPLATES, paperSvg } from './paper';

const PAPER_COLORS = [
  { label: 'Cream', value: '#faf9ef' },
  { label: 'White', value: '#ffffff' },
  { label: 'Soft yellow', value: '#fff7cf' },
  { label: 'Rose', value: '#f9e8e8' },
  { label: 'Blue', value: '#e6eff8' },
  { label: 'Green', value: '#e8f1e6' },
  { label: 'Charcoal', value: '#30343b' },
] as const;

/** Preview paper choices without touching the page until Apply is pressed. */
export function openTemplatePicker(
  host: HTMLElement,
  page: InkPage,
  onApply: (format: PageFormat & { paper: Paper }) => void,
): () => void {
  const document = host.ownerDocument;
  const previousFocus = document.activeElement as HTMLElement | null;
  const draft: Required<PageFormat> & { paper: Paper } = {
    paper: page.paper,
    pageSize: page.pageSize ?? 'standard',
    orientation: page.orientation ?? 'portrait',
    paperColor: pageColor(page).toLowerCase(),
  };
  const id = `inkstone-template-${crypto.randomUUID()}`;
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, name: string, text?: string): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    node.className = `inkstone-template-${name}`;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (name: string, text: string): HTMLButtonElement => {
    const node = element('button', name, text); node.type = 'button'; return node;
  };
  const sheet = (): SVGSVGElement => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('inkstone-template-sheet');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    return svg;
  };
  const overlay = element('div', 'overlay');
  const dialog = element('section', 'dialog');
  dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', `${id}-title`);
  dialog.setAttribute('aria-describedby', `${id}-description`);
  dialog.tabIndex = -1;
  overlay.append(dialog);

  const header = element('header', 'header');
  const cancel = button('cancel', '×');
  cancel.setAttribute('aria-label', 'Cancel paper changes'); cancel.title = 'Cancel';
  const heading = element('div', 'heading');
  const title = element('h2', 'title', 'Paper templates'); title.id = `${id}-title`;
  const description = element('p', 'description', 'Choose the paper for this page.'); description.id = `${id}-description`;
  heading.append(title, description);
  const apply = button('apply', 'Apply');
  header.append(cancel, heading, apply);

  const body = element('div', 'body');
  const overview = element('div', 'overview');
  const preview = element('figure', 'preview');
  const previewStage = element('div', 'preview-stage');
  const previewSheet = sheet(); previewStage.append(previewSheet);
  const previewCaption = element('figcaption', 'preview-caption');
  const previewName = element('strong', 'preview-name');
  const previewFormat = element('span', 'preview-format');
  previewCaption.append(previewName, previewFormat);
  preview.append(previewStage, previewCaption);

  const settings = element('div', 'settings');
  const formatFields = element('div', 'format-fields');
  const sizeLabel = element('label', 'field');
  sizeLabel.append(element('span', 'field-label', 'Size'));
  const size = element('select', 'select'); size.setAttribute('aria-label', 'Page size');
  for (const item of PAGE_SIZES) {
    const option = document.createElement('option'); option.value = item.value; option.textContent = item.label; size.append(option);
  }
  size.value = draft.pageSize; sizeLabel.append(size);
  const orientationLabel = element('label', 'field');
  orientationLabel.append(element('span', 'field-label', 'Orientation'));
  const orientation = element('select', 'select'); orientation.setAttribute('aria-label', 'Page orientation');
  for (const value of ['portrait', 'landscape'] as const) {
    const option = document.createElement('option'); option.value = value; option.textContent = value === 'portrait' ? 'Portrait' : 'Landscape'; orientation.append(option);
  }
  orientation.value = draft.orientation; orientationLabel.append(orientation);
  formatFields.append(sizeLabel, orientationLabel);

  const colorField = element('div', 'color-field');
  const colorHeading = element('div', 'color-heading');
  const colorLabel = element('span', 'field-label', 'Color'); colorLabel.id = `${id}-color`;
  const colorName = element('span', 'color-name');
  colorHeading.append(colorLabel, colorName);
  const colors = element('div', 'colors'); colors.setAttribute('role', 'group'); colors.setAttribute('aria-labelledby', colorLabel.id);
  const colorButtons = PAPER_COLORS.map(color => {
    const swatch = button('swatch', '');
    swatch.title = color.label; swatch.setAttribute('aria-label', `${color.label} paper`);
    swatch.style.setProperty('--ink-template-swatch', color.value);
    swatch.addEventListener('click', () => { draft.paperColor = color.value; render(); });
    colors.append(swatch);
    return { color, swatch };
  });
  const custom = element('label', 'custom-color');
  const customSymbol = element('span', 'custom-symbol', '+'); customSymbol.setAttribute('aria-hidden', 'true');
  const customInput = element('input', 'color-input'); customInput.type = 'color';
  customInput.setAttribute('aria-label', 'Custom paper color'); customInput.title = 'Custom paper color';
  customInput.value = draft.paperColor;
  customInput.addEventListener('input', () => {
    draft.paperColor = customInput.value.toLowerCase(); render();
  });
  custom.append(customSymbol, customInput); colors.append(custom);
  colorField.append(colorHeading, colors);
  settings.append(formatFields, colorField);
  overview.append(preview, settings);

  const templates = element('section', 'templates');
  const templatesHeading = element('h3', 'section-title', 'Templates'); templatesHeading.id = `${id}-templates`;
  const grid = element('div', 'grid'); grid.setAttribute('role', 'group'); grid.setAttribute('aria-labelledby', templatesHeading.id);
  const cards = PAPER_TEMPLATES.map(template => {
    const card = button('card', ''); card.dataset.paper = template.value;
    card.setAttribute('aria-label', `${template.label} template`);
    const stage = element('span', 'card-stage');
    const svg = sheet();
    const check = element('span', 'check', '✓'); check.setAttribute('aria-hidden', 'true');
    stage.append(svg, check);
    card.append(stage, element('span', 'card-label', template.label));
    card.addEventListener('click', () => { draft.paper = template.value; render(); });
    grid.append(card);
    return { template, card, svg };
  });
  templates.append(templatesHeading, grid);
  body.append(overview, templates);
  dialog.append(header, body);

  function renderSheet(svg: SVGSVGElement, paper: Paper): void {
    const { width, height } = pageDimensions(draft);
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.style.aspectRatio = `${width} / ${height}`;
    svg.innerHTML = paperSvg(paper, draft);
  }
  function render(): void {
    const label = PAPER_TEMPLATES.find(template => template.value === draft.paper)!.label;
    const sizeLabel = PAGE_SIZES.find(item => item.value === draft.pageSize)!.label;
    const orientationLabel = draft.orientation === 'portrait' ? 'Portrait' : 'Landscape';
    const namedColor = PAPER_COLORS.find(color => color.value === draft.paperColor);
    previewName.textContent = label;
    previewFormat.textContent = `${sizeLabel} · ${orientationLabel}`;
    colorName.textContent = namedColor?.label ?? draft.paperColor.toUpperCase();
    customInput.value = draft.paperColor;
    custom.dataset.selected = String(!namedColor);
    for (const { color, swatch } of colorButtons) swatch.setAttribute('aria-pressed', String(color.value === draft.paperColor));
    for (const { template, card, svg } of cards) {
      card.setAttribute('aria-pressed', String(template.value === draft.paper));
      renderSheet(svg, template.value);
    }
    renderSheet(previewSheet, draft.paper);
  }
  size.addEventListener('change', () => { draft.pageSize = size.value as PageSize; render(); });
  orientation.addEventListener('change', () => { draft.orientation = orientation.value as 'portrait' | 'landscape'; render(); });

  let closed = false;
  // Preserve pre-existing inert state, including when another host surface is disabled.
  const siblings = Array.from(host.children).filter(child => 'inert' in child).map(child => ({ node: child as HTMLElement, inert: (child as HTMLElement).inert }));
  const close = (): void => {
    if (closed) return;
    closed = true;
    overlay.remove();
    for (const { node, inert } of siblings) node.inert = inert;
    if (previousFocus?.isConnected && typeof previousFocus.focus === 'function') previousFocus.focus({ preventScroll: true });
  };
  cancel.addEventListener('click', close);
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  apply.addEventListener('click', () => {
    if (closed) return;
    close();
    onApply({ ...draft });
  });
  overlay.addEventListener('keydown', event => {
    // Keep editor shortcuts out of the dialog while preserving native control behavior.
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled), [tabindex="0"]'));
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
      event.preventDefault(); last?.focus();
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
      event.preventDefault(); first?.focus();
    }
  });

  render();
  host.append(overlay);
  for (const { node } of siblings) node.inert = true;
  cancel.focus({ preventScroll: true });
  return close;
}
