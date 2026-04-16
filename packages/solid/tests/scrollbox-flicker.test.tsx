import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { testRender } from "../index.js";
import { createSignal, For } from "solid-js";
import type { ScrollBoxRenderable } from "../../core/src/renderables/index.js";
import { TestRecorder } from "../../core/src/testing/test-recorder.js";

let testSetup: Awaited<ReturnType<typeof testRender>>;

/**
 * Flicker reproduction tests.
 *
 * These tests verify that content rendered inside a sticky-scroll scrollbox does
 * not briefly disappear (flicker) when new items are appended or when existing
 * items change height (as happens when an assistant message is finalized or a
 * diff/tool output lands).
 *
 * The suspected root cause is that `ContentRenderable._getVisibleChildren()`
 * (viewport culling) reads each child's cached `screenY` before the children's
 * own `updateFromLayout()` has been called for the current frame. When a new
 * child is inserted at an earlier position, or an earlier child grows in
 * height, the already-present later children shift down in yoga's computed
 * layout, but their `_screenY` value still reflects the previous frame. The
 * binary search + culling logic then sees them outside the viewport and culls
 * them, producing a one-frame gap where the content is blank.
 */

describe("ScrollBox flicker reproduction", () => {
  beforeEach(async () => {
    if (testSetup) {
      testSetup.renderer.destroy();
    }
  });

  afterEach(() => {
    if (testSetup) {
      testSetup.renderer.destroy();
    }
  });

  // Helper: extract non-whitespace character count from a frame.
  const nonWhitespaceCount = (frame: string) => frame.replace(/\s/g, "").length;

  // Helper: find runs of messages in a frame that are expected to be visible
  const countMessageLines = (frame: string, pattern: RegExp) => {
    return frame.split("\n").filter((line) => pattern.test(line)).length;
  };

  it("confirms viewportCulling=false prevents the flicker (root-cause diagnostic)", async () => {
    // Same scenario as the primary flicker test, but with viewportCulling
    // disabled. If this passes while the viewportCulling=true variant fails,
    // we have isolated the bug to viewport-culling using stale screenY.
    const INITIAL_ITEMS = 30;
    const [firstHeight, setFirstHeight] = createSignal(1);
    const items = Array.from({ length: INITIAL_ITEMS }, (_, i) => `Row ${i}`);

    let scrollRef: ScrollBoxRenderable | undefined;

    testSetup = await testRender(
      () => (
        <box flexDirection="column">
          <scrollbox
            ref={(r) => (scrollRef = r)}
            stickyScroll={true}
            stickyStart="bottom"
            flexGrow={1}
            viewportCulling={false}
          >
            <box id="first" flexShrink={0} height={firstHeight()}>
              <text>FIRST</text>
            </box>
            <For each={items}>
              {(row) => (
                <box flexShrink={0} marginTop={1}>
                  <text>{row}</text>
                </box>
              )}
            </For>
          </scrollbox>
        </box>
      ),
      {
        width: 40,
        height: 20,
      },
    );

    await testSetup.renderOnce();
    if (scrollRef) {
      scrollRef.scrollTo(scrollRef.scrollHeight);
      await testSetup.renderOnce();
    }

    const baselineFrame = testSetup.captureCharFrame();
    const baselineRows = (baselineFrame.match(/Row \d+/g) ?? []).length;
    expect(baselineRows).toBeGreaterThan(0);

    const recorder = new TestRecorder(testSetup.renderer);
    recorder.rec();
    setFirstHeight(10);
    for (let i = 0; i < 4; i++) {
      await testSetup.renderOnce();
    }
    recorder.stop();

    const frames = recorder.recordedFrames;
    const rowCounts = frames.map((f) => (f.frame.match(/Row \d+/g) ?? []).length);
    const settledRows = rowCounts[rowCounts.length - 1];
    const flickerFrames = frames.filter((f, i) => {
      const rows = rowCounts[i];
      return rows < baselineRows && rows < settledRows;
    });
    expect(flickerFrames).toEqual([]);
  });

  it("does not briefly drop rows when a sibling above grows in height (scrollbox viewport culling flicker)", async () => {
    // Tight, assertion-based version of the diagnostic test. Keeps the
    // assertions minimal and focused on the actual bug symptom: one frame
    // with fewer rows than baseline.
    const INITIAL_ITEMS = 30;
    const [firstHeight, setFirstHeight] = createSignal(1);
    const items = Array.from({ length: INITIAL_ITEMS }, (_, i) => `Row ${i}`);

    let scrollRef: ScrollBoxRenderable | undefined;

    testSetup = await testRender(
      () => (
        <box flexDirection="column">
          <scrollbox ref={(r) => (scrollRef = r)} stickyScroll={true} stickyStart="bottom" flexGrow={1}>
            <box id="first" flexShrink={0} height={firstHeight()}>
              <text>FIRST</text>
            </box>
            <For each={items}>
              {(row) => (
                <box flexShrink={0} marginTop={1}>
                  <text>{row}</text>
                </box>
              )}
            </For>
          </scrollbox>
        </box>
      ),
      {
        width: 40,
        height: 20,
      },
    );

    await testSetup.renderOnce();
    if (scrollRef) {
      scrollRef.scrollTo(scrollRef.scrollHeight);
      await testSetup.renderOnce();
    }

    const baselineFrame = testSetup.captureCharFrame();
    const baselineRows = (baselineFrame.match(/Row \d+/g) ?? []).length;
    expect(baselineRows).toBeGreaterThan(0);

    const recorder = new TestRecorder(testSetup.renderer);
    recorder.rec();

    setFirstHeight(10);

    for (let i = 0; i < 4; i++) {
      await testSetup.renderOnce();
    }

    recorder.stop();

    const frames = recorder.recordedFrames;
    const rowCounts = frames.map((f) => (f.frame.match(/Row \d+/g) ?? []).length);

    // The flicker symptom: one or more intermediate frames show strictly
    // fewer rows than the baseline and than the settled state. That means
    // rows briefly disappeared.
    const settledRows = rowCounts[rowCounts.length - 1];
    const flickerFrames = frames.filter((f, i) => {
      const rows = rowCounts[i];
      return rows < baselineRows && rows < settledRows;
    });

    if (flickerFrames.length > 0) {
      console.log(`FLICKER: baseline=${baselineRows}, settled=${settledRows}, per-frame rows=`, rowCounts);
      console.log("first flicker frame:\n" + flickerFrames[0].frame);
    }

    expect(flickerFrames).toEqual([]);
  });

  it("does not briefly drop rows when an earlier message grows (diff finalized in middle of scrollbox)", async () => {
    // Variation: the first item is not the one that grows; a middle item
    // does. This matches the "diff lands in middle of conversation" scenario.
    const INITIAL_ITEMS = 30;
    const [middleHeight, setMiddleHeight] = createSignal(1);
    const items = Array.from({ length: INITIAL_ITEMS }, (_, i) => `Row ${i}`);
    const middleIndex = Math.floor(INITIAL_ITEMS / 2);

    let scrollRef: ScrollBoxRenderable | undefined;

    testSetup = await testRender(
      () => (
        <box flexDirection="column">
          <scrollbox ref={(r) => (scrollRef = r)} stickyScroll={true} stickyStart="bottom" flexGrow={1}>
            <For each={items}>
              {(row, index) => (
                <box flexShrink={0} marginTop={1} height={index() === middleIndex ? middleHeight() : undefined}>
                  <text>{row}</text>
                </box>
              )}
            </For>
          </scrollbox>
        </box>
      ),
      {
        width: 40,
        height: 20,
      },
    );

    await testSetup.renderOnce();
    if (scrollRef) {
      scrollRef.scrollTo(scrollRef.scrollHeight);
      await testSetup.renderOnce();
    }

    const baselineFrame = testSetup.captureCharFrame();
    const baselineRows = (baselineFrame.match(/Row \d+/g) ?? []).length;
    expect(baselineRows).toBeGreaterThan(0);

    const recorder = new TestRecorder(testSetup.renderer);
    recorder.rec();

    setMiddleHeight(12);

    for (let i = 0; i < 4; i++) {
      await testSetup.renderOnce();
    }

    recorder.stop();

    const frames = recorder.recordedFrames;
    const rowCounts = frames.map((f) => (f.frame.match(/Row \d+/g) ?? []).length);
    const settledRows = rowCounts[rowCounts.length - 1];
    const flickerFrames = frames.filter((f, i) => {
      const rows = rowCounts[i];
      return rows < baselineRows && rows < settledRows;
    });

    if (flickerFrames.length > 0) {
      console.log(`FLICKER (middle): baseline=${baselineRows}, settled=${settledRows}, per-frame rows=`, rowCounts);
      console.log("first flicker frame:\n" + flickerFrames[0].frame);
    }

    expect(flickerFrames).toEqual([]);
  });

  it("does not drop visible content for a single frame when a new message is appended", async () => {
    // Enough items to exceed the culling `minTriggerSize` (16) and force the
    // binary-search path in `getObjectsInViewport`.
    const INITIAL_ITEMS = 40;
    const [items, setItems] = createSignal<string[]>(Array.from({ length: INITIAL_ITEMS }, (_, i) => `Message ${i}`));

    let scrollRef: ScrollBoxRenderable | undefined;

    testSetup = await testRender(
      () => (
        <box flexDirection="column">
          <scrollbox ref={(r) => (scrollRef = r)} stickyScroll={true} stickyStart="bottom" flexGrow={1}>
            <For each={items()}>
              {(msg) => (
                <box flexShrink={0} marginTop={1}>
                  <text>{msg}</text>
                </box>
              )}
            </For>
          </scrollbox>
        </box>
      ),
      {
        width: 40,
        height: 20,
      },
    );

    await testSetup.renderOnce();
    if (scrollRef) {
      scrollRef.scrollTo(scrollRef.scrollHeight);
      await testSetup.renderOnce();
    }

    const baselineFrame = testSetup.captureCharFrame();
    const baselineVisible = countMessageLines(baselineFrame, /Message \d+/);
    expect(baselineVisible).toBeGreaterThan(0);
    const baselineNonWhite = nonWhitespaceCount(baselineFrame);

    const recorder = new TestRecorder(testSetup.renderer);
    recorder.rec();

    // Simulate a user prompt "finalize": append a new message.
    setItems((prev) => [...prev, `Message ${prev.length}`]);

    // Give the renderer a chance to run several render passes, the way the
    // real app would between message finalize and the next interactive
    // interaction. We do not call scrollTo manually -- sticky scroll should
    // keep us pinned to bottom.
    for (let i = 0; i < 4; i++) {
      await testSetup.renderOnce();
    }

    recorder.stop();

    // Every frame captured between the signal change and the settled state
    // should contain *some* visible message content. If any frame is nearly
    // blank (significantly fewer non-whitespace chars than baseline), that is
    // a flicker.
    const frames = recorder.recordedFrames;
    expect(frames.length).toBeGreaterThan(0);

    const flickerThreshold = Math.floor(baselineNonWhite / 2);
    const blankFrames = frames.filter((f) => nonWhitespaceCount(f.frame) < flickerThreshold);

    if (blankFrames.length > 0) {
      const report = blankFrames
        .map(
          (f) =>
            `frame ${f.frameNumber} (t=${f.timestamp.toFixed(1)}ms) nonWhite=${nonWhitespaceCount(
              f.frame,
            )} (baseline=${baselineNonWhite})`,
        )
        .join("\n");
      console.log("FLICKER FRAMES DETECTED:\n" + report);
      console.log("first blank frame content:\n" + blankFrames[0].frame);
    }

    expect(blankFrames).toEqual([]);
  });

  it("does not drop visible content when an existing item grows in height", async () => {
    // Simulates the "diff/tool output finalize" scenario: a message that was
    // previously 1 line tall suddenly becomes many lines tall (e.g. a diff
    // lands, or a tool's output expands). The subsequent messages shift down
    // in a single layout pass.
    const INITIAL_ITEMS = 30;
    const [content, setContent] = createSignal<string[]>(Array.from({ length: INITIAL_ITEMS }, (_, i) => `Item ${i}`));

    let scrollRef: ScrollBoxRenderable | undefined;

    testSetup = await testRender(
      () => (
        <box flexDirection="column">
          <scrollbox ref={(r) => (scrollRef = r)} stickyScroll={true} stickyStart="bottom" flexGrow={1}>
            <For each={content()}>
              {(text) => (
                <box flexShrink={0} marginTop={1}>
                  <text>{text}</text>
                </box>
              )}
            </For>
          </scrollbox>
        </box>
      ),
      {
        width: 40,
        height: 20,
      },
    );

    await testSetup.renderOnce();
    if (scrollRef) {
      scrollRef.scrollTo(scrollRef.scrollHeight);
      await testSetup.renderOnce();
    }

    const baselineFrame = testSetup.captureCharFrame();
    const baselineNonWhite = nonWhitespaceCount(baselineFrame);
    expect(baselineNonWhite).toBeGreaterThan(0);

    const recorder = new TestRecorder(testSetup.renderer);
    recorder.rec();

    // Replace item near the middle with a much taller multi-line content.
    // This changes the height of an existing entry and forces all subsequent
    // entries' screenY to update.
    setContent((prev) => {
      const next = [...prev];
      const targetIdx = Math.floor(next.length / 2);
      next[targetIdx] = Array.from({ length: 8 }, (_, i) => `Grown line ${i}`).join("\n");
      return next;
    });

    for (let i = 0; i < 4; i++) {
      await testSetup.renderOnce();
    }

    recorder.stop();

    const frames = recorder.recordedFrames;
    expect(frames.length).toBeGreaterThan(0);

    const flickerThreshold = Math.floor(baselineNonWhite / 2);
    const blankFrames = frames.filter((f) => nonWhitespaceCount(f.frame) < flickerThreshold);

    if (blankFrames.length > 0) {
      const report = blankFrames
        .map(
          (f) =>
            `frame ${f.frameNumber} (t=${f.timestamp.toFixed(1)}ms) nonWhite=${nonWhitespaceCount(
              f.frame,
            )} (baseline=${baselineNonWhite})`,
        )
        .join("\n");
      console.log("FLICKER FRAMES DETECTED:\n" + report);
      console.log("first blank frame content:\n" + blankFrames[0].frame);
    }

    expect(blankFrames).toEqual([]);
  });

  it("does not cull visible items based on stale screenY after layout shift", async () => {
    // This is a more targeted test focusing on the exact suspected bug:
    // viewport culling reads stale screenY values after a layout shift.
    //
    // We put enough items in the scrollbox to cross the 16-item threshold
    // that enables the binary search culling path, then change the first
    // item's height so every subsequent item's screenY shifts.
    const INITIAL_ITEMS = 30;
    const [firstHeight, setFirstHeight] = createSignal(1);
    const items = Array.from({ length: INITIAL_ITEMS }, (_, i) => `Row ${i}`);

    let scrollRef: ScrollBoxRenderable | undefined;

    testSetup = await testRender(
      () => (
        <box flexDirection="column">
          <scrollbox ref={(r) => (scrollRef = r)} stickyScroll={true} stickyStart="bottom" flexGrow={1}>
            <box id="first" flexShrink={0} height={firstHeight()}>
              <text>FIRST</text>
            </box>
            <For each={items}>
              {(row) => (
                <box flexShrink={0} marginTop={1}>
                  <text>{row}</text>
                </box>
              )}
            </For>
          </scrollbox>
        </box>
      ),
      {
        width: 40,
        height: 20,
      },
    );

    await testSetup.renderOnce();
    if (scrollRef) {
      scrollRef.scrollTo(scrollRef.scrollHeight);
      await testSetup.renderOnce();
    }

    const baselineFrame = testSetup.captureCharFrame();
    const baselineNonWhite = nonWhitespaceCount(baselineFrame);

    const recorder = new TestRecorder(testSetup.renderer);
    recorder.rec();

    // Grow the first item. Every subsequent item's yoga-computed y shifts
    // down, but their cached _screenY is still from the previous frame at
    // the point where `_getVisibleChildren()` runs on the content container.
    setFirstHeight(10);

    // Single render pass - this is the critical moment where the bug would
    // manifest (frame N-to-N+1 transition).
    await testSetup.renderOnce();

    // Let things settle for further comparison.
    for (let i = 0; i < 3; i++) {
      await testSetup.renderOnce();
    }

    recorder.stop();

    const frames = recorder.recordedFrames;
    expect(frames.length).toBeGreaterThan(0);

    // Each frame should still contain at least some row content (we are
    // sticky-scrolled to bottom, so the latest rows should be visible).
    const framesWithoutRows = frames.filter((f) => !/Row \d+/.test(f.frame));

    if (framesWithoutRows.length > 0) {
      const report = framesWithoutRows
        .map(
          (f) =>
            `frame ${f.frameNumber} (t=${f.timestamp.toFixed(1)}ms) nonWhite=${nonWhitespaceCount(
              f.frame,
            )} (baseline=${baselineNonWhite})`,
        )
        .join("\n");
      console.log("FRAMES WITHOUT ROWS DETECTED:\n" + report);
      console.log("first bad frame content:\n" + framesWithoutRows[0].frame);
    }

    expect(framesWithoutRows).toEqual([]);

    // Also guard against big drops in non-whitespace content.
    const flickerThreshold = Math.floor(baselineNonWhite / 2);
    const blankFrames = frames.filter((f) => nonWhitespaceCount(f.frame) < flickerThreshold);
    if (blankFrames.length > 0) {
      console.log(
        "blank frame diag:",
        blankFrames.map((f) => ({
          frameNumber: f.frameNumber,
          nonWhite: nonWhitespaceCount(f.frame),
        })),
      );
      console.log("first blank frame content:\n" + blankFrames[0].frame);
    }
    expect(blankFrames).toEqual([]);
  });
});
