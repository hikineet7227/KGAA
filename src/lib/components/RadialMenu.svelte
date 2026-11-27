<script lang="ts">
    import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
    import { PEN_PALETTE } from "$lib/engine/geometry";
    import { workspace } from "$lib/state/workspace.svelte";
    import type { RGBA, ToolMode } from "./types/workspace";

    interface Props {
        onDeleteSelection: () => void;
        onClearInk: () => void;
        onCloseOverlay?: () => void;
    }

    let { onDeleteSelection, onClearInk, onCloseOverlay }: Props = $props();

    const targetCard = $derived(
        workspace.radialMenu.targetCardId
            ? (workspace.items.find(
                  (it) => it.id === workspace.radialMenu.targetCardId,
              ) ?? null)
            : null,
    );

    const copyableText = $derived.by(() => {
        if (!targetCard) return null;
        if (targetCard.pulse.selectedText) return targetCard.pulse.selectedText;
        if (targetCard.pulse.clipboard?.payload.kind === "text") {
            return targetCard.pulse.clipboard.payload.text;
        }
        return null;
    });

    function pickTool(tool: ToolMode) {
        workspace.activeTool = tool;
        workspace.closeRadialMenu();
    }

    function pickColor(rgba: RGBA) {
        workspace.penColor = rgba;
        workspace.activeTool = "draw";
        workspace.closeRadialMenu();
    }

    async function handleCopyCardText() {
        if (!copyableText) return;
        await navigator.clipboard.writeText(copyableText);
        workspace.closeRadialMenu();
    }

    async function handleOpenTarget() {
        if (!targetCard) return;
        if (targetCard.pulse.browserUrl) {
            const raw = targetCard.pulse.browserUrl;
            const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
            workspace.closeRadialMenu();
            await openUrl(url);
            onCloseOverlay?.();
            return;
        }
        if (
            targetCard.pulse.clipboard?.payload.kind === "files" &&
            targetCard.pulse.clipboard.payload.paths.length > 0
        ) {
            const firstPath = targetCard.pulse.clipboard.payload.paths[0];
            workspace.closeRadialMenu();
            await revealItemInDir(firstPath);
            onCloseOverlay?.();
        }
    }
</script>

{#if workspace.radialMenu.open}
    <div
        role="menu"
        tabindex="0"
        onpointerdown={(e) => e.stopPropagation()}
        style:left="{workspace.radialMenu.x}px"
        style:top="{workspace.radialMenu.y}px"
        class="fixed z-40 -translate-x-1/2 -translate-y-1/2 pointer-events-auto"
    >
        <div
            class="w-48 rounded-2xl bg-zinc-900/95 border border-white/15 shadow-2xl backdrop-blur-md p-2.5 space-y-2 text-xs text-zinc-200"
        >
            {#if targetCard}
                <!-- NGỮ CẢNH 1: Chuột phải trực tiếp lên 1 Card -->
                <div
                    class="px-1.5 py-0.5 text-[10px] font-mono text-zinc-400 truncate border-b border-white/10 pb-1.5"
                >
                    {targetCard.pulse.appName || "Card"}
                </div>

                <div class="space-y-1">
                    {#if copyableText}
                        <button
                            type="button"
                            onclick={handleCopyCardText}
                            class="w-full text-left px-2 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-zinc-200 cursor-pointer"
                        >
                            Copy nội dung
                        </button>
                    {/if}

                    {#if targetCard.pulse.browserUrl}
                        <button
                            type="button"
                            onclick={handleOpenTarget}
                            class="w-full text-left px-2 py-1.5 rounded-lg bg-sky-500/15 hover:bg-sky-500/25 text-sky-300 cursor-pointer"
                        >
                            ↗ Mở URL trong trình duyệt
                        </button>
                    {:else if targetCard.pulse.clipboard?.payload.kind === "files"}
                        <button
                            type="button"
                            onclick={handleOpenTarget}
                            class="w-full text-left px-2 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-zinc-200 cursor-pointer"
                        >
                            📁 Mở trong Explorer
                        </button>
                    {/if}

                    <button
                        type="button"
                        onclick={() => {
                            workspace.removeItem(targetCard.id);
                            workspace.closeRadialMenu();
                        }}
                        class="w-full text-left px-2 py-1.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 font-medium cursor-pointer"
                    >
                        Xóa thẻ này
                    </button>
                </div>
            {:else if workspace.selectedIds.size > 0}
                <!-- NGỮ CẢNH 2: Đang có vùng chọn Lasso -->
                <div class="grid grid-cols-3 gap-1">
                    {#each ["draw", "lasso", "interact"] as const as mode}
                        <button
                            type="button"
                            onclick={() => pickTool(mode)}
                            class="py-1.5 rounded-lg capitalize font-medium cursor-pointer transition-colors {workspace.activeTool ===
                            mode
                                ? 'bg-emerald-500/25 text-emerald-300 border border-emerald-400/40'
                                : 'bg-white/5 hover:bg-white/10 text-zinc-300'}"
                        >
                            {mode}
                        </button>
                    {/each}
                </div>

                <div class="pt-1 border-t border-white/10">
                    <button
                        type="button"
                        onclick={() => {
                            onDeleteSelection();
                            workspace.closeRadialMenu();
                        }}
                        class="w-full py-1.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 font-medium cursor-pointer"
                    >
                        Xóa vùng chọn ({workspace.selectedIds.size})
                    </button>
                </div>
            {:else}
                <!-- NGỮ CẢNH 3: Nền trống -->
                <div class="grid grid-cols-3 gap-1">
                    {#each ["draw", "lasso", "interact"] as const as mode}
                        <button
                            type="button"
                            onclick={() => pickTool(mode)}
                            class="py-1.5 rounded-lg capitalize font-medium cursor-pointer transition-colors {workspace.activeTool ===
                            mode
                                ? 'bg-emerald-500/25 text-emerald-300 border border-emerald-400/40'
                                : 'bg-white/5 hover:bg-white/10 text-zinc-300'}"
                        >
                            {mode}
                        </button>
                    {/each}
                </div>

                <div class="flex items-center justify-between px-1 py-1">
                    {#each PEN_PALETTE as swatch}
                        <button
                            type="button"
                            onclick={() => pickColor(swatch.rgba)}
                            aria-label={swatch.name}
                            class="w-6 h-6 rounded-full cursor-pointer transition-transform hover:scale-110 {workspace.penColor ===
                            swatch.rgba
                                ? 'ring-2 ring-white ring-offset-2 ring-offset-zinc-900'
                                : ''}"
                            style:background-color={swatch.hex}
                        ></button>
                    {/each}
                </div>

                <div class="pt-1 border-t border-white/10">
                    <button
                        type="button"
                        onclick={() => {
                            onClearInk();
                            workspace.closeRadialMenu();
                        }}
                        class="w-full py-1.5 rounded-lg bg-white/5 hover:bg-rose-500/20 hover:text-rose-300 text-zinc-300 font-medium cursor-pointer"
                    >
                        Xóa toàn bộ nét mực
                    </button>
                </div>
            {/if}
        </div>
    </div>
{/if}
