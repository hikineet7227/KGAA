import type { ContextPulse } from "$lib/bindings";

export type RGBA = [number, number, number, number];
export type ToolMode = "draw" | "lasso" | "interact";

export interface Vec2 {
	x: number;
	y: number;
}

export interface BBox {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

export interface Camera {
	x: number;
	y: number;
	zoom: number;
}

export interface StrokePoint extends Vec2 {
	halfWidth: number;
}

export interface StrokeItem {
	id: string;
	kind: "stroke";
	points: Float32Array;
	color: RGBA;
	bbox: BBox;
	offsetX: number;
	offsetY: number;
}

export interface SnippetItem {
	id: string;
	kind: "snippet";
	x: number;
	y: number;
	width?: number;
	height?: number;
	pulse: ContextPulse;
}

export interface ActiveStroke {
	buffer: WebGLBuffer;
	cpuData: Float32Array;
	capacityVertices: number;
	vertexCount: number;
	committedPoints: number;
	color: RGBA;
}

export interface RadialMenuState {
	open: boolean;
	x: number;
	y: number;
	targetCardId: string | null;
}
