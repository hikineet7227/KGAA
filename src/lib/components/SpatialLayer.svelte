<script lang="ts">
    import { convertFileSrc } from "@tauri-apps/api/core";
    import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
    import { workspace } from "$lib/state/workspace.svelte";
    import type { SnippetItem } from "./types/workspace";

    interface Props {
        onRequestInkRender?: () => void;
        onCloseOverlay?: () => void;
    }

    let { onRequestInkRender, onCloseOverlay }: Props = $props();

    let draggingId = $state<string | null>(null);
    let draggingGroup = $state(false);
    let dragStartMouse = { x: 0, y: 0 };
    let lastMouse = { x: 0, y: 0 };
    let dragStartItem = { x: 0, y: 0 };
    let movedDistance = 0;

    function formatTime(ms: number): string {
        return new Date(ms).toLocaleTimeString("vi-VN", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        });
    }

    function handleCardContextMenu(e: MouseEvent, item: SnippetItem) {
        e.preventDefault();
        e.stopPropagation();
        workspace.bringToFront(item.id);
        workspace.openRadialMenu(e.clientX, e.clientY, item.id);
    }

    async function handleOpenUrl(e: MouseEvent, rawUrl: string) {
        e.stopPropagation();
        const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
        await openUrl(url);
        onCloseOverlay?.();
    }

    async function handleRevealFile(e: MouseEvent, filePath: string) {
        e.stopPropagation();
        await revealItemInDir(filePath);
        onCloseOverlay?.();
    }
    function handleCardPointerDown(e: PointerEvent, item: SnippetItem) {
        if (e.button === 1) return;

        // Chuột phải trên thẻ -> theo dõi để mở Radial Menu ngữ cảnh thẻ
        if (e.pointerType === "mouse" && e.button === 2) {
            e.stopPropagation();
            return;
        }

        if (workspace.activeTool === "lasso") return;
        if (e.pointerType === "pen" && workspace.activeTool === "draw") return;

        if (e.button === 0) {
            e.stopPropagation();
            workspace.closeRadialMenu();
            workspace.bringToFront(item.id);
            dragStartMouse = { x: e.clientX, y: e.clientY };
            lastMouse = { x: e.clientX, y: e.clientY };

            if (workspace.selectedIds.has(item.id)) {
                draggingGroup = true;
            } else {
                workspace.clearSelection();
                draggingId = item.id;
                dragStartItem = { x: item.x, y: item.y };
            }
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }
    }

    function handleCardPointerMove(e: PointerEvent, item: SnippetItem) {
        if (!draggingGroup && draggingId !== item.id) return;
        e.stopPropagation();

        movedDistance = Math.max(
            movedDistance,
            Math.hypot(
                e.clientX - dragStartMouse.x,
                e.clientY - dragStartMouse.y,
            ),
        );

        if (draggingGroup) {
            const dx = (e.clientX - lastMouse.x) / workspace.camera.zoom;
            const dy = (e.clientY - lastMouse.y) / workspace.camera.zoom;
            lastMouse = { x: e.clientX, y: e.clientY };
            workspace.moveSelectionBy(dx, dy);
            onRequestInkRender?.();
        } else if (draggingId === item.id) {
            const dx = (e.clientX - dragStartMouse.x) / workspace.camera.zoom;
            const dy = (e.clientY - dragStartMouse.y) / workspace.camera.zoom;
            workspace.moveItem(
                item.id,
                dragStartItem.x + dx,
                dragStartItem.y + dy,
            );
        }
    }

    function handleCardPointerUp(e: PointerEvent, item: SnippetItem) {
        if (!draggingGroup && draggingId !== item.id) return;
        e.stopPropagation();
        draggingId = null;
        draggingGroup = false;
        if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) {
            (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
        }
    }

    function handleGroupBoxPointerDown(e: PointerEvent) {
        if (e.button !== 0) return;
        e.stopPropagation();
        workspace.closeRadialMenu();
        draggingGroup = true;
        lastMouse = { x: e.clientX, y: e.clientY };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }

    function handleGroupBoxPointerMove(e: PointerEvent) {
        if (!draggingGroup) return;
        e.stopPropagation();
        const dx = (e.clientX - lastMouse.x) / workspace.camera.zoom;
        const dy = (e.clientY - lastMouse.y) / workspace.camera.zoom;
        lastMouse = { x: e.clientX, y: e.clientY };
        workspace.moveSelectionBy(dx, dy);
        onRequestInkRender?.();
    }

    function handleGroupBoxPointerUp(e: PointerEvent) {
        if (!draggingGroup) return;
        e.stopPropagation();
        draggingGroup = false;
        if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) {
            (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
        }
    }

    const lassoPathD = $derived.by(() => {
        const pts = workspace.lassoPoints;
        if (pts.length < 2) return "";
        return (
            `M ${pts[0].x} ${pts[0].y} ` +
            pts
                .slice(1)
                .map((p) => `L ${p.x} ${p.y}`)
                .join(" ") +
            " Z"
        );
    });
</script>

<div class="fixed inset-0 z-10 pointer-events-none overflow-hidden">
    <div
        class="origin-top-left will-change-transform"
        style:transform="translate3d({workspace.camera.x}px, {workspace.camera
            .y}px, 0) scale({workspace.camera.zoom})"
    >
        <!-- Khung bao cụm đang chọn (Lasso Group Box) -->
        {#if workspace.selectionBBox}
            {@const box = workspace.selectionBBox}
            <div
                role="presentation"
                oncontextmenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    workspace.openRadialMenu(e.clientX, e.clientY, null);
                }}
                onpointerdown={handleGroupBoxPointerDown}
                onpointermove={handleGroupBoxPointerMove}
                onpointerup={handleGroupBoxPointerUp}
                onpointercancel={handleGroupBoxPointerUp}
                style:left="{box.minX - 10}px"
                style:top="{box.minY - 10}px"
                style:width="{box.maxX - box.minX + 20}px"
                style:height="{box.maxY - box.minY + 20}px"
                class="absolute rounded-2xl border-2 border-dashed border-sky-400/80 bg-sky-400/5 pointer-events-auto cursor-move"
            ></div>
        {/if}

        <!-- Danh sách thẻ ngữ cảnh -->
        {#each workspace.items as item (item.id)}
            {@const isSelected = workspace.selectedIds.has(item.id)}
            <article
                bind:clientWidth={item.width}
                bind:clientHeight={item.height}
                oncontextmenu={(e) => handleCardContextMenu(e, item)}
                onpointerdown={(e) => handleCardPointerDown(e, item)}
                onpointermove={(e) => handleCardPointerMove(e, item)}
                onpointerup={(e) => handleCardPointerUp(e, item)}
                onpointercancel={(e) => handleCardPointerUp(e, item)}
                style:transform="translate3d({item.x}px, {item.y}px, 0)"
                class="absolute top-0 left-0 w-80 rounded-xl bg-zinc-900/95 border shadow-2xl text-zinc-200 pointer-events-auto select-none transition-shadow {isSelected
                    ? 'border-sky-400 ring-2 ring-sky-400/40'
                    : draggingId === item.id
                      ? 'border-emerald-400/60 ring-2 ring-emerald-400/40 cursor-grabbing'
                      : 'border-white/15 hover:border-white/25 cursor-grab'}"
            >
                <header
                    class="flex items-center justify-between gap-2 px-3 py-2 border-b border-white/10"
                >
                    <div class="flex items-center gap-2 min-w-0">
                        <span
                            class="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 font-mono text-[10px] shrink-0"
                        >
                            {item.pulse.appName || "Unknown"}
                        </span>
                        <span
                            class="text-[11px] text-zinc-400 font-mono shrink-0"
                        >
                            {formatTime(item.pulse.timestampMs!)}
                        </span>
                    </div>
                    <button
                        type="button"
                        onpointerdown={(e) => e.stopPropagation()}
                        onclick={() => workspace.removeItem(item.id)}
                        class="text-zinc-500 hover:text-zinc-200 px-1 rounded hover:bg-white/10 text-xs cursor-pointer"
                        aria-label="Close card"
                    >
                        ✕
                    </button>
                </header>

                <div class="p-3 space-y-2.5 text-xs">
                    {#if item.pulse.windowTitle}
                        <p
                            class="font-medium text-zinc-100 line-clamp-2 leading-snug"
                        >
                            {item.pulse.windowTitle}
                        </p>
                    {/if}

                    {#if item.pulse.browserUrl}
                        <button
                            type="button"
                            onpointerdown={(e) => e.stopPropagation()}
                            onclick={(e) =>
                                handleOpenUrl(e, item.pulse.browserUrl!)}
                            class="w-full text-left px-2 py-1 rounded bg-sky-500/10 hover:bg-sky-500/20 border border-sky-400/20 text-sky-300 font-mono text-[11px] truncate cursor-pointer transition-colors"
                            title="Mở bằng trình duyệt: {item.pulse.browserUrl}"
                        >
                            ↗ {item.pulse.browserUrl}
                        </button>
                    {/if}

                    {#if item.pulse.selectedText}
                        <div class="space-y-1">
                            <span
                                class="text-[10px] uppercase tracking-wider text-emerald-400/80 font-semibold"
                            >
                                Selected
                            </span>
                            <p
                                class="p-2 rounded bg-white/5 border border-white/10 text-zinc-200 whitespace-pre-wrap line-clamp-5 leading-relaxed"
                            >
                                {item.pulse.selectedText}
                            </p>
                        </div>
                    {/if}

                    {#if item.pulse.clipboard}
                        {@const cb = item.pulse.clipboard}
                        <div class="space-y-1">
                            <div
                                class="flex items-center justify-between text-[10px] text-zinc-400"
                            >
                                <span
                                    class="uppercase tracking-wider font-semibold"
                                >
                                    Clipboard ({cb.payload.kind})
                                </span>
                                <span class="font-mono">
                                    {formatTime(cb.timestampMs!)}
                                </span>
                            </div>

                            {#if cb.payload.kind === "text"}
                                <p
                                    class="p-2 rounded bg-black/30 border border-white/5 text-zinc-300 font-mono text-[11px] whitespace-pre-wrap line-clamp-4 leading-relaxed"
                                >
                                    {cb.payload.text}
                                </p>
                            {:else if cb.payload.kind === "image"}
                                <div
                                    class="rounded-lg overflow-hidden border border-white/10 bg-black/40"
                                >
                                    <img
                                        src={convertFileSrc(cb.payload.path)}
                                        alt="Clipboard thumbnail"
                                        draggable="false"
                                        class="w-full max-h-44 object-contain"
                                    />
                                    <div
                                        class="px-2 py-1 text-[10px] text-zinc-400 font-mono border-t border-white/5"
                                    >
                                        {cb.payload.width}×{cb.payload.height}
                                    </div>
                                </div>
                            {:else if cb.payload.kind === "files"}
                                <ul
                                    class="p-1.5 rounded bg-black/30 border border-white/5 text-zinc-300 font-mono text-[11px] space-y-0.5 max-h-28 overflow-hidden"
                                >
                                    {#each cb.payload.paths.slice(0, 3) as filePath}
                                        <li>
                                            <button
                                                type="button"
                                                onpointerdown={(e) =>
                                                    e.stopPropagation()}
                                                onclick={(e) =>
                                                    handleRevealFile(
                                                        e,
                                                        filePath,
                                                    )}
                                                class="w-full text-left px-1.5 py-0.5 rounded hover:bg-white/10 text-zinc-200 truncate cursor-pointer"
                                                title="Mở trong Explorer: {filePath}"
                                            >
                                                📁 {filePath
                                                    .split(/[/\\]/)
                                                    .pop()}
                                            </button>
                                        </li>
                                    {/each}
                                    {#if cb.payload.paths.length > 3}
                                        <li
                                            class="px-1.5 text-zinc-500 text-[10px]"
                                        >
                                            +{cb.payload.paths.length - 3} more files...
                                        </li>
                                    {/if}
                                </ul>
                            {/if}
                        </div>
                    {/if}
                </div>
            </article>
        {/each}

        <!-- Đường bao Lasso (World-space SVG) -->
        {#if lassoPathD}
            <svg
                class="overflow-visible pointer-events-none absolute top-0 left-0"
                width="1"
                height="1"
            >
                <path
                    d={lassoPathD}
                    fill="rgba(56, 189, 248, 0.14)"
                    stroke="#38bdf8"
                    stroke-width={2 / workspace.camera.zoom}
                    stroke-dasharray="{6 / workspace.camera.zoom} {4 /
                        workspace.camera.zoom}"
                />
            </svg>
        {/if}
    </div>
</div>
