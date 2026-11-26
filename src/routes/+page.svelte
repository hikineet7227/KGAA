<script lang="ts">
	import { onMount } from "svelte";
	import { commands, events } from "$lib/bindings";
	import { workspace } from "$lib/state/workspace.svelte";
	import InkCanvas from "$lib/components/InkCanvas.svelte";
	import SpatialLayer from "$lib/components/SpatialLayer.svelte";
	import HudOverlay from "$lib/components/HudOverlay.svelte";

	let inkCanvas = $state<InkCanvas | null>(null);

	async function closeOverlay() {
		if (performance.now() - workspace.openedAt < 150) return;
		if (!workspace.isInteractive) return;
		inkCanvas?.finishStroke();
		workspace.isInteractive = false;
		workspace.isPanning = false;
		await commands.setOverlayInteractive(false);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (!workspace.isInteractive) return;

		if (e.ctrlKey || e.metaKey) {
			const key = e.key.toLowerCase();
			if (key === "z") {
				e.preventDefault();
				e.shiftKey ? inkCanvas?.redo() : inkCanvas?.undo();
				return;
			}
			if (key === "y") {
				e.preventDefault();
				inkCanvas?.redo();
				return;
			}
			return;
		}

		switch (e.key.toLowerCase()) {
			case "escape":
				closeOverlay();
				break;
			case "c":
				inkCanvas?.clear();
				break;
			case "h":
				workspace.showTelemetry = !workspace.showTelemetry;
				break;
			case "r":
				inkCanvas?.resetCamera();
				break;
		}
	}

	onMount(() => {
		const unlisten = events.overlayModeEvent.listen((event) => {
			workspace.isInteractive = event.payload;
			if (workspace.isInteractive) {
				workspace.openedAt = performance.now();
				inkCanvas?.render();
			}
		});

		return () => {
			unlisten.then((fn) => fn());
		};
	});
</script>

<svelte:window onblur={closeOverlay} onkeydown={handleKeydown} />

<main
	oncontextmenu={(e) => e.preventDefault()}
	class="w-screen h-screen overflow-hidden select-none"
>
	<div
		class="fixed inset-0 bg-zinc-950/75 transition-opacity duration-75 {workspace.isInteractive
			? 'opacity-100 pointer-events-auto'
			: 'opacity-0 pointer-events-none'}"
	>
		<InkCanvas bind:this={inkCanvas} />
		<SpatialLayer />
		<HudOverlay />
	</div>
</main>
