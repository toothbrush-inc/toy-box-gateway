// Design lock: the rendered HTML for the fixture cards is checked in under
// test/__golden__/. A deliberate design change updates them (`vitest -u`); an
// accidental one fails here. The golden files are also the visual fixture set
// — open them in a browser.

import { describe, expect, it } from "vitest";

import { renderCardHtml, renderPreviewHtml, renderViewsIndexHtml } from "../src/views/render.js";
import { ALL_FIXTURES, weeklyFitness } from "./fixtures/cards.js";

describe("golden cards", () => {
  for (const fixture of ALL_FIXTURES) {
    if (fixture.snapshot === undefined) {
      continue;
    }
    it(`renders ${fixture.spec.id} byte-for-byte`, async () => {
      const html = renderCardHtml(fixture.spec, fixture.snapshot!);
      expect(html).toBe(renderCardHtml(fixture.spec, fixture.snapshot!));
      expect(html).not.toContain("<script");
      await expect(html).toMatchFileSnapshot(`./__golden__/${fixture.spec.id}.html`);
    });
  }

  it("renders a preview page byte-for-byte", async () => {
    const preview = {
      token: "golden-preview-token",
      spec: weeklyFitness.spec,
      snapshot: weeklyFitness.snapshot!,
      createdAt: "2026-08-21T15:42:07.000Z",
      expiresAt: "2026-08-21T15:52:07.000Z",
    };
    const html = renderPreviewHtml(preview);
    expect(html).toBe(renderPreviewHtml(preview));
    expect(html).not.toContain("<script");
    expect(html).toContain("card--preview");
    await expect(html).toMatchFileSnapshot("./__golden__/preview.html");
  });

  it("renders the index grid byte-for-byte", async () => {
    const html = renderViewsIndexHtml(ALL_FIXTURES);
    expect(html).toBe(renderViewsIndexHtml(ALL_FIXTURES));
    expect(html).not.toContain("<script");
    expect(html).toContain("5 pinned · 1 failing");
    expect(html).toContain('href="/views/weekly-fitness"');
    expect(html).toContain("Not run yet");
    await expect(html).toMatchFileSnapshot("./__golden__/index.html");
  });
});
