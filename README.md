# Inkstone for Obsidian

A Pencil-first notebook plugin inspired by familiar Goodnotes and Notability workflows. Version 0.3 adds on-page text boxes, favorites and outline navigation, bounded page movement, and pull-to-add pages. It also fixes OCR startup hangs and improves shape recognition for tilted ovals and uneven pen input.

## Install

Extract `release/inkstone-0.3.0.zip` and copy the complete `inkstone` folder into `<vault>/.obsidian/plugins/`. Enable **Inkstone** in Obsidian's community plugin settings. The installation must contain:

- `main.js`, `manifest.json`, and `styles.css`
- `assets/ocr/` and all files inside it (approximately 17 MB)

For iPad, sync or transfer this complete plugin folder into the iPad vault, including the hidden `.obsidian` configuration directory. No note contents are uploaded. The included English recognition worker, model, and WebAssembly engine run locally. Installation in an actual iPad Obsidian WebView still needs device validation.

To build, use Node.js 20 or later:

```sh
npm install
npm run build
npm test
```

The first build downloads a pinned, SHA-256-verified English model; subsequent builds reuse the verified local copy. `npm run demo` opens a standalone preview server at `http://127.0.0.1:5173`. Set `INKSTONE_PORT` to choose another port. `npm run dev` rebuilds the plugin on source changes. Build once before using OCR in development.

## Writing and editing

Create a notebook with the pencil ribbon action or **Inkstone: Create handwriting note**. Apple Pencil and mouse write by default; one finger moves the page and two fingers pinch to zoom. Enable finger drawing with the footer toggle when desired.

- **Pen / highlighter / eraser:** pressure-sensitive ink, translucent highlighting, whole-stroke erasure, colors, and sizes. Paper can be ruled, dotted, grid, or blank.
- **Lasso:** encircle entire ink strokes, then drag inside the selection to move them. Use Duplicate, Delete, or Deselect in the selection toolbar. Moves, duplication, and deletion are undoable. Lasso operates on ink, not the separate text fields.
- **Shape recognition:** choose the shape tool and draw a line, rectangle, triangle, or ellipse. Lines, rectangles, triangles, and tilted ovals become clean geometry on release; arbitrary marks remain ink. Ordinary pen input is never forced into shapes. Shapes can be moved or erased like other strokes.
- **Pages:** the header page button opens the sidebar. The **Page actions** menu inserts pages before or after the current page, duplicates pages, marks favorites and outline entries, and jumps to a page number. Use the sidebar filter for Favorites or Outline. Add, duplicate, rename, reorder, search, or delete pages. Deletion requires confirmation and cannot be undone. Each notebook supports up to 500 pages; ink undo history resets when switching pages.
- **Text tool:** select **T**, then tap or click the page to place a text box. Type with system spell-check, choose a font size, and drag its **Move** handle to reposition it. Arrow keys move a focused handle (Shift uses larger steps). Remove boxes with **Remove**; the toolbar Undo/Redo buttons restore text edits and removed boxes while the Text tool is selected. Text fields keep native keyboard undo. Text boxes save in the notebook, appear in search and thumbnails, and are included in SVG export.
- **Typed notes:** the header text button opens text fields attached to the current page. Your operating system provides real-time spelling checks in typed notes and editable transcripts, subject to its language and keyboard settings. This does not underline misspelled raw handwriting on the canvas.

Page movement stays within the paper edges. At the bottom, pull upward with one finger (or the Move tool with a mouse) until **Release to add a page** appears, then release. On an earlier page the same gesture advances to the next page. New pages inherit the current paper template. Reversing the drag, cancelling it, or adding a second finger cancels the action. Pencil drawing and wheel scrolling do not add pages.

Use toolbar undo/redo or ⌘Z / ⇧⌘Z (Ctrl on Windows/Linux) while the canvas is focused. Text fields retain their native text-editing undo behavior.

## Handwriting recognition and search

Open the text panel and choose **Recognize handwriting** to generate an editable transcript. Review and correct it. Failed or stalled engine startup now reports an error and allows another attempt. Recognition leaves original ink untouched and protects corrections or ink changes made while a job runs. Empty results keep an existing transcript. Transcripts are snapshots: rerun recognition after ink edits when needed.

Recognition uses Tesseract's English model, which works best on neat printed letters and has variable accuracy for handwriting, especially cursive. It is not Goodnotes' native handwriting recognition. Other languages require a future model-selection feature. Recognition is explicitly started by the user and runs in a single worker to keep expensive processing out of the writing event handler.

Run **Inkstone: Search handwritten and typed notes**, or use the search button, to search all Markdown notes plus Inkstone page titles, typed notes, and saved handwriting transcripts in the vault. Matching is case- and accent-insensitive, supports multiple words in any order and `"exact phrases"`, ranks title matches first, and opens the matching page. Results update as notes change. The sidebar also searches the current notebook.

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
