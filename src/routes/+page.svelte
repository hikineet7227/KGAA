<script lang="ts">
	import { commands, events } from "$lib/bindings";
	import { onMount } from "svelte";

	// =========================================================================
	// 1. CONFIG & CONSTANTS
	// =========================================================================
	const CONFIG = {
		zoom: {
			min: 1.0,
			max: 2.0,
		},
		brush: {
			mouseHalfWidth: 2.0,
			penMinHalfWidth: 1.7,
			penMaxHalfWidth: 5.5,
			deadzone: 0.12,
			pressureExponent: 1.25,
			widthSmoothing: 0.25,
			minPointDistPx: 2.4,
		},
		colors: {
			pen: [0.204, 0.827, 0.6, 1.0] as RGBA,
			mouse: [1.0, 1.0, 1.0, 0.78] as RGBA,
		},
		buffers: {
			batchInitialCapacity: 65536,
			activeInitialCapacity: 16384,
		},
		hudThrottleMs: 32,
	} as const;

	const VS_SOURCE = `#version 300 es
		in vec3 a_position;
		uniform mat3 u_matrix;
		out float v_side;

		void main() {
			v_side = a_position.z;
			vec3 clipSpace = u_matrix * vec3(a_position.xy, 1.0);
			gl_Position = vec4(clipSpace.xy, 0.0, 1.0);
		}
	`;

	const FS_SOURCE = `#version 300 es
		precision highp float;
		in float v_side;
		uniform vec4 u_color;
		out vec4 outColor;

		void main() {
			float dist = abs(v_side);
			float aa = fwidth(dist);
			float alpha = u_color.a * (1.0 - smoothstep(1.0 - aa, 1.0, dist));
			outColor = vec4(u_color.rgb * alpha, alpha);
		}
	`;

	// =========================================================================
	// 2. TYPES
	// =========================================================================
	type RGBA = [number, number, number, number];
	type BrushType = "pen" | "mouse";

	interface Vec2 {
		x: number;
		y: number;
	}

	interface StrokePoint extends Vec2 {
		halfWidth: number;
	}

	interface StrokeBatch {
		buffer: WebGLBuffer;
		capacityVertices: number;
		vertexCount: number;
		lastVertex: [number, number, number] | null;
		color: RGBA;
	}

	interface ActiveStroke {
		buffer: WebGLBuffer;
		cpuData: Float32Array;
		capacityVertices: number;
		vertexCount: number;
		committedPoints: number;
		color: RGBA;
	}

	interface HistoryEntry {
		brush: BrushType;
		prevVertexCount: number;
		nextVertexCount: number;
		prevLastVertex: [number, number, number] | null;
		nextLastVertex: [number, number, number] | null;
	}

	// =========================================================================
	// 3. REACTIVE UI STATE
	// =========================================================================
	let canvasEl = $state<HTMLCanvasElement | null>(null);
	let isInteractive = $state(false);
	let showTelemetry = $state(true);
	let isPanning = $state(false);
	let strokeCount = $state(0);
	let camera = $state({ x: 0, y: 0, zoom: 2 });
	let openedAt = 0;

	let telemetry = $state({
		pointerType: "-",
		clientX: 0,
		clientY: 0,
		pressure: 0,
		tiltX: 0,
		tiltY: 0,
		button: -1,
		buttons: 0,
	});

	// =========================================================================
	// 4. ENGINE & RUNTIME STATE (NON-REACTIVE)
	// =========================================================================
	let gl: WebGL2RenderingContext | null = null;
	let program: WebGLProgram | null = null;
	let uMatrixLoc: WebGLUniformLocation | null = null;
	let uColorLoc: WebGLUniformLocation | null = null;
	let aPosLoc = -1;

	let undoStack: HistoryEntry[] = [];
	let redoStack: HistoryEntry[] = [];

	let activeStroke: ActiveStroke | null = null;
	const batches: Record<BrushType, StrokeBatch | null> = {
		pen: null,
		mouse: null,
	};

	let currentPoints: StrokePoint[] = [];
	let currentBrush: BrushType = "mouse";
	let panStart: Vec2 = { x: 0, y: 0 };

	let isDrawing = false;
	let needsRender = false;
	let rafId: number | null = null;
	let lastHudUpdate = 0;

	const viewMatrix = new Float32Array(9);

	// =========================================================================
	// 5. MATH & STROKE HELPERS
	// =========================================================================
	function screenToWorld(clientX: number, clientY: number): Vec2 {
		return {
			x: (clientX - camera.x) / camera.zoom,
			y: (clientY - camera.y) / camera.zoom,
		};
	}

	function calcHalfWidth(e: PointerEvent, prevHalfWidth?: number): number {
		const {
			mouseHalfWidth,
			penMinHalfWidth,
			penMaxHalfWidth,
			deadzone,
			pressureExponent,
			widthSmoothing,
		} = CONFIG.brush;

		if (e.pointerType !== "pen") return mouseHalfWidth;

		const cleanPressure = Math.max(
			0,
			(e.pressure - deadzone) / (1 - deadzone),
		);
		const curved = Math.pow(cleanPressure, pressureExponent);
		const targetHalf =
			penMinHalfWidth + (penMaxHalfWidth - penMinHalfWidth) * curved;

		return prevHalfWidth !== undefined
			? prevHalfWidth + (targetHalf - prevHalfWidth) * widthSmoothing
			: targetHalf;
	}

	function updateTelemetry(e: PointerEvent, force = false) {
		if (!showTelemetry) return;
		const now = performance.now();
		if (!force && now - lastHudUpdate < CONFIG.hudThrottleMs) return;
		lastHudUpdate = now;

		telemetry = {
			pointerType: e.pointerType,
			clientX: Math.round(e.clientX * 10) / 10,
			clientY: Math.round(e.clientY * 10) / 10,
			pressure: Number(e.pressure.toFixed(3)),
			tiltX: e.tiltX,
			tiltY: e.tiltY,
			button: e.button,
			buttons: e.buttons,
		};
	}

	// =========================================================================
	// 6. WEBGL2 ENGINE
	// =========================================================================
	function compileShader(
		ctx: WebGL2RenderingContext,
		type: number,
		source: string,
	): WebGLShader | null {
		const shader = ctx.createShader(type);
		if (!shader) return null;
		ctx.shaderSource(shader, source);
		ctx.compileShader(shader);
		if (!ctx.getShaderParameter(shader, ctx.COMPILE_STATUS)) {
			console.error(ctx.getShaderInfoLog(shader));
			ctx.deleteShader(shader);
			return null;
		}
		return shader;
	}

	function createBatch(
		ctx: WebGL2RenderingContext,
		color: RGBA,
		initialCapacity = CONFIG.buffers.batchInitialCapacity,
	): StrokeBatch {
		const buffer = ctx.createBuffer()!;
		ctx.bindBuffer(ctx.ARRAY_BUFFER, buffer);
		ctx.bufferData(
			ctx.ARRAY_BUFFER,
			initialCapacity * 3 * 4,
			ctx.DYNAMIC_DRAW,
		);
		return {
			buffer,
			capacityVertices: initialCapacity,
			vertexCount: 0,
			lastVertex: null,
			color,
		};
	}

	function createActiveStroke(
		ctx: WebGL2RenderingContext,
		capacity = CONFIG.buffers.activeInitialCapacity,
	): ActiveStroke {
		const buffer = ctx.createBuffer()!;
		ctx.bindBuffer(ctx.ARRAY_BUFFER, buffer);
		ctx.bufferData(ctx.ARRAY_BUFFER, capacity * 3 * 4, ctx.DYNAMIC_DRAW);
		return {
			buffer,
			cpuData: new Float32Array(capacity * 3),
			capacityVertices: capacity,
			vertexCount: 0,
			committedPoints: 0,
			color: CONFIG.colors.mouse,
		};
	}

	function initWebGL() {
		if (!canvasEl) return;

		gl = canvasEl.getContext("webgl2", {
			alpha: true,
			antialias: true,
			premultipliedAlpha: true,
		});
		if (!gl) return;

		const vs = compileShader(gl, gl.VERTEX_SHADER, VS_SOURCE);
		const fs = compileShader(gl, gl.FRAGMENT_SHADER, FS_SOURCE);
		if (!vs || !fs) return;

		program = gl.createProgram()!;
		gl.attachShader(program, vs);
		gl.attachShader(program, fs);
		gl.linkProgram(program);
		gl.deleteShader(vs);
		gl.deleteShader(fs);

		uMatrixLoc = gl.getUniformLocation(program, "u_matrix");
		uColorLoc = gl.getUniformLocation(program, "u_color");
		aPosLoc = gl.getAttribLocation(program, "a_position");

		gl.useProgram(program);
		gl.enableVertexAttribArray(aPosLoc);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

		activeStroke = createActiveStroke(gl);
		batches.pen = createBatch(gl, CONFIG.colors.pen);
		batches.mouse = createBatch(gl, CONFIG.colors.mouse);

		resizeCanvas();
	}

	function destroyWebGL() {
		if (!gl) return;
		if (batches.pen) gl.deleteBuffer(batches.pen.buffer);
		if (batches.mouse) gl.deleteBuffer(batches.mouse.buffer);
		if (activeStroke) gl.deleteBuffer(activeStroke.buffer);
		if (program) gl.deleteProgram(program);
	}

	function resizeCanvas() {
		if (!canvasEl) return;
		const dpr = window.devicePixelRatio || 1;
		canvasEl.width = Math.round(window.innerWidth * dpr);
		canvasEl.height = Math.round(window.innerHeight * dpr);
		if (gl) {
			gl.viewport(0, 0, canvasEl.width, canvasEl.height);
			renderScene();
		}
	}

	function updateActiveStroke(points: StrokePoint[], brush: BrushType) {
		if (!gl || !activeStroke || points.length === 0) return;

		activeStroke.color = CONFIG.colors[brush];

		if (points.length === 1) {
			const { x, y, halfWidth: hw } = points[0];
			const d = activeStroke.cpuData;
			d[0] = x - hw;
			d[1] = y - hw;
			d[2] = -1;
			d[3] = x + hw;
			d[4] = y - hw;
			d[5] = 1;
			d[6] = x - hw;
			d[7] = y + hw;
			d[8] = -1;
			d[9] = x + hw;
			d[10] = y + hw;
			d[11] = 1;

			activeStroke.vertexCount = 4;
			activeStroke.committedPoints = 0;

			gl.bindBuffer(gl.ARRAY_BUFFER, activeStroke.buffer);
			gl.bufferSubData(gl.ARRAY_BUFFER, 0, d.subarray(0, 12));
			return;
		}

		const requiredVertices = points.length * 2;
		if (requiredVertices > activeStroke.capacityVertices) {
			const newCapacity = Math.max(
				activeStroke.capacityVertices * 2,
				requiredVertices + 4096,
			);
			const committedFloats = activeStroke.committedPoints * 6;
			const newCpuData = new Float32Array(newCapacity * 3);
			newCpuData.set(activeStroke.cpuData.subarray(0, committedFloats));

			const newBuffer = gl.createBuffer()!;
			gl.bindBuffer(gl.ARRAY_BUFFER, newBuffer);
			gl.bufferData(
				gl.ARRAY_BUFFER,
				newCapacity * 3 * 4,
				gl.DYNAMIC_DRAW,
			);
			gl.bufferSubData(
				gl.ARRAY_BUFFER,
				0,
				newCpuData.subarray(0, committedFloats),
			);

			gl.deleteBuffer(activeStroke.buffer);
			activeStroke.buffer = newBuffer;
			activeStroke.cpuData = newCpuData;
			activeStroke.capacityVertices = newCapacity;
		}

		const startIdx = activeStroke.committedPoints;
		let ptr = startIdx * 6;

		for (let i = startIdx; i < points.length; i++) {
			const curr = points[i];
			const prev = points[i - 1] ?? curr;
			const next = points[i + 1] ?? curr;

			let dx = next.x - prev.x;
			let dy = next.y - prev.y;
			const len = Math.hypot(dx, dy) || 1;
			dx /= len;
			dy /= len;

			const nx = -dy * curr.halfWidth;
			const ny = dx * curr.halfWidth;

			activeStroke.cpuData[ptr++] = curr.x + nx;
			activeStroke.cpuData[ptr++] = curr.y + ny;
			activeStroke.cpuData[ptr++] = -1;

			activeStroke.cpuData[ptr++] = curr.x - nx;
			activeStroke.cpuData[ptr++] = curr.y - ny;
			activeStroke.cpuData[ptr++] = 1;
		}

		activeStroke.vertexCount = requiredVertices;

		const startFloat = startIdx * 6;
		const endFloat = requiredVertices * 3;
		gl.bindBuffer(gl.ARRAY_BUFFER, activeStroke.buffer);
		gl.bufferSubData(
			gl.ARRAY_BUFFER,
			startFloat * 4,
			activeStroke.cpuData.subarray(startFloat, endFloat),
		);

		activeStroke.committedPoints = points.length - 1;
	}

	function appendToBatch(batch: StrokeBatch, strokeVerts: Float32Array) {
		if (!gl || strokeVerts.length < 3) return;

		const hasPrev = batch.vertexCount > 0 && batch.lastVertex !== null;
		const extraFloats = hasPrev ? 6 : 0;
		const totalNewFloats = strokeVerts.length + extraFloats;
		const newVertexCount = batch.vertexCount + totalNewFloats / 3;

		if (newVertexCount > batch.capacityVertices) {
			const newCapacity = Math.max(
				batch.capacityVertices * 2,
				newVertexCount + 16384,
			);
			const newBuffer = gl.createBuffer()!;
			gl.bindBuffer(gl.COPY_WRITE_BUFFER, newBuffer);
			gl.bufferData(
				gl.COPY_WRITE_BUFFER,
				newCapacity * 3 * 4,
				gl.DYNAMIC_DRAW,
			);

			gl.bindBuffer(gl.COPY_READ_BUFFER, batch.buffer);
			gl.copyBufferSubData(
				gl.COPY_READ_BUFFER,
				gl.COPY_WRITE_BUFFER,
				0,
				0,
				batch.vertexCount * 3 * 4,
			);

			gl.deleteBuffer(batch.buffer);
			batch.buffer = newBuffer;
			batch.capacityVertices = newCapacity;
		}

		const uploadData = new Float32Array(totalNewFloats);
		let offset = 0;

		if (hasPrev && batch.lastVertex) {
			uploadData[offset++] = batch.lastVertex[0];
			uploadData[offset++] = batch.lastVertex[1];
			uploadData[offset++] = batch.lastVertex[2];

			uploadData[offset++] = strokeVerts[0];
			uploadData[offset++] = strokeVerts[1];
			uploadData[offset++] = strokeVerts[2];
		}

		uploadData.set(strokeVerts, offset);

		gl.bindBuffer(gl.ARRAY_BUFFER, batch.buffer);
		gl.bufferSubData(
			gl.ARRAY_BUFFER,
			batch.vertexCount * 3 * 4,
			uploadData,
		);

		const len = strokeVerts.length;
		batch.lastVertex = [
			strokeVerts[len - 3],
			strokeVerts[len - 2],
			strokeVerts[len - 1],
		];
		batch.vertexCount = newVertexCount;
	}

	function drawBuffer(buffer: WebGLBuffer, vertexCount: number, color: RGBA) {
		if (!gl || vertexCount <= 0) return;
		gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
		gl.vertexAttribPointer(aPosLoc, 3, gl.FLOAT, false, 0, 0);
		gl.uniform4fv(uColorLoc, color);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, vertexCount);
	}

	function renderScene() {
		if (!gl || !program || !isInteractive) return;

		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);

		viewMatrix[0] = (2 * camera.zoom) / window.innerWidth;
		viewMatrix[1] = 0;
		viewMatrix[2] = 0;
		viewMatrix[3] = 0;
		viewMatrix[4] = (-2 * camera.zoom) / window.innerHeight;
		viewMatrix[5] = 0;
		viewMatrix[6] = (2 * camera.x) / window.innerWidth - 1;
		viewMatrix[7] = (-2 * camera.y) / window.innerHeight + 1;
		viewMatrix[8] = 1;

		gl.uniformMatrix3fv(uMatrixLoc, false, viewMatrix);

		if (batches.mouse) {
			drawBuffer(
				batches.mouse.buffer,
				batches.mouse.vertexCount,
				batches.mouse.color,
			);
		}
		if (batches.pen) {
			drawBuffer(
				batches.pen.buffer,
				batches.pen.vertexCount,
				batches.pen.color,
			);
		}
		if (activeStroke) {
			drawBuffer(
				activeStroke.buffer,
				activeStroke.vertexCount,
				activeStroke.color,
			);
		}
	}

	// =========================================================================
	// 7. RENDER LOOP
	// =========================================================================
	function loop() {
		if (needsRender) {
			if (isDrawing && currentPoints.length > 0) {
				updateActiveStroke(currentPoints, currentBrush);
			}
			renderScene();
			needsRender = false;
		}
		if (isDrawing || isPanning) {
			rafId = requestAnimationFrame(loop);
		} else {
			rafId = null;
		}
	}

	function requestRender() {
		needsRender = true;
		if (!rafId) rafId = requestAnimationFrame(loop);
	}

	// =========================================================================
	// 8. CANVAS ACTIONS
	// =========================================================================
	function finishStroke() {
		isDrawing = false;
		if (currentPoints.length > 0 && needsRender) {
			updateActiveStroke(currentPoints, currentBrush);
		}
		if (activeStroke && activeStroke.vertexCount > 0) {
			const targetBatch = batches[currentBrush];
			if (targetBatch) {
				const prevVertexCount = targetBatch.vertexCount;
				const prevLastVertex = targetBatch.lastVertex;

				const finalVerts = activeStroke.cpuData.subarray(
					0,
					activeStroke.vertexCount * 3,
				);
				appendToBatch(targetBatch, finalVerts);

				undoStack.push({
					brush: currentBrush,
					prevVertexCount,
					nextVertexCount: targetBatch.vertexCount,
					prevLastVertex,
					nextLastVertex: targetBatch.lastVertex,
				});
				redoStack.length = 0;
			}
			strokeCount += 1;
			activeStroke.vertexCount = 0;
			activeStroke.committedPoints = 0;
		}
		currentPoints = [];
		needsRender = false;
		renderScene();
	}

	function undo() {
		if (isDrawing || undoStack.length === 0) return;
		const entry = undoStack.pop()!;
		const batch = batches[entry.brush];
		if (batch) {
			batch.vertexCount = entry.prevVertexCount;
			batch.lastVertex = entry.prevLastVertex;
		}
		redoStack.push(entry);
		strokeCount = Math.max(0, strokeCount - 1);
		renderScene();
	}

	function redo() {
		if (isDrawing || redoStack.length === 0) return;
		const entry = redoStack.pop()!;
		const batch = batches[entry.brush];
		if (batch) {
			batch.vertexCount = entry.nextVertexCount;
			batch.lastVertex = entry.nextLastVertex;
		}
		undoStack.push(entry);
		strokeCount += 1;
		renderScene();
	}
	function resetCamera() {
		camera = { x: 0, y: 0, zoom: 2 };
		requestRender();
	}

	function clearCanvas() {
		for (const batch of [batches.pen, batches.mouse]) {
			if (!batch) continue;
			batch.vertexCount = 0;
			batch.lastVertex = null;
		}
		if (activeStroke) {
			activeStroke.vertexCount = 0;
			activeStroke.committedPoints = 0;
		}
		strokeCount = 0;
		currentPoints = [];
		camera = { x: 0, y: 0, zoom: 2 };

		undoStack.length = 0;
		redoStack.length = 0;
		renderScene();
	}

	async function closeOverlay() {
		if (performance.now() - openedAt < 150) return;
		if (!isInteractive) return;
		if (isDrawing) finishStroke();
		isInteractive = false;
		isPanning = false;
		await commands.setOverlayInteractive(false);
	}

	// =========================================================================
	// 9. INPUT HANDLERS
	// =========================================================================
	function handlePointerDown(e: PointerEvent) {
		updateTelemetry(e, true);
		if (!canvasEl) return;
		canvasEl.setPointerCapture(e.pointerId);

		if (e.button === 2 || e.buttons === 2 || e.button === 1) {
			if (isDrawing) finishStroke();
			isPanning = true;
			panStart = { x: e.clientX - camera.x, y: e.clientY - camera.y };
			return;
		}

		if (e.button === 0) {
			isDrawing = true;
			currentBrush = e.pointerType === "pen" ? "pen" : "mouse";
			const startPt = screenToWorld(e.clientX, e.clientY);
			currentPoints = [{ ...startPt, halfWidth: calcHalfWidth(e) }];
			requestRender();
		}
	}

	function handlePointerMove(e: PointerEvent) {
		updateTelemetry(e);

		if (isPanning) {
			camera.x = e.clientX - panStart.x;
			camera.y = e.clientY - panStart.y;
			requestRender();
			return;
		}

		if (!isDrawing) return;

		const coalesced = e.getCoalescedEvents?.();
		const eventsList = coalesced && coalesced.length > 0 ? coalesced : [e];
		const minDist = CONFIG.brush.minPointDistPx / camera.zoom;

		for (const pt of eventsList) {
			const worldPt = screenToWorld(pt.clientX, pt.clientY);
			const last = currentPoints[currentPoints.length - 1];
			if (
				!last ||
				Math.hypot(worldPt.x - last.x, worldPt.y - last.y) > minDist
			) {
				currentPoints.push({
					...worldPt,
					halfWidth: calcHalfWidth(pt, last?.halfWidth),
				});
			}
		}
		requestRender();
	}

	function handlePointerUp(e: PointerEvent) {
		updateTelemetry(e, true);
		if (isPanning) isPanning = false;
		if (isDrawing) finishStroke();
		if (canvasEl?.hasPointerCapture(e.pointerId)) {
			canvasEl.releasePointerCapture(e.pointerId);
		}
	}

	function handleWheel(e: WheelEvent) {
		e.preventDefault();

		if (e.ctrlKey) {
			const { min, max } = CONFIG.zoom;
			const zoomFactor = Math.exp(-e.deltaY * 0.01);
			const newZoom = Math.min(
				Math.max(camera.zoom * zoomFactor, min),
				max,
			);

			if (newZoom === camera.zoom) return;

			const ratio = newZoom / camera.zoom;
			camera.x = e.clientX - (e.clientX - camera.x) * ratio;
			camera.y = e.clientY - (e.clientY - camera.y) * ratio;
			camera.zoom = newZoom;
			requestRender();
			return;
		}

		camera.x -= e.deltaX;
		camera.y -= e.deltaY;
		requestRender();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (!isInteractive) return;

		if (e.ctrlKey || e.metaKey) {
			const key = e.key.toLowerCase();
			if (key === "z") {
				e.preventDefault();
				e.shiftKey ? redo() : undo();
				return;
			}
			if (key === "y") {
				e.preventDefault();
				redo();
				return;
			}
			return;
		}

		if (e.altKey) return;

		switch (e.key.toLowerCase()) {
			case "escape":
				closeOverlay();
				break;
			case "c":
				clearCanvas();
				break;
			case "h":
				showTelemetry = !showTelemetry;
				break;
			case "r":
				resetCamera();
				break;
		}
	}

	// =========================================================================
	// 10. LIFECYCLE
	// =========================================================================
	onMount(() => {
		initWebGL();
		const unlisten = events.overlayModeEvent.listen((event) => {
			isInteractive = event.payload;
			if (isInteractive) {
				openedAt = performance.now();
				renderScene();
			}
		});

		return () => {
			unlisten.then((fn) => fn());
			if (rafId) cancelAnimationFrame(rafId);
			destroyWebGL();
		};
	});
</script>

<svelte:window
	onblur={closeOverlay}
	onkeydown={handleKeydown}
	onresize={resizeCanvas}
/>

<main
	oncontextmenu={(e) => e.preventDefault()}
	class="w-screen h-screen overflow-hidden select-none"
>
	<div
		class="fixed inset-0 bg-zinc-950/75 transition-opacity duration-75 {isInteractive
			? 'opacity-100 pointer-events-auto'
			: 'opacity-0 pointer-events-none'}"
	>
		{#if showTelemetry}
			<div
				class="fixed top-4 left-4 z-20 w-76 p-3.5 rounded-2xl bg-zinc-900/95 border border-white/15 text-xs text-zinc-200 shadow-2xl pointer-events-none font-mono tabular-nums space-y-2.5"
			>
				<div
					class="flex items-center justify-between border-b border-white/10 pb-2"
				>
					<span class="font-sans font-semibold text-zinc-300"
						>WebGL2 Telemetry</span
					>
					<span
						class="px-2 py-0.5 rounded font-bold {telemetry.pointerType ===
						'pen'
							? 'bg-emerald-500/20 text-emerald-400'
							: 'bg-amber-500/20 text-amber-300'}"
					>
						{telemetry.pointerType}
					</span>
				</div>

				<div class="grid grid-cols-2 gap-x-4 gap-y-1">
					<div class="flex justify-between">
						<span class="text-zinc-400">clientX:</span>
						<span>{telemetry.clientX}</span>
					</div>
					<div class="flex justify-between">
						<span class="text-zinc-400">clientY:</span>
						<span>{telemetry.clientY}</span>
					</div>
					<div class="flex justify-between">
						<span class="text-zinc-400">pressure:</span>
						<span class="text-emerald-400"
							>{telemetry.pressure}</span
						>
					</div>
					<div class="flex justify-between">
						<span class="text-zinc-400">buttons:</span>
						<span class="text-sky-400">{telemetry.buttons}</span>
					</div>
					<div class="flex justify-between">
						<span class="text-zinc-400">tiltX:</span>
						<span>{telemetry.tiltX}°</span>
					</div>
					<div class="flex justify-between">
						<span class="text-zinc-400">button:</span>
						<span class="text-sky-400">{telemetry.button}</span>
					</div>
					<div class="flex justify-between">
						<span class="text-zinc-400">tiltY:</span>
						<span>{telemetry.tiltY}°</span>
					</div>
					<div class="flex justify-between">
						<span class="text-zinc-400">strokes:</span>
						<span class="text-zinc-100">{strokeCount}</span>
					</div>
					<div class="flex justify-between">
						<span class="text-zinc-400">pan:</span>
						<span class="text-purple-400"
							>{Math.round(camera.x)},{Math.round(camera.y)}</span
						>
					</div>
					<div class="flex justify-between">
						<span class="text-zinc-400">zoom:</span>
						<span class="text-purple-400"
							>{Math.round(camera.zoom * 100)}%</span
						>
					</div>
				</div>

				<div
					class="border-t border-white/10 pt-2 flex justify-between font-sans text-[11px] text-zinc-400"
				>
					<span
						><kbd
							class="bg-white/10 px-1.5 py-0.5 rounded text-zinc-200"
							>C</kbd
						> Clear</span
					>
					<span
						><kbd
							class="bg-white/10 px-1.5 py-0.5 rounded text-zinc-200"
							>R</kbd
						> Reset</span
					>
					<span
						><kbd
							class="bg-white/10 px-1.5 py-0.5 rounded text-zinc-200"
							>H</kbd
						> HUD</span
					>
					<span
						><kbd
							class="bg-white/10 px-1.5 py-0.5 rounded text-zinc-200"
							>Esc</kbd
						> Quit</span
					>
				</div>
			</div>
		{/if}

		<canvas
			bind:this={canvasEl}
			onpointerdown={handlePointerDown}
			onpointermove={handlePointerMove}
			onpointerup={handlePointerUp}
			onpointercancel={handlePointerUp}
			onwheel={handleWheel}
			class="fixed inset-0 w-full h-full touch-none {isPanning
				? 'cursor-grabbing'
				: 'cursor-crosshair'}"
		></canvas>
	</div>
</main>
