# Inkstone for Obsidian

A Pencil-first notebook plugin inspired by familiar Goodnotes and Notability workflows. Version 0.4 removes automatic vault-wide startup indexing, adds pixel/object erasers, follows Obsidian toolbar styling, and introduces optional AI Markdown and LaTeX conversion, a tool palette, and focus mode.

## Install

Extract `release/inkstone-0.4.0.zip` and copy the complete `inkstone` folder into `<vault>/.obsidian/plugins/`. Enable **Inkstone** in Obsidian's community plugin settings. The installation must contain:

- `main.js`, `manifest.json`, and `styles.css`
- `assets/ocr/` and all files inside it (approximately 17 MB)

For iPad, sync or transfer this complete plugin folder into the iPad vault, including the hidden `.obsidian` configuration directory. Local recognition never uploads note contents. Optional AI conversion sends only the page you explicitly submit to your configured provider. The included English recognition worker, model, and WebAssembly engine run locally. Installation in an actual iPad Obsidian WebView still needs device validation.

To build, use Node.js 20 or later:

```sh
npm install
npm run build
npm test
```

The first build downloads a pinned, SHA-256-verified English model; subsequent builds reuse the verified local copy. `npm run demo` opens a standalone preview server at `http://127.0.0.1:5173`. Set `INKSTONE_PORT` to choose another port. `npm run dev` rebuilds the plugin on source changes. Build once before using OCR in development.

## Writing and editing

Create a notebook with the pencil ribbon action or **Inkstone: Create handwriting note**. Apple Pencil and mouse write by default; one finger moves the page and two fingers pinch to zoom. Enable finger drawing from the top-right **Page actions (⋯)** menu when desired. Paper style, zoom, fit controls, stroke count, and page information also live there; there is no bottom toolbar.

- **Pen / highlighter / eraser:** pressure-sensitive ink, translucent highlighting, object (whole-stroke) or pixel (partial-stroke) erasure, colors, and sizes. Select the eraser to choose its mode; set the default in Inkstone settings. Pixel erasing splits vector strokes at the swept eraser boundary, preserving the remaining pressure-sensitive ink and undo/redo. Paper can be ruled, dotted, grid, or blank.
- **Lasso:** encircle entire ink strokes, then drag inside the selection to move them. Use Duplicate, Delete, or Deselect in the selection toolbar. Moves, duplication, and deletion are undoable. Lasso operates on ink, not the separate text fields.
- **Shape recognition:** choose the shape tool and draw a line, rectangle, triangle, or ellipse. Lines, rectangles, triangles, and tilted ovals become clean geometry on release; arbitrary marks remain ink. Ordinary pen input is never forced into shapes. Shapes can be moved or erased like other strokes.
- **Pages:** the header page button opens the sidebar. The **Page actions** menu inserts pages before or after the current page, duplicates pages, marks favorites and outline entries, and jumps to a page number. Use the sidebar filter for Favorites or Outline. Add, duplicate, rename, reorder, search, or delete pages. Deletion requires confirmation and cannot be undone. Each notebook supports up to 500 pages; ink undo history is retained per page while the notebook is open.
- **Text tool:** select **T**, then tap or click the page to place a text box. Type with system spell-check, choose a font size, and drag its **Move** handle to reposition it. Arrow keys move a focused handle (Shift uses larger steps). Remove boxes with **Remove**; the toolbar Undo/Redo buttons restore text edits and removed boxes while the Text tool is selected. Text fields keep native keyboard undo. Text boxes save in the notebook, appear in search and thumbnails, and are included in SVG export.
- **Typed notes:** the header text button opens text fields attached to the current page. Your operating system provides real-time spelling checks in typed notes and editable transcripts, subject to its language and keyboard settings. This does not underline misspelled raw handwriting on the canvas.

Page movement stays within the paper edges. At the bottom, pull upward with one finger (or the Move tool with a mouse) until **Release to add a page** appears, then release. Existing pages scroll continuously in either direction; only pulling beyond the final page adds a page. New pages inherit the current paper template. Reversing the drag, cancelling it, or adding a second finger cancels the action. Pencil drawing never adds pages. On Mac, scroll to the bottom, pause, then continue scrolling downward until the ring fills; stopping briefly commits the new page. A scroll that starts above the bottom cannot add a page through momentum. Reversing the pull, changing tools, or touching the page cancels it. The preview inherits the paper template and the current page lifts as you pull, with a static affordance when reduced motion is enabled.

Use toolbar undo/redo or ⌘Z / ⇧⌘Z (Ctrl on Windows/Linux) while the canvas is focused. Text fields retain their native text-editing undo behavior.

## Handwriting recognition and search

Open the text panel and choose **Recognize handwriting** to generate an editable transcript. Review and correct it. Failed or stalled engine startup now reports an error and allows another attempt. Recognition leaves original ink untouched and protects corrections or ink changes made while a job runs. Empty results keep an existing transcript. Real-time OCR refreshes the transcript after a pause in writing (1.8 seconds by default). You can disable it or adjust the delay in settings. Corrections made during recognition are preserved.

Recognition uses Tesseract's English model, which works best on neat printed letters and has variable accuracy for handwriting, especially cursive. It is not Goodnotes' native handwriting recognition. Other languages require a future model-selection feature. Recognition runs in a single worker after a writing pause, or when explicitly requested, keeping expensive processing out of the writing event handler. Hidden documents do not start automatic jobs, unchanged pages are not repeatedly processed, and the worker is released after idle time.

Run **Inkstone: Search handwritten and typed notes**, or use the search button, to search all Markdown notes plus Inkstone page titles, typed notes, and saved handwriting transcripts in the vault. Matching is case- and accent-insensitive, supports multiple words in any order and `"exact phrases"`, ranks title matches first, and opens the matching page. The vault index is built only when you first open vault search, so large vaults are not scanned at Obsidian startup. After that, updates are debounced as notes change; initial search results arrive progressively. The sidebar also searches the current notebook.

Search highlights matching snippets and recognized word positions on the page. Existing transcripts without word positions need another recognition pass for ink highlights. Highlights follow zoom and pan and are cleared when ink or transcripts change.

Raw ink becomes searchable after recognition or manual transcription. To process existing notebooks, run **Inkstone: Recognize handwriting in pages without transcripts**. Existing transcripts are skipped so manually corrected text is preserved. Unreadable notes are excluded from the index and reported in the search status. Search shows at most 100 results per query.

## Files and export

Notebook files use editable `.inkstone` JSON. Version 0.1 single-page files open without losing ink, pressure, timing, or paper settings; the next edit saves the version 2 page structure. Unsupported or corrupt files display an error without replacing their original contents. Keep backups; version 2 notebooks cannot be opened by plugin 0.1.

**Export** creates an SVG snapshot of the current page's ink, paper, and positioned text boxes, next to the notebook. Sidebar typed notes and transcripts remain in the notebook and are not included in the SVG. Existing exports are kept with numbered names. Embed a snapshot in Markdown with `![[Your note.svg]]`. Concurrent edits from multiple devices do not merge automatically.

## Validation and limits

The TypeScript build checks the installed Obsidian API. Automated tests cover schema migration, page validation, input/coalesced samples, palm precedence, lasso transactions and cancellation, conservative shape recognition, search matching and updates, and save/OCR isolation. Integration tests use Obsidian host doubles.

Chromium preview checks exercise page creation, duplication, reordering and deletion, editable text persistence, notebook search, native spellcheck attributes, local OCR of a vector block-letter HELLO fixture, lasso actions, and shape recognition. A synthetic OCR fixture establishes that the bundled worker and model run; it is not an accuracy benchmark for natural handwriting.

The repeatable browser fixture is available with `node scripts/serve-qa.mjs` at `http://127.0.0.1:5175`; it uses a synthetic HELLO ink page and never reads or writes preview storage. Automated regressions also cover OCR failure/retry, rotated ovals, bounded movement, page-pull cancellation, text box validation/search, and text drag transactions.

Physical iPad validation remains required: test fast and slow Pencil strokes, palm contacts, pinch/zoom followed by writing, pane resize/rotation, OCR worker startup, system spelling corrections, long notebooks, vault search navigation, background/resume, and note switching with pending saves. Obsidian's WebView cannot promise PencilKit latency, hardware palm rejection equivalence, 120 Hz rendering, or native Pencil squeeze/double-tap behavior.

PDF annotation, audio recording, handwriting spellcheck directly on ink, and Goodnotes/Notability file import are not implemented. Inkstone is independent and uses neither app's assets nor proprietary file formats.

## Version 0.4: workspace and Pencil actions

Chrome inherits Obsidian background/text/accent colors, interface font, icon size, and input height. Inkstone settings offer Follow Obsidian, Compact, and Comfortable toolbar sizes. Touch controls keep a 44px minimum. A single fixed top toolbar contains the tools, and a floating contextual palette contains color/width or eraser mode/diameter. Narrow panes scroll the tools horizontally. The eraser cursor shows its actual diameter at the current zoom. Page thumbnails start closed and are not built while hidden.

Choose **Page actions → Focus writing**, or press Tab while the canvas is focused, to hide panels and toolbars. Escape or **Exit focus** restores them. Tool shortcuts: P pen, H highlighter, E eraser, L lasso, S shapes, V move, T text. They do not intercept typing in text fields.

**Apple Pencil:** settings map double-tap and squeeze to current tool/eraser, previous tool, a floating tool palette, undo, or no action. Commands **Run Pencil double-tap action** and **Run Pencil squeeze action** execute those mappings and can be assigned Obsidian hotkeys. These are command fallbacks, not physical gesture detection. Obsidian's public plugin API does not expose native `UIPencilInteraction` or the iPad system Pencil preferences. Native squeeze/double-tap delivery and following system preferences require an Obsidian host bridge; a web event or a canvas double-click cannot substitute for those hardware gestures. See [Apple's native Pencil interaction API](https://developer.apple.com/documentation/uikit/uipencilinteraction).

## Markdown and optional AI math conversion

**Page actions → Export notebook as Markdown** writes all pages' typed notes, positioned text, and existing transcripts into a new Markdown file next to the notebook. Markdown/LaTeX already in these fields is preserved. This offline export does not transcribe raw ink or infer math.

For handwritten formulas, configure a vision-capable provider in **Settings → Inkstone → AI Markdown and math**: the full Chat Completions endpoint, model ID, optional API key, and an optional custom conversion prompt. The provider must support image input in the [Chat Completions vision format](https://developers.openai.com/api/docs/guides/images-vision). HTTPS endpoints and local HTTP providers are supported. Keys are stored in the plugin's `data.json`, which vault sync may copy. No provider is enabled by default.

Choose **Page actions → Convert page to Markdown with AI…**. The dialog identifies the destination before **Convert page** submits one page image (ink and positioned text). The draft uses `$...$` and `$$` LaTeX for Obsidian math. Edit and review it before **Save Markdown note** creates a separate file; original ink and transcripts are untouched. Provider charges may apply. Closing the dialog discards late results but cannot cancel processing already accepted by the provider. Local Tesseract remains suitable for printed English text, not mathematical formula recognition.

Automated regressions cover partial eraser geometry, sweep gaps, pressure/time preservation, eraser undo/redo, inactive startup indexing, coalesced index events, Markdown/LaTeX preservation, malformed AI output, and settings migration. Provider accuracy, real macOS energy consumption, and physical iPad Pencil gestures still require device/provider validation; no paid AI calls are made by the test suite.
