import type { ContextPulse } from "$lib/bindings";
import {
	bboxIntersects,
	computeFlatPointsBBox,
	computePointsBBox,
	DEFAULT_CAMERA,
	PEN_PALETTE,
	pointInPolygon,
	rectIntersectsPolygon,
	screenToWorld,
} from "$lib/engine/geometry";
import type {
	BBox,
	Camera,
	RadialMenuState,
	RGBA,
	SnippetItem,
	StrokeItem,
	StrokePoint,
	ToolMode,
	Vec2,
} from "../components/types/workspace";

const DEFAULT_CARD_W = 320;
const DEFAULT_CARD_H = 180;

class WorkspaceState {
	isInteractive = $state(false);
	showHud = $state(true);
	isPanning = $state(false);
	activeTool = $state<ToolMode>("draw");
	penColor = $state<RGBA>(PEN_PALETTE[0].rgba);

	camera = $state<Camera>({ ...DEFAULT_CAMERA });
	items = $state<SnippetItem[]>([]);
	strokes = $state<StrokeItem[]>([]);

	selectedIds = $state<Set<string>>(new Set());
	lassoPoints = $state<Vec2[]>([]);
	radialMenu = $state<RadialMenuState>({
		open: false,
		x: 0,
		y: 0,
		targetCardId: null,
	});

	get strokeCount() {
		return this.strokes.length;
	}

	get selectionBBox(): BBox | null {
		if (this.selectedIds.size === 0) return null;
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		let found = false;

		for (const item of this.items) {
			if (!this.selectedIds.has(item.id)) continue;
			found = true;
			const w = item.width ?? DEFAULT_CARD_W;
			const h = item.height ?? DEFAULT_CARD_H;
			if (item.x < minX) minX = item.x;
			if (item.y < minY) minY = item.y;
			if (item.x + w > maxX) maxX = item.x + w;
			if (item.y + h > maxY) maxY = item.y + h;
		}

		for (const stroke of this.strokes) {
			if (!this.selectedIds.has(stroke.id)) continue;
			found = true;
			const x0 = stroke.bbox.minX + stroke.offsetX;
			const y0 = stroke.bbox.minY + stroke.offsetY;
			const x1 = stroke.bbox.maxX + stroke.offsetX;
			const y1 = stroke.bbox.maxY + stroke.offsetY;
			if (x0 < minX) minX = x0;
			if (y0 < minY) minY = y0;
			if (x1 > maxX) maxX = x1;
			if (y1 > maxY) maxY = y1;
		}

		return found ? { minX, minY, maxX, maxY } : null;
	}

	resetCamera() {
		this.camera = { ...DEFAULT_CAMERA };
	}

	openRadialMenu(x: number, y: number, targetCardId: string | null = null) {
		this.radialMenu = { open: true, x, y, targetCardId };
	}

	closeRadialMenu() {
		if (this.radialMenu.open) {
			this.radialMenu = { ...this.radialMenu, open: false, targetCardId: null };
		}
	}

	addContextPulse(pulse: ContextPulse) {
		const centerScreenX = window.innerWidth * 0.5 - 160;
		const centerScreenY = window.innerHeight * 0.35;
		const worldPos = screenToWorld(centerScreenX, centerScreenY, this.camera);
		const cascade = (this.items.length % 6) * 24;

		this.items.push({
			id: crypto.randomUUID(),
			kind: "snippet",
			x: worldPos.x + cascade,
			y: worldPos.y + cascade,
			pulse,
		});
	}

	addStroke(id: string, points: StrokePoint[], color: RGBA) {
		const flatPoints = new Float32Array(points.length * 2);
		for (let i = 0; i < points.length; i++) {
			flatPoints[i * 2] = points[i].x;
			flatPoints[i * 2 + 1] = points[i].y;
		}

		this.strokes.push({
			id,
			kind: "stroke",
			points: flatPoints,
			color,
			bbox: computeFlatPointsBBox(flatPoints, 6),
			offsetX: 0,
			offsetY: 0,
		});
	}

	bringToFront(id: string) {
		const idx = this.items.findIndex((it) => it.id === id);
		if (idx !== -1 && idx !== this.items.length - 1) {
			const [item] = this.items.splice(idx, 1);
			this.items.push(item);
		}
	}

	moveItem(id: string, x: number, y: number) {
		const item = this.items.find((it) => it.id === id);
		if (item) {
			item.x = x;
			item.y = y;
		}
	}

	/** Di chuyển đồng bộ toàn bộ thẻ và nét mực đang chọn */
	moveSelectionBy(dx: number, dy: number) {
		for (const item of this.items) {
			if (this.selectedIds.has(item.id)) {
				item.x += dx;
				item.y += dy;
			}
		}
		for (const stroke of this.strokes) {
			if (this.selectedIds.has(stroke.id)) {
				stroke.offsetX += dx;
				stroke.offsetY += dy;
			}
		}
	}

	clearSelection() {
		if (this.selectedIds.size > 0) {
			this.selectedIds = new Set();
		}
	}

	/** Khoanh Lasso: lọc thô bằng AABB rồi kiểm tra đa giác chi tiết */
	selectByLasso(polygon: Vec2[]) {
		if (polygon.length < 3) {
			this.clearSelection();
			return;
		}
		const lassoBBox = computePointsBBox(polygon, 0);
		const nextSelected = new Set<string>();

		for (const item of this.items) {
			const rect: BBox = {
				minX: item.x,
				minY: item.y,
				maxX: item.x + (item.width ?? DEFAULT_CARD_W),
				maxY: item.y + (item.height ?? DEFAULT_CARD_H),
			};
			if (
				bboxIntersects(rect, lassoBBox) &&
				rectIntersectsPolygon(rect, polygon)
			) {
				nextSelected.add(item.id);
			}
		}

		for (const stroke of this.strokes) {
			const sBBox: BBox = {
				minX: stroke.bbox.minX + stroke.offsetX,
				minY: stroke.bbox.minY + stroke.offsetY,
				maxX: stroke.bbox.maxX + stroke.offsetX,
				maxY: stroke.bbox.maxY + stroke.offsetY,
			};
			if (!bboxIntersects(sBBox, lassoBBox)) continue;

			const pointCount = stroke.points.length >> 1;
			const stride = pointCount > 40 ? 4 : 2;
			for (let i = 0; i < stroke.points.length; i += stride) {
				if (
					pointInPolygon(
						{
							x: stroke.points[i] + stroke.offsetX,
							y: stroke.points[i + 1] + stroke.offsetY,
						},
						polygon,
					)
				) {
					nextSelected.add(stroke.id);
					break;
				}
			}
		}

		this.selectedIds = nextSelected;
	}

	deleteSelection() {
		if (this.selectedIds.size === 0) return;
		this.items = this.items.filter((it) => !this.selectedIds.has(it.id));
		this.strokes = this.strokes.filter((st) => !this.selectedIds.has(st.id));
		this.selectedIds = new Set();
	}

	removeItem(id: string) {
		this.items = this.items.filter((it) => it.id !== id);
		if (this.selectedIds.has(id)) {
			const next = new Set(this.selectedIds);
			next.delete(id);
			this.selectedIds = next;
		}
	}

	clearStrokes() {
		const strokeIds = new Set(this.strokes.map((s) => s.id));
		this.strokes = [];
		if (this.selectedIds.size > 0) {
			const next = new Set(this.selectedIds);
			for (const id of strokeIds) next.delete(id);
			this.selectedIds = next;
		}
	}

	clearItems() {
		this.items = [];
		this.selectedIds = new Set();
	}
}

export const workspace = new WorkspaceState();
