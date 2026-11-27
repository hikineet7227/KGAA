<script lang="ts">
	import { onMount } from "svelte";
	import { commands, events } from "$lib/bindings";
	import { CONFIG, screenToWorld } from "$lib/engine/geometry";
	import { workspace } from "$lib/state/workspace.svelte";
	import InkCanvas from "$lib/components/InkCanvas.svelte";
	import SpatialLayer from "$lib/components/SpatialLayer.svelte";
	import HudOverlay from "$lib/components/HudOverlay.svelte";
	import RadialMenu from "$lib/components/RadialMenu.svelte";

	let inkCanvas = $state<InkCanvas | null>(null);
	let panStart = { x: 0, y: 0 };
	let rightClickStart: { x: number; y: number } | null = null;
	let isLassoing = false;

	async function closeOverlay() {
		if (!workspace.isInteractive) return;
		inkCanvas?.finishStroke();
		workspace.closeRadialMenu();
		workspace.lassoPoints = [];
		isLassoing = false;
		workspace.isInteractive = false;
		workspace.isPanning = false;
		await commands.setOverlayState("passive");
	}

	function handleDeleteSelection() {
		workspace.deleteSelection();
		inkCanvas?.syncDeletedStrokes();
	}

	function handlePointerDown(e: PointerEvent) {
		if (!workspace.isInteractive) return;
		const target = e.currentTarget as HTMLElement;

		// Đóng Radial Menu nếu bấm ra ngoài
		if (e.button === 0 && workspace.radialMenu.open) {
			workspace.closeRadialMenu();
		}

		// 1. Nút phụ của Bút (luôn Pan) hoặc Chuột giữa (luôn Pan)
		if (
			(e.pointerType === "pen" && (e.button === 2 || e.buttons === 2)) ||
			e.button === 1
		) {
			inkCanvas?.finishStroke();
			workspace.isPanning = true;
			panStart = {
				x: e.clientX - workspace.camera.x,
				y: e.clientY - workspace.camera.y,
			};
			target.setPointerCapture(e.pointerId);
			return;
		}

		// 2. Chuột phải -> Theo dõi mở Radial Menu nếu thả tại chỗ (< 4px)
		if (e.pointerType === "mouse" && e.button === 2) {
			rightClickStart = { x: e.clientX, y: e.clientY };
			return;
		}

		// 3. Chế độ Lasso -> Cả chuột trái và bút đều khoanh được
		if (e.button === 0 && workspace.activeTool === "lasso") {
			isLassoing = true;
			workspace.clearSelection();
			workspace.lassoPoints = [
				screenToWorld(e.clientX, e.clientY, workspace.camera),
			];
			target.setPointerCapture(e.pointerId);
			inkCanvas?.requestRender();
			return;
		}

		// 4. Đầu Bút ở chế độ Draw -> Vẽ WebGL
		if (
			e.pointerType === "pen" &&
			e.button === 0 &&
			workspace.activeTool === "draw"
		) {
			workspace.clearSelection();
			target.setPointerCapture(e.pointerId);
			inkCanvas?.beginPenStroke(e);
			return;
		}

		// 5. Click nền trống ở chế độ Interact/Draw -> Bỏ chọn
		if (e.button === 0 && workspace.selectedIds.size > 0) {
			workspace.clearSelection();
			inkCanvas?.requestRender();
		}
	}

	function handlePointerMove(e: PointerEvent) {
		if (!workspace.isInteractive) return;

		if (workspace.isPanning) {
			workspace.camera.x = e.clientX - panStart.x;
			workspace.camera.y = e.clientY - panStart.y;
			inkCanvas?.requestRender();
			return;
		}

		if (isLassoing) {
			const pt = screenToWorld(e.clientX, e.clientY, workspace.camera);
			const last =
				workspace.lassoPoints[workspace.lassoPoints.length - 1];
			if (
				!last ||
				Math.hypot(pt.x - last.x, pt.y - last.y) >
					4 / workspace.camera.zoom
			) {
				workspace.lassoPoints.push(pt);
			}
			return;
		}

		if (e.pointerType === "pen" && workspace.activeTool === "draw") {
			inkCanvas?.appendPenStroke(e);
		}
	}

	function handlePointerUp(e: PointerEvent) {
		const target = e.currentTarget as HTMLElement;

		if (rightClickStart && e.pointerType === "mouse" && e.button === 2) {
			const dist = Math.hypot(
				e.clientX - rightClickStart.x,
				e.clientY - rightClickStart.y,
			);
			rightClickStart = null;
			if (dist < 4) {
				workspace.openRadialMenu(e.clientX, e.clientY);
			}
		}

		if (isLassoing) {
			isLassoing = false;
			workspace.selectByLasso(workspace.lassoPoints);
			workspace.lassoPoints = [];
			inkCanvas?.requestRender();
		}

		if (workspace.isPanning) workspace.isPanning = false;
		inkCanvas?.finishStroke();

		if (target.hasPointerCapture(e.pointerId)) {
			target.releasePointerCapture(e.pointerId);
		}
	}

	function handleWheel(e: WheelEvent) {
		if (!workspace.isInteractive) return;
		e.preventDefault();

		if (e.ctrlKey) {
			const { min, max } = CONFIG.zoom;
			const zoomFactor = Math.exp(-e.deltaY * 0.01);
			const newZoom = Math.min(
				Math.max(workspace.camera.zoom * zoomFactor, min),
				max,
			);
			if (newZoom === workspace.camera.zoom) return;

			const ratio = newZoom / workspace.camera.zoom;
			workspace.camera.x =
				e.clientX - (e.clientX - workspace.camera.x) * ratio;
			workspace.camera.y =
				e.clientY - (e.clientY - workspace.camera.y) * ratio;
			workspace.camera.zoom = newZoom;
			inkCanvas?.requestRender();
			return;
		}

		workspace.camera.x -= e.deltaX;
		workspace.camera.y -= e.deltaY;
		inkCanvas?.requestRender();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (!workspace.isInteractive) return;

		if (e.key === "Delete" || e.key === "Backspace") {
			if (workspace.selectedIds.size > 0) {
				e.preventDefault();
				handleDeleteSelection();
			}
			return;
		}

		switch (e.key.toLowerCase()) {
			case "escape":
				if (workspace.radialMenu.open) {
					workspace.closeRadialMenu();
				} else if (workspace.selectedIds.size > 0) {
					workspace.clearSelection();
					inkCanvas?.requestRender();
				} else {
					closeOverlay();
				}
				break;
			case "d":
				workspace.activeTool = "draw";
				break;
			case "l":
				workspace.activeTool = "lasso";
				break;
			case "v":
				workspace.activeTool = "interact";
				break;
			case "c":
				inkCanvas?.clear();
				break;
			case "h":
				workspace.showHud = !workspace.showHud;
				break;
			case "r":
				workspace.resetCamera();
				inkCanvas?.requestRender();
				break;
		}
	}

	onMount(() => {
		const unlistenState = events.overlayStateEvent.listen((event) => {
			workspace.isInteractive = event.payload === "workspace";
			if (workspace.isInteractive) {
				inkCanvas?.render();
			}
		});

		const unlistenPulse = events.contextPulseEvent.listen((event) => {
			workspace.addContextPulse(event.payload);
		});

		return () => {
			unlistenState.then((fn) => fn());
			unlistenPulse.then((fn) => fn());
		};
	});
</script>

<svelte:window onblur={closeOverlay} onkeydown={handleKeydown} />

<main
	oncontextmenu={(e) => e.preventDefault()}
	class="w-screen h-screen overflow-hidden select-none"
>
	<div
		role="application"
		onpointerdown={handlePointerDown}
		onpointermove={handlePointerMove}
		onpointerup={handlePointerUp}
		onpointercancel={handlePointerUp}
		onwheel={handleWheel}
		class="fixed inset-0 touch-none bg-zinc-950/75 transition-opacity duration-75 {workspace.isInteractive
			? 'opacity-100 pointer-events-auto'
			: 'opacity-0 pointer-events-none'} {workspace.isPanning
			? 'cursor-grabbing'
			: workspace.activeTool === 'draw' ||
				  workspace.activeTool === 'lasso'
				? 'cursor-crosshair'
				: 'cursor-default'}"
	>
		<SpatialLayer
			onRequestInkRender={() => inkCanvas?.requestRender()}
			onCloseOverlay={closeOverlay}
		/>
		<InkCanvas bind:this={inkCanvas} />
		<RadialMenu
			onDeleteSelection={handleDeleteSelection}
			onClearInk={() => inkCanvas?.clear()}
		/>
		<HudOverlay />
	</div>
</main>
