# Inkstone for Obsidian

A Pencil-first notebook plugin inspired by familiar Goodnotes and Notability workflows. Version 0.5 adds smoother variable-width ink, Photos/camera insertion choices, rectangle selection and a floating selection menu. Version 0.4 removes automatic vault-wide startup indexing, adds pixel/object erasers, follows Obsidian toolbar styling, and introduces optional AI Markdown and LaTeX conversion, a tool palette, and focus mode.

## Install

Extract `release/inkstone-0.5.0.zip` and copy the complete `inkstone` folder into `<vault>/.obsidian/plugins/`. Enable **Inkstone** in Obsidian's community plugin settings. The installation must contain:

- `main.js`, `manifest.json`, and `styles.css`
- `assets/ocr/` and all files inside it (approximately 17 MB)

For iPad, sync or transfer this complete plugin folder into the iPad vault, including the hidden `.obsidian` configuration directory. Local recognition never uploads note contents. Optional external OCR and AI conversion send only the page you explicitly submit to your configured provider. The included English recognition worker, model, and WebAssembly engine run locally. Installation in an actual iPad Obsidian WebView still needs device validation.

To build, use Node.js 20 or later:

```sh
npm install
npm run build
npm test
```

The first build downloads a pinned, SHA-256-verified English model; subsequent builds reuse the verified local copy. `npm run demo` opens a standalone preview server at `http://127.0.0.1:5173`. Set `INKSTONE_PORT` to choose another port. `npm run dev` rebuilds the plugin on source changes. Build once before using OCR in development.

## Writing and editing

Create a notebook with the pencil ribbon action or **Inkstone: Create handwriting note**. Right-click a folder in Obsidian’s file explorer and choose **New writing** to create and open a notebook inside that folder. Writing, typed text, and page edits save automatically; pending edits are flushed when you switch or close the note. Apple Pencil and mouse write by default; one finger moves the page and two fingers pinch to zoom. Enable finger drawing from the top-right **Page actions (⋯)** menu when desired. Paper style, zoom, fit controls, stroke count, and page information also live there; there is no bottom toolbar.

- **Pen / highlighter / eraser:** pressure-sensitive ink, translucent highlighting, object (whole-stroke) or pixel (partial-stroke) erasure, colors, and sizes. Pencil pressure spans 18–100% of the chosen pen width, with light stabilization for dense input and an exact lift position. Saved strokes, SVG export, and erasing share the same geometry. The expanded pressure response also applies when existing strokes are redrawn. Select the eraser to choose its mode; set the default in Inkstone settings. Pixel erasing splits vector strokes at the swept eraser boundary, preserving the remaining pressure-sensitive ink and undo/redo. Paper can be ruled, dotted, grid, blank, Cornell, music, isometric, or weekly planner.
- **Lasso:** encircle entire ink strokes, then drag inside the selection to move them. Drag a corner to resize, or use the shrink/enlarge buttons. Change selected ink with Ink color; Duplicate, Delete, and Deselect are also available. These edits are undoable. Lasso includes inserted images; text boxes keep their own controls.
- **Insert image:** choose a PNG, JPEG, GIF, or WebP file up to 10 MB. Images are embedded in the notebook and included in thumbnails and SVG exports. Circle the image with Lasso to move, resize, duplicate, or delete it.
- **Shape tool:** choose Rectangle, Ellipse, Line, or Arrow and drag to draw precisely. For freehand recognition, choose Recognize shape and draw a line, rectangle, triangle, or ellipse. Lines, rectangles, triangles, and tilted ovals become clean geometry on release; arbitrary marks remain ink. Ordinary pen input is never forced into shapes. Shapes can be moved or erased like other strokes.
- **Pages:** the header page button opens the sidebar. Each thumbnail has its own **⋯** menu; right-click a thumbnail for the same actions. Rename, insert before or after, duplicate, reorder, mark favorites or outline entries, and delete that page. The dotted **+** tile appends a page with the last page's paper settings. Use sidebar filters for Favorites or Outline and the header **Page actions** menu to jump to a page number. Deletion requires confirmation and cannot be undone. Each notebook supports up to 500 pages; ink undo history is retained per page while the notebook is open.
- **Paper templates:** open a page's menu to preview eight templates, paper colors, Standard/A4/US Letter sizes, and portrait or landscape orientation. **Apply** commits the choices; Cancel leaves the page unchanged. Resizing fits ink, images, and text to the new page. Undo restores the format and preserves later text edits.
- **Text tool:** select **T**, then tap or click the page to place a text box. Type with system spell-check, choose a font size, and drag its **Move** handle to reposition it. Arrow keys move a focused handle (Shift uses larger steps). Remove boxes with **Remove**; the toolbar Undo/Redo buttons restore text edits and removed boxes while the Text tool is selected. Text fields keep native keyboard undo. Text boxes save in the notebook, appear in search and thumbnails, and are included in SVG export.
- **Typed notes:** the header text button opens text fields attached to the current page. Your operating system provides real-time spelling checks in typed notes and editable transcripts, subject to its language and keyboard settings. After OCR, red wavy underlines flag possible English spelling mistakes beneath recognized handwriting. Typed on-page text is checked after a short typing pause. The bundled offline English dictionary handles inflections and contractions; names, specialist terms, and OCR misreadings can still be flagged. Red underlines indicate dictionary spelling findings, not low OCR confidence. Turn them off with Real-time spell-check in settings.

Page movement stays within the paper edges. At the bottom, pull upward with one finger (or the Move tool with a mouse) until **Release to add a page** appears, then release. Existing pages scroll continuously in either direction; only pulling beyond the final page adds a page. New pages inherit the current paper template. Reversing the drag, cancelling it, or adding a second finger cancels the action. Pencil drawing never adds pages. On Mac, scroll to the bottom, pause, then continue scrolling downward until the ring fills; stopping briefly commits the new page. A scroll that starts above the bottom cannot add a page through momentum. Reversing the pull, changing tools, or touching the page cancels it. The preview inherits the paper template and the current page lifts as you pull, with a static affordance when reduced motion is enabled.

Use toolbar undo/redo or ⌘Z / ⇧⌘Z (Ctrl on Windows/Linux) while the canvas is focused. Text fields retain their native text-editing undo behavior.

## Handwriting recognition and search

Open the text panel and choose **Recognize locally** to generate an editable transcript. Review and correct it. Failed or stalled engine startup now reports an error and allows another attempt. Recognition leaves original ink untouched and protects corrections or ink changes made while a job runs. Empty results keep an existing transcript. Real-time OCR refreshes the transcript after a pause in writing (1.8 seconds by default). You can disable it or adjust the delay in settings. Corrections made during recognition are preserved.

Local recognition uses Tesseract's English model, which works best on neat printed letters and has variable accuracy for handwriting, especially cursive. Ink is rerendered at up to twice its page resolution, with white margins and a six-million-pixel cap. Weak results receive one alternate paragraph-layout pass; the higher-confidence result is retained. No dictionary autocorrection rewrites the transcript. It is not Goodnotes' native handwriting recognition. For cursive, other languages, or formulas, choose the external vision option below. Recognition runs in a single worker after a writing pause, or when explicitly requested, keeping expensive processing out of the writing event handler. Hidden documents do not start automatic jobs, unchanged pages are not repeatedly processed, and the worker is released after idle time.

For more capable handwriting recognition, configure a vision model in **Settings → Inkstone → External OCR and AI conversion**, then choose **Recognize with external AI** in the text panel. This explicitly sends a cropped image of pen ink to the configured provider; highlighters, images, and paper guides are omitted. The raster retains up to 2× detail within a six-million-pixel cap, and identical concurrent requests share one upload. Background recognition remains local. The external transcript preserves the original language and represents equations as LaTeX in Markdown. Review the result: model accuracy varies, and this release has no natural-handwriting accuracy benchmark. External OCR supplies searchable text but no word-position boxes for on-page spelling or search highlights.

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

PDF annotation, audio recording, and Goodnotes/Notability file import are not implemented. Inkstone is independent and uses neither app's assets nor proprietary file formats.

## Version 0.4: workspace and Pencil actions

Chrome inherits Obsidian background/text/accent colors, interface font, icon size, and input height. Inkstone settings offer Follow Obsidian, Compact, and Comfortable toolbar sizes. Touch controls keep a 44px minimum. A single fixed top toolbar contains the tools, and a floating contextual palette contains color/width or eraser mode/diameter. Narrow panes scroll the tools horizontally. The eraser cursor shows its actual diameter at the current zoom. Page thumbnails start closed and are not built while hidden.

Choose **Page actions → Focus writing**, or press Tab while the canvas is focused, to hide panels and toolbars. Escape or **Exit focus** restores them. Tool shortcuts: P pen, H highlighter, E eraser, L lasso, S shapes, V move, T text. They do not intercept typing in text fields.

**Apple Pencil:** direct hardware double-tap and squeeze are unavailable in Obsidian's public plugin API. The double-tap mapping applies only to **Run Pencil double-tap action**, and changing it does not enable physical double-tap. Native support requires Obsidian to forward [Apple's `UIPencilInteraction` callbacks](https://developer.apple.com/documentation/uikit/uipencilinteraction). Use **Switch writing tool / eraser**, **Switch to previous tool**, and **Toggle tool palette** from the command palette or assign keyboard hotkeys as immediate alternatives.

**Apple Pencil Pro squeeze via iPad Shortcuts:** Apple supports [running a Shortcut as the system squeeze action](https://developer.apple.com/documentation/applepencil/handling-squeezes-from-apple-pencil). Inkstone provides an Obsidian URL handler for this route:

1. Copy **Squeeze Shortcut URL** from Inkstone settings. It includes your vault name and looks like `obsidian://inkstone-pencil?vault=My%20vault&gesture=squeeze`.
2. In iPad Shortcuts, create a shortcut with a **URL** action containing that address, followed by **Open URLs**.
3. In iPad Settings → Apple Pencil → Squeeze → Run Shortcut, select that shortcut.
4. Keep that vault and an Inkstone writing page open. Squeezing runs the **Squeeze shortcut action** selected in Inkstone settings (tool palette by default).

This is a system Shortcut workaround, not native gesture detection; it may briefly switch apps and needs validation on a physical iPad. Running the shortcut without an active writing page shows a notice. It does not open or edit another note automatically. The handler rejects other gestures and mismatched vaults. The **Run Pencil squeeze action** command also executes the same mapping without Shortcuts. See [Obsidian's public URI handler API](https://docs.obsidian.md/Reference/TypeScript+API/Plugin/registerObsidianProtocolHandler).

## Markdown, LaTeX, and optional AI conversion

**Page actions → Export notebook as Markdown** writes all pages' typed notes, positioned text, and existing transcripts into a new Markdown file next to the notebook. Markdown/LaTeX already in these fields is preserved. This offline export does not transcribe raw ink or infer math.

For handwritten formulas, configure a vision-capable provider in **Settings → Inkstone → External OCR and AI conversion**: the full Chat Completions endpoint, model ID, optional API key, and an optional custom conversion prompt. **Fetch models** discovers IDs from the provider’s `/models` endpoint; select a vision model from the list or enter its ID manually. **Test connection** sends a built-in sample image and checks for a compatible text response; it sends no notebook content and may incur a small provider charge. Model lists can include text-only models. The provider must support image input in the [Chat Completions vision format](https://developers.openai.com/api/docs/guides/images-vision). HTTPS endpoints and local HTTP providers are supported. Checks ignore late responses after you change the configuration or close settings; processing already accepted by the provider may continue. Keys are stored in the plugin's `data.json`, which vault sync may copy. No provider is enabled by default.

Choose **Page actions → Convert page to Markdown or LaTeX with AI…** and select **Markdown (Obsidian math)** or **LaTeX document (.tex)**. The dialog identifies the destination before **Convert page** submits one page image (ink and positioned text). Markdown uses `$...$` and `$$` math; LaTeX requests a standalone document with a preamble and document environment. Review and edit the draft before saving a separate `.md` or `.tex` file next to the notebook. Original ink and transcripts are untouched. LaTeX output is source, not a compiled PDF; verify it with your TeX toolchain, especially language fonts and packages. Provider charges may apply. Closing the dialog discards late results but cannot cancel processing already accepted by the provider. Local Tesseract remains suitable for printed English text and is not designed for mathematical formula recognition.

Automated regressions cover partial eraser geometry, sweep gaps, pressure/time preservation, eraser undo/redo, inactive startup indexing, coalesced index events, Markdown/LaTeX preservation, malformed AI output, and settings migration. Provider accuracy, real macOS energy consumption, and physical iPad Pencil gestures still require device/provider validation; no paid AI calls are made by the test suite.

## Version 0.5 selection

Choose the selection tool, then **Rectangle selection** or **Freehand lasso**. Drag around ink and images; move the selection or resize it with its corner handles. The floating menu offers preset/custom ink colors, cut, duplicate, delete, and More actions (copy, paste, resize, deselect). Copy/paste stays within this editor session; text boxes use the Text tool.
