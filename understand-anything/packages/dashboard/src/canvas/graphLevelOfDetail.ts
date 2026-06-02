export interface GraphLevelOfDetail {
  showLabels: boolean;
  showEdges: boolean;
  showEdgeLabels: boolean;
  nodeRadius: number;
  edgeAlpha: number;
  labelLimit: number;
}

const LOW_ZOOM_LOD: GraphLevelOfDetail = {
  showLabels: false,
  showEdges: false,
  showEdgeLabels: false,
  nodeRadius: 3,
  edgeAlpha: 0,
  labelLimit: 0,
};

const MID_ZOOM_LOD: GraphLevelOfDetail = {
  showLabels: false,
  showEdges: true,
  showEdgeLabels: false,
  nodeRadius: 5,
  edgeAlpha: 0.22,
  labelLimit: 0,
};

const HIGH_ZOOM_LOD: GraphLevelOfDetail = {
  showLabels: true,
  showEdges: true,
  showEdgeLabels: false,
  nodeRadius: 6,
  edgeAlpha: 0.32,
  labelLimit: 80,
};

const DETAIL_ZOOM_LOD: GraphLevelOfDetail = {
  showLabels: true,
  showEdges: true,
  showEdgeLabels: true,
  nodeRadius: 7,
  edgeAlpha: 0.45,
  labelLimit: 200,
};

export function getGraphLevelOfDetail(zoom: number): GraphLevelOfDetail {
  const normalizedZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 0;

  if (normalizedZoom < 0.3) return LOW_ZOOM_LOD;
  if (normalizedZoom < 1.1) return MID_ZOOM_LOD;
  if (normalizedZoom < 1.35) return HIGH_ZOOM_LOD;
  return DETAIL_ZOOM_LOD;
}
