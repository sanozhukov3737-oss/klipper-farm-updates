export interface FilamentSpoolDescriptor {
  id: string; material: string; color: string; grams: number; capacityGrams: number; diameterMM?: number;
  finish?: 'normal' | 'silk' | 'matte' | number; serial?: string; lot?: string; barcode?: string; ordinal?: number;
}
export interface SpoolView { yaw: number; pitch: number; roll: number; zoom: number }
export interface FilamentSpoolViewer {
  setSpool(spool: FilamentSpoolDescriptor): FilamentSpoolViewer;
  updateSpool(patch: Partial<FilamentSpoolDescriptor>): FilamentSpoolViewer;
  setView(view: Partial<SpoolView>): FilamentSpoolViewer;
  setMode(mode: 'card' | 'inspect'): FilamentSpoolViewer;
  resize(): void; captureThumbnail(size?: number): string; destroy(): void;
  getState(): { spool: FilamentSpoolDescriptor; view: SpoolView; mode: string; vertices: number; disposed: boolean; contextLost: boolean };
}
export function createFilamentSpool(canvas: HTMLCanvasElement, options: {
  spool: FilamentSpoolDescriptor; mode?: 'card' | 'inspect'; pixelRatioCap?: number; interactive?: boolean;
  releaseContextOnDestroy?: boolean; view?: Partial<SpoolView>; onError?: (error: Error) => void;
}): FilamentSpoolViewer;
