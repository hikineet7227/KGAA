/** biome-ignore-all lint/style/noNonNullAssertion: <> */
import { bboxIntersects, CONFIG } from "$lib/engine/geometry";
import type {
	ActiveStroke,
	BBox,
	Camera,
	RGBA,
	StrokeItem,
	StrokePoint,
} from "../components/types/workspace";

const VS_SOURCE = `#version 300 es
	in vec3 a_position;
	uniform mat3 u_matrix;
	uniform vec2 u_offset;
	out float v_side;

	void main() {
		v_side = a_position.z;
		vec2 worldPos = a_position.xy + u_offset;
		vec3 clipSpace = u_matrix * vec3(worldPos, 1.0);
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

interface CachedStrokeGPU {
	buffer: WebGLBuffer;
	vertexCount: number;
}

export class InkRenderer {
	private canvas: HTMLCanvasElement | null = null;
	private gl: WebGL2RenderingContext | null = null;
	private program: WebGLProgram | null = null;
	private uMatrixLoc: WebGLUniformLocation | null = null;
	private uOffsetLoc: WebGLUniformLocation | null = null;
	private uColorLoc: WebGLUniformLocation | null = null;
	private aPosLoc = -1;

	private activeStroke: ActiveStroke | null = null;
	private strokeCache = new Map<string, CachedStrokeGPU>();
	private viewMatrix = new Float32Array(9);

	init(canvas: HTMLCanvasElement) {
		this.canvas = canvas;
		const gl = canvas.getContext("webgl2", {
			alpha: true,
			antialias: true,
			premultipliedAlpha: true,
		});
		if (!gl) return;
		this.gl = gl;

		const vs = this.compileShader(gl, gl.VERTEX_SHADER, VS_SOURCE);
		const fs = this.compileShader(gl, gl.FRAGMENT_SHADER, FS_SOURCE);
		if (!vs || !fs) return;

		const program = gl.createProgram()!;
		gl.attachShader(program, vs);
		gl.attachShader(program, fs);
		gl.linkProgram(program);
		gl.deleteShader(vs);
		gl.deleteShader(fs);
		this.program = program;

		this.uMatrixLoc = gl.getUniformLocation(program, "u_matrix");
		this.uOffsetLoc = gl.getUniformLocation(program, "u_offset");
		this.uColorLoc = gl.getUniformLocation(program, "u_color");
		this.aPosLoc = gl.getAttribLocation(program, "a_position");

		gl.useProgram(program);
		gl.enableVertexAttribArray(this.aPosLoc);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

		this.activeStroke = this.createActiveStroke(gl);
	}

	destroy() {
		const gl = this.gl;
		if (!gl) return;
		for (const cached of this.strokeCache.values()) {
			gl.deleteBuffer(cached.buffer);
		}
		this.strokeCache.clear();
		if (this.activeStroke) gl.deleteBuffer(this.activeStroke.buffer);
		if (this.program) gl.deleteProgram(this.program);
		this.gl = null;
		this.canvas = null;
	}

	resize(width: number, height: number, dpr: number) {
		if (!this.canvas) return;
		this.canvas.width = Math.round(width * dpr);
		this.canvas.height = Math.round(height * dpr);
		if (this.gl) {
			this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
		}
	}

	setActiveColor(color: RGBA) {
		if (this.activeStroke) {
			this.activeStroke.color = color;
		}
	}

	updateActiveStroke(points: StrokePoint[]) {
		const gl = this.gl;
		const active = this.activeStroke;
		if (!gl || !active || points.length === 0) return;

		if (points.length === 1) {
			const { x, y, halfWidth: hw } = points[0];
			const d = active.cpuData;
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

			active.vertexCount = 4;
			active.committedPoints = 0;

			gl.bindBuffer(gl.ARRAY_BUFFER, active.buffer);
			gl.bufferSubData(gl.ARRAY_BUFFER, 0, d.subarray(0, 12));
			return;
		}

		const requiredVertices = points.length * 2;
		if (requiredVertices > active.capacityVertices) {
			const newCapacity = Math.max(
				active.capacityVertices * 2,
				requiredVertices + 4096,
			);
			const committedFloats = active.committedPoints * 6;
			const newCpuData = new Float32Array(newCapacity * 3);
			newCpuData.set(active.cpuData.subarray(0, committedFloats));

			const newBuffer = gl.createBuffer()!;
			gl.bindBuffer(gl.ARRAY_BUFFER, newBuffer);
			gl.bufferData(gl.ARRAY_BUFFER, newCapacity * 3 * 4, gl.DYNAMIC_DRAW);
			gl.bufferSubData(
				gl.ARRAY_BUFFER,
				0,
				newCpuData.subarray(0, committedFloats),
			);

			gl.deleteBuffer(active.buffer);
			active.buffer = newBuffer;
			active.cpuData = newCpuData;
			active.capacityVertices = newCapacity;
		}

		const startIdx = active.committedPoints;
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

			active.cpuData[ptr++] = curr.x + nx;
			active.cpuData[ptr++] = curr.y + ny;
			active.cpuData[ptr++] = -1;

			active.cpuData[ptr++] = curr.x - nx;
			active.cpuData[ptr++] = curr.y - ny;
			active.cpuData[ptr++] = 1;
		}

		active.vertexCount = requiredVertices;
		const startFloat = startIdx * 6;
		const endFloat = requiredVertices * 3;
		gl.bindBuffer(gl.ARRAY_BUFFER, active.buffer);
		gl.bufferSubData(
			gl.ARRAY_BUFFER,
			startFloat * 4,
			active.cpuData.subarray(startFloat, endFloat),
		);

		active.committedPoints = points.length - 1;
	}

	/** Đóng gói activeStroke thành VBO riêng gắn với stroke.id */
	commitActiveStroke(id: string): boolean {
		const gl = this.gl;
		const active = this.activeStroke;
		if (!gl || !active || active.vertexCount <= 0) return false;

		const verts = active.cpuData.subarray(0, active.vertexCount * 3);
		const buffer = gl.createBuffer()!;
		gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
		gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

		this.strokeCache.set(id, { buffer, vertexCount: active.vertexCount });

		active.vertexCount = 0;
		active.committedPoints = 0;
		return true;
	}

	/** Đồng bộ xóa các VBO không còn tồn tại trong danh sách strokes */
	pruneCache(activeIds: Set<string>) {
		const gl = this.gl;
		if (!gl) return;
		for (const [id, cached] of this.strokeCache.entries()) {
			if (!activeIds.has(id)) {
				gl.deleteBuffer(cached.buffer);
				this.strokeCache.delete(id);
			}
		}
	}

	clear() {
		const gl = this.gl;
		if (gl) {
			for (const cached of this.strokeCache.values()) {
				gl.deleteBuffer(cached.buffer);
			}
		}
		this.strokeCache.clear();
		if (this.activeStroke) {
			this.activeStroke.vertexCount = 0;
			this.activeStroke.committedPoints = 0;
		}
	}

	render(
		camera: Camera,
		viewportWidth: number,
		viewportHeight: number,
		strokes: StrokeItem[],
		selectedIds: Set<string>,
	) {
		const gl = this.gl;
		if (!gl || !this.program) return;

		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);

		const m = this.viewMatrix;
		m[0] = (2 * camera.zoom) / viewportWidth;
		m[1] = 0;
		m[2] = 0;
		m[3] = 0;
		m[4] = (-2 * camera.zoom) / viewportHeight;
		m[5] = 0;
		m[6] = (2 * camera.x) / viewportWidth - 1;
		m[7] = (-2 * camera.y) / viewportHeight + 1;
		m[8] = 1;

		gl.uniformMatrix3fv(this.uMatrixLoc, false, m);

		// Viewport Culling BBox theo hệ tọa độ World
		const viewBBox: BBox = {
			minX: -camera.x / camera.zoom,
			minY: -camera.y / camera.zoom,
			maxX: (viewportWidth - camera.x) / camera.zoom,
			maxY: (viewportHeight - camera.y) / camera.zoom,
		};

		for (const stroke of strokes) {
			const cached = this.strokeCache.get(stroke.id);
			if (!cached) continue;

			const shiftedBBox: BBox = {
				minX: stroke.bbox.minX + stroke.offsetX,
				minY: stroke.bbox.minY + stroke.offsetY,
				maxX: stroke.bbox.maxX + stroke.offsetX,
				maxY: stroke.bbox.maxY + stroke.offsetY,
			};
			if (!bboxIntersects(shiftedBBox, viewBBox)) continue;

			const isSelected = selectedIds.has(stroke.id);
			gl.uniform2f(this.uOffsetLoc, stroke.offsetX, stroke.offsetY);
			this.drawBuffer(
				cached.buffer,
				cached.vertexCount,
				isSelected ? CONFIG.colors.selected : stroke.color,
			);
		}

		if (this.activeStroke && this.activeStroke.vertexCount > 0) {
			gl.uniform2f(this.uOffsetLoc, 0, 0);
			this.drawBuffer(
				this.activeStroke.buffer,
				this.activeStroke.vertexCount,
				this.activeStroke.color,
			);
		}
	}

	private compileShader(
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

	private createActiveStroke(
		ctx: WebGL2RenderingContext,
		capacity = CONFIG.buffers.activeInitialCapacity,
	): ActiveStroke {
		const gl = this.gl!;
		const buffer = ctx.createBuffer()!;
		ctx.bindBuffer(gl.ARRAY_BUFFER, buffer);
		ctx.bufferData(gl.ARRAY_BUFFER, capacity * 3 * 4, gl.DYNAMIC_DRAW);
		return {
			buffer,
			cpuData: new Float32Array(capacity * 3),
			capacityVertices: capacity,
			vertexCount: 0,
			committedPoints: 0,
			color: CONFIG.colors.pen,
		};
	}

	private drawBuffer(buffer: WebGLBuffer, vertexCount: number, color: RGBA) {
		const gl = this.gl;
		if (!gl || vertexCount <= 0) return;
		gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
		gl.vertexAttribPointer(this.aPosLoc, 3, gl.FLOAT, false, 0, 0);
		gl.uniform4fv(this.uColorLoc, color);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, vertexCount);
	}
}
