<script lang="ts">
	import { commands } from "$lib/bindings";
	import { onMount } from "svelte";
	import { listen } from "@tauri-apps/api/event";

	let isInteractive = $state(false);
	let query = $state("");
	let message = $state("");
	let inputEl = $state<HTMLInputElement | null>(null);

	async function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		if (!query.trim()) return;
		message = await commands.greet(query.trim());
		query = "";
	}

	async function closeOverlay() {
		isInteractive = false;
		await commands.setOverlayInteractive(false);
	}

	onMount(() => {
		const unlisten = listen<boolean>("overlay-mode", (event) => {
			isInteractive = event.payload;
			if (isInteractive) setTimeout(() => inputEl?.focus(), 20);
		});

		const handleKeydown = (e: KeyboardEvent) => {
			if (e.key === "Escape" && isInteractive) closeOverlay();
		};

		window.addEventListener("blur", () => {
			if (isInteractive) closeOverlay();
		});

		window.addEventListener("keydown", handleKeydown);
		return () => {
			unlisten.then((fn) => fn());
			window.removeEventListener("keydown", handleKeydown);
		};
	});
</script>

<main class="flex justify-center items-start w-screen h-screen pt-3">
	{#if isInteractive}
		<button
			type="button"
			aria-label="Đóng"
			tabindex="-1"
			onclick={closeOverlay}
			class="fixed inset-0 cursor-default"
		></button>
	{/if}

	<div
		class="relative z-10 bg-zinc-950/85 backdrop-blur-xl border border-white/10 text-zinc-100 shadow-2xl transition-all duration-200
		{isInteractive
			? 'w-md rounded-2xl p-3'
			: 'w-44 rounded-full px-3.5 py-1.5 opacity-80'}"
	>
		{#if !isInteractive}
			<div class="flex items-center justify-between text-xs">
				<span class="flex items-center gap-2 text-zinc-300">
					<span
						class="size-2 rounded-full bg-emerald-400 animate-pulse"
					></span>
					Ready
				</span>
				<kbd
					class="text-[10px] text-zinc-400 bg-white/10 px-1.5 py-0.5 rounded"
					>Alt+K</kbd
				>
			</div>
		{:else}
			<form onsubmit={handleSubmit} class="flex items-center gap-2">
				<input
					bind:this={inputEl}
					bind:value={query}
					type="text"
					placeholder="Nhập lệnh..."
					class="w-full bg-transparent text-sm outline-none placeholder:text-zinc-500"
				/>
				<button
					type="submit"
					class="px-3 py-1 rounded-lg bg-white text-zinc-950 text-xs font-medium hover:bg-zinc-200 cursor-pointer"
				>
					Gửi
				</button>
			</form>

			{#if message}
				<p
					class="mt-2.5 pt-2 border-t border-white/10 text-xs text-emerald-400"
				>
					{message}
				</p>
			{/if}
		{/if}
	</div>
</main>
