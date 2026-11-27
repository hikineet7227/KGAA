import type {
	BBox,
	Camera,
	RGBA,
	StrokePoint,
	Vec2,
} from "$lib/components/types/workspace";

export const PEN_PALETTE: { name: string; hex: string; rgba: RGBA }[] = [
	{ name: "Emerald", hex: "#34d399", rgba: [0.204, 0.827, 0.6, 1.0] },
	{ name: "Amber", hex: "#fbbf24", rgba: [0.984, 0.749, 0.141, 1.0] },
	{ name: "Sky", hex: "#38bdf8", rgba: [0.22, 0.741, 0.973, 1.0] },
	{ name: "Rose", hex: "#fb7185", rgba: [0.984, 0.443, 0.522, 1.0] },
];

export const CONFIG = {
	zoom: {
		min: 0.5,
		max: 2.5,
	},
	brush: {
		penMinHalfWidth: 1.6,
		penMaxHalfWidth: 5.2,
		deadzone: 0.12,
		pressureExponent: 1.25,
		widthSmoothing: 0.25,
		minPointDistPx: 2.4,
	},
	colors: {
		pen: PEN_PALETTE[0].rgba,
		selected: [1.0, 1.0, 1.0, 0.95] as RGBA,
	},
	buffers: {
		activeInitialCapacity: 16384,
	},
} as const;

export const DEFAULT_CAMERA: Camera = { x: 0, y: 0, zoom: 1 };

export function screenToWorld(
	clientX: number,
	clientY: number,
	camera: Camera,
): Vec2 {
	return {
		x: (clientX - camera.x) / camera.zoom,
		y: (clientY - camera.y) / camera.zoom,
	};
}

export function calcPenHalfWidth(
	pressure: number,
	prevHalfWidth?: number,
): number {
	const {
		penMinHalfWidth,
		penMaxHalfWidth,
		deadzone,
		pressureExponent,
		widthSmoothing,
	} = CONFIG.brush;

	const cleanPressure = Math.max(0, (pressure - deadzone) / (1 - deadzone));
	const curved = cleanPressure ** pressureExponent;
	const targetHalf =
		penMinHalfWidth + (penMaxHalfWidth - penMinHalfWidth) * curved;

	return prevHalfWidth !== undefined
		? prevHalfWidth + (targetHalf - prevHalfWidth) * widthSmoothing
		: targetHalf;
}

export function computeFlatPointsBBox(flatPoints: Float32Array, pad = 6): BBox {
	if (flatPoints.length < 2) {
		return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
	}

	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;

	for (let i = 0; i < flatPoints.length; i += 2) {
		const x = flatPoints[i];
		const y = flatPoints[i + 1];
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
	}

	return {
		minX: minX - pad,
		minY: minY - pad,
		maxX: maxX + pad,
		maxY: maxY + pad,
	};
}

export function computePointsBBox(
	points: Vec2[] | StrokePoint[],
	pad = 4,
): BBox {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;

	for (const p of points) {
		if (p.x < minX) minX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.x > maxX) maxX = p.x;
		if (p.y > maxY) maxY = p.y;
	}

	return {
		minX: minX - pad,
		minY: minY - pad,
		maxX: maxX + pad,
		maxY: maxY + pad,
	};
}

export function bboxIntersects(a: BBox, b: BBox): boolean {
	return !(
		a.maxX < b.minX ||
		a.minX > b.maxX ||
		a.maxY < b.minY ||
		a.minY > b.maxY
	);
}

/** Ray-casting point-in-polygon O(N) */
export function pointInPolygon(pt: Vec2, polygon: Vec2[]): boolean {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const xi = polygon[i].x;
		const yi = polygon[i].y;
		const xj = polygon[j].x;
		const yj = polygon[j].y;

		const intersect =
			yi > pt.y !== yj > pt.y &&
			pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi + 1e-9) + xi;
		if (intersect) inside = !inside;
	}
	return inside;
}

/** Kiểm tra hình chữ nhật (thẻ) có nằm trong hoặc cắt đa giác Lasso không */
export function rectIntersectsPolygon(rect: BBox, polygon: Vec2[]): boolean {
	const cx = (rect.minX + rect.maxX) * 0.5;
	const cy = (rect.minY + rect.maxY) * 0.5;
	if (pointInPolygon({ x: cx, y: cy }, polygon)) return true;

	const corners: Vec2[] = [
		{ x: rect.minX, y: rect.minY },
		{ x: rect.maxX, y: rect.minY },
		{ x: rect.maxX, y: rect.maxY },
		{ x: rect.minX, y: rect.maxY },
	];
	for (const c of corners) {
		if (pointInPolygon(c, polygon)) return true;
	}

	// Hoặc có đỉnh nào của đa giác nằm lọt vào trong thẻ
	for (const p of polygon) {
		if (
			p.x >= rect.minX &&
			p.x <= rect.maxX &&
			p.y >= rect.minY &&
			p.y <= rect.maxY
		) {
			return true;
		}
	}
	return false;
}
