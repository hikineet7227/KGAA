<script lang="ts">
    import { onMount } from "svelte";
    import {
        calcPenHalfWidth,
        CONFIG,
        screenToWorld,
    } from "$lib/engine/geometry";
    import { InkRenderer } from "$lib/engine/ink-renderer";
    import { workspace } from "$lib/state/workspace.svelte";
    import type { StrokePoint } from "./types/workspace";

    let canvasEl = $state<HTMLCanvasElement | null>(null);
    const renderer = new InkRenderer();

    let currentPoints: StrokePoint[] = [];
    let isDrawing = false;
    let needsRender = false;
    let rafId: number | null = null;

    export function render() {
        if (!workspace.isInteractive) return;
        renderer.render(
            workspace.camera,
            window.innerWidth,
            window.innerHeight,
            workspace.strokes,
            workspace.selectedIds,
        );
    }

    function loop() {
        if (needsRender) {
            if (isDrawing && currentPoints.length > 0) {
                renderer.updateActiveStroke(currentPoints);
            }
            render();
            needsRender = false;
        }
        if (isDrawing || workspace.isPanning) {
            rafId = requestAnimationFrame(loop);
        } else {
            rafId = null;
        }
    }

    export function requestRender() {
        needsRender = true;
        if (!rafId) rafId = requestAnimationFrame(loop);
    }

    export function beginPenStroke(e: PointerEvent) {
        isDrawing = true;
        renderer.setActiveColor(workspace.penColor);
        const startPt = screenToWorld(e.clientX, e.clientY, workspace.camera);
        currentPoints = [
            { ...startPt, halfWidth: calcPenHalfWidth(e.pressure) },
        ];
        requestRender();
    }

    export function appendPenStroke(e: PointerEvent) {
        if (!isDrawing) return;
        const coalesced = e.getCoalescedEvents?.();
        const eventsList = coalesced && coalesced.length > 0 ? coalesced : [e];
        const minDist = CONFIG.brush.minPointDistPx / workspace.camera.zoom;

        for (const pt of eventsList) {
            const worldPt = screenToWorld(
                pt.clientX,
                pt.clientY,
                workspace.camera,
            );
            const last = currentPoints[currentPoints.length - 1];
            if (
                !last ||
                Math.hypot(worldPt.x - last.x, worldPt.y - last.y) > minDist
            ) {
                currentPoints.push({
                    ...worldPt,
                    halfWidth: calcPenHalfWidth(pt.pressure, last?.halfWidth),
                });
            }
        }
        requestRender();
    }

    export function finishStroke() {
        if (!isDrawing) return;
        isDrawing = false;
        if (currentPoints.length > 0) {
            renderer.updateActiveStroke(currentPoints);
            const id = crypto.randomUUID();
            if (renderer.commitActiveStroke(id)) {
                workspace.addStroke(id, currentPoints, workspace.penColor);
            }
        }
        currentPoints = [];
        needsRender = false;
        render();
    }

    export function syncDeletedStrokes() {
        const activeIds = new Set(workspace.strokes.map((s) => s.id));
        renderer.pruneCache(activeIds);
        render();
    }

    export function clear() {
        renderer.clear();
        workspace.clearStrokes();
        currentPoints = [];
        render();
    }

    function handleResize() {
        renderer.resize(
            window.innerWidth,
            window.innerHeight,
            window.devicePixelRatio || 1,
        );
        render();
    }

    onMount(() => {
        if (canvasEl) {
            renderer.init(canvasEl);
            handleResize();
        }
        return () => {
            if (rafId) cancelAnimationFrame(rafId);
            renderer.destroy();
        };
    });
</script>

<svelte:window onresize={handleResize} />

<canvas
    bind:this={canvasEl}
    class="fixed inset-0 z-20 w-full h-full pointer-events-none"
></canvas>
