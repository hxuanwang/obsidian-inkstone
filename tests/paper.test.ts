import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PAPER_TYPES, PAGE_HEIGHT, PAGE_WIDTH, PAGE_SIZES, pageDimensions } from '../src/model';
import { PAPER_TEMPLATES, paperLayout, paperSvg } from '../src/paper';

test('every offered template has bounded geometry and exports its guides', () => {
  assert.deepEqual(PAPER_TEMPLATES.map(template => template.value), [...PAPER_TYPES]);
  for (const paper of PAPER_TYPES) {
    const layout = paperLayout(paper);
    assert.ok(paperSvg(paper).includes('fill="#faf9ef"'));
    for (const [x, y, x2, y2] of layout.lines) {
      for (const value of [x, y, x2, y2]) assert.ok(Number.isFinite(value));
      assert.ok(x >= 0 && x <= PAGE_WIDTH && x2 >= 0 && x2 <= PAGE_WIDTH, paper);
      assert.ok(y >= 0 && y <= PAGE_HEIGHT && y2 >= 0 && y2 <= PAGE_HEIGHT, paper);
    }
    if (paper !== 'blank') assert.ok(layout.lines.length + layout.dots.length > 0, paper);
    for (const label of layout.labels) assert.ok(paperSvg(paper).includes(label.text));
  }
});

test('specialized templates provide Cornell regions, five-line staves, and all seven planner days', () => {
  assert.deepEqual(paperLayout('cornell').labels.map(label => label.text), ['TOPIC / DATE', 'CUES', 'NOTES', 'SUMMARY']);
  const staff = paperLayout('music').lines.filter(([x, , x2]) => x !== x2);
  assert.equal(staff.length % 5, 0);
  assert.deepEqual(staff.slice(0, 5).map(line => line[1]), [160, 178, 196, 214, 232]);
  assert.equal(paperLayout('planner').labels.length, 9);
  assert.ok(paperLayout('isometric').lines.some(([x,y,x2,y2]) => x !== x2 && y !== y2));
});

test('paper guides and export colors follow every size while grid spacing stays square', () => {
  for (const size of PAGE_SIZES) for (const orientation of ['portrait', 'landscape'] as const) {
    const format = { pageSize: size.value, orientation, paperColor: '#e8f0ff' }, { width, height } = pageDimensions(format);
    for (const paper of PAPER_TYPES) {
      const layout = paperLayout(paper, format);
      for (const [x, y, x2, y2] of layout.lines) {
        assert.ok(x >= 0 && x <= width && x2 >= 0 && x2 <= width);
        assert.ok(y >= 0 && y <= height && y2 >= 0 && y2 <= height);
      }
      for (const [x, y] of layout.dots) assert.ok(x >= 0 && x <= width && y >= 0 && y <= height);
      for (const label of layout.labels) assert.ok(label.x >= 0 && label.x <= width && label.y >= 0 && label.y <= height);
      assert.ok(paperSvg(paper, format).includes(`<rect width="${width}" height="${height}" fill="#e8f0ff"/>`));
    }
    const grid = paperLayout('grid', format).lines;
    assert.deepEqual(grid.filter(([x, , x2]) => x === x2).slice(0, 2).map(line => line[0]), [40, 80]);
    assert.deepEqual(grid.filter(([, y, , y2]) => y === y2).slice(0, 2).map(line => line[1]), [40, 80]);
    for (const [x, y, x2, y2] of paperLayout('isometric', format).lines) {
      if (Math.abs(x2 - x) > 1) assert.ok(Math.abs(Math.abs((y2 - y) / (x2 - x)) - Math.sqrt(3)) < 1e-8);
    }
  }
});
