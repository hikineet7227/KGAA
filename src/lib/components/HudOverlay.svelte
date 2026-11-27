<script lang="ts">
    import { workspace } from "$lib/state/workspace.svelte";
    import type { ToolMode } from "./types/workspace";

    const tools: { id: ToolMode; label: string; key: string }[] = [
        { id: "draw", label: "Draw", key: "D" },
        { id: "lasso", label: "Lasso", key: "L" },
        { id: "interact", label: "Interact", key: "V" },
    ];
</script>

{#if workspace.showHud}
    <div
        role="toolbar"
        tabindex="0"
        onpointerdown={(e) => e.stopPropagation()}
        class="fixed bottom-5 left-1/2 -translate-x-1/2 z-30 flex items-center gap-3 px-3 py-1.5 rounded-full bg-zinc-900/90 backdrop-blur-md border border-white/15 shadow-2xl text-xs text-zinc-200 select-none pointer-events-auto"
    >
        <!-- Tool Mode Switcher -->
        <div class="flex items-center gap-1">
            {#each tools as tool}
                <button
                    type="button"
                    onclick={() => (workspace.activeTool = tool.id)}
                    class="flex items-center gap-1.5 px-2.5 py-1 rounded-full transition-colors cursor-pointer {workspace.activeTool ===
                    tool.id
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-400/30 font-medium'
                        : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5 border border-transparent'}"
                >
                    <span>{tool.label}</span>
                    <kbd class="text-[10px] opacity-60 font-mono"
                        >{tool.key}</kbd
                    >
                </button>
            {/each}
        </div>

        <div class="h-4 w-px bg-white/10"></div>

        <!-- Compact Status -->
        <div
            class="flex items-center gap-2.5 font-mono text-[11px] text-zinc-400 tabular-nums"
        >
            <span class="text-zinc-200"
                >{Math.round(workspace.camera.zoom * 100)}%</span
            >
            <span>{workspace.items.length} cards</span>
            <span>{workspace.strokeCount} ink</span>
        </div>

        <div class="h-4 w-px bg-white/10"></div>

        <!-- Minimal Hints -->
        <div class="flex items-center gap-2 text-[11px] text-zinc-400">
            <span><kbd class="text-zinc-200 font-mono">R</kbd> Reset</span>
            <span><kbd class="text-zinc-200 font-mono">C</kbd> Clear</span>
            <span><kbd class="text-zinc-200 font-mono">Esc</kbd> Close</span>
        </div>
    </div>
{/if}
