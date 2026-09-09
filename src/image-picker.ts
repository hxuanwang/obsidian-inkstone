/** System file inputs keep Photos/camera permission and selection under OS control. */
export function openImagePicker(options: {
  host: HTMLElement;
  anchor: HTMLButtonElement;
  recent: readonly string[];
  onFile: (file: File) => void;
  onRecent: (src: string) => void;
  onClose: () => void;
}): () => void {
  const { host, anchor } = options;
  const doc = host.ownerDocument;
  const panel = doc.createElement('div');
  panel.className = 'inkstone-image-picker';
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Images');
  const heading = doc.createElement('div'); heading.className = 'inkstone-image-picker-heading';
  const title = doc.createElement('strong'); title.textContent = 'Images'; heading.append(title);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true; panel.remove(); doc.removeEventListener('pointerdown', outside, true);
    doc.defaultView?.removeEventListener('resize', position);
    anchor.setAttribute('aria-expanded', 'false'); options.onClose();
    if (anchor.isConnected) anchor.focus({ preventScroll: true });
  };
  const button = (label: string, action: () => void) => {
    const node = doc.createElement('button'); node.type = 'button'; node.className = 'inkstone-button';
    node.textContent = label; node.addEventListener('click', action); return node;
  };
  const input = (accept: string, capture = false) => {
    const node = doc.createElement('input'); node.type = 'file'; node.accept = accept; node.hidden = true;
    if (capture) node.setAttribute('capture', 'environment');
    node.addEventListener('change', () => {
      const file = node.files?.[0]; node.value = '';
      if (!file || closed) return;
      options.onFile(file); close();
    });
    panel.append(node); return node;
  };
  const photosInput = input('image/*');
  const cameraInput = input('image/*', true);
  const filesInput = input('image/png,image/jpeg,image/gif,image/webp');
  const camera = button('', () => cameraInput.click()); camera.title = 'Take a photo'; camera.setAttribute('aria-label', 'Take a photo');
  camera.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M8 5l2-2h4l2 2h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/><circle cx="12" cy="12" r="4"/></svg>';
  const dismiss = button('×', close); dismiss.setAttribute('aria-label', 'Close images');
  heading.append(camera, dismiss); panel.append(heading);
  const photos = button('Choose from Photos', () => photosInput.click()); photos.classList.add('inkstone-image-photos'); panel.append(photos);
  const recent = [...new Set(options.recent)].slice(0, 20);
  if (recent.length) {
    const label = doc.createElement('p'); label.className = 'inkstone-image-recent-label'; label.textContent = 'In this notebook'; panel.append(label);
    const grid = doc.createElement('div'); grid.className = 'inkstone-image-grid';
    for (const [index, src] of recent.entries()) {
      const tile = button('', () => { options.onRecent(src); close(); }); tile.className = 'inkstone-image-tile'; tile.setAttribute('aria-label', `Insert notebook image ${index + 1}`);
      const image = doc.createElement('img'); image.src = src; image.alt = ''; image.loading = 'lazy'; tile.append(image); grid.append(tile);
    }
    panel.append(grid);
  } else {
    const empty = doc.createElement('p'); empty.className = 'inkstone-image-empty'; empty.textContent = 'Choose a photo to add it to your page. Images in this notebook will appear here.'; panel.append(empty);
  }
  const files = button('Insert from…', () => filesInput.click()); files.classList.add('inkstone-image-files'); panel.append(files);
  const outside = (event: Event) => { if (!panel.contains(event.target as Node) && !anchor.contains(event.target as Node)) close(); };
  const position = () => {
    const bounds = host.getBoundingClientRect(), rect = anchor.getBoundingClientRect();
    panel.style.left = `${Math.max(8, Math.min(rect.left - bounds.left + rect.width / 2 - panel.offsetWidth / 2, bounds.width - panel.offsetWidth - 8))}px`;
    panel.style.top = `${Math.max(8, Math.min(rect.bottom - bounds.top + 8, bounds.height - panel.offsetHeight - 8))}px`;
  };
  panel.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); close(); } });
  host.append(panel); anchor.setAttribute('aria-expanded', 'true'); position();
  doc.addEventListener('pointerdown', outside, true); doc.defaultView?.addEventListener('resize', position); photos.focus();
  return close;
}
