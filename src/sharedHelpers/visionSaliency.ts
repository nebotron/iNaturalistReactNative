/**
 * Shared contract for saliency map output. Aligns with the Python package
 * `inat_vision_saliency.pipeline.SaliencyResult` (see `tools/inat_vision_saliency/`).
 *
 * A future native implementation (Kotlin / Swift) can fill this shape from
 * on-device ONNX or a server response so the React Native UI stays agnostic.
 */
export type VisionSaliencyResult = {
  /** Row-major 299×299; gradient magnitude per pixel (aggregated over RGB). */
  saliencyMagnitude299: Float32Array;
  /** Model leaf index (`leaf_class_id` in taxonomy.csv). */
  classIndex: number;
  topProbability: number;
  /** Softmax vector; length = number of leaf classes (507 for INatVision_Small_2). */
  probabilities: Float32Array;
  /** Row-major 299×299×3, RGB 0–255 (model input after resize). */
  rgbInputU8: Uint8ClampedArray;
  /**
   * Inclusive pixel bounds (x0, y0, x1, y1) of the smallest square covering high-saliency
   * pixels (same convention as Python `SaliencyResult.bbox_square_xyxy`).
   */
  bboxSquareXyxy: readonly [number, number, number, number] | null;
};

/** Bump when the wire format or semantics of `VisionSaliencyResult` change. */
export const VISION_SALIENCY_SPEC_VERSION = 1;

/** Repo-relative path to the Python tool + package (see INTEGRATION.md there). */
export const VISION_SALIENCY_TOOL_DIR = "tools/inat_vision_saliency";

/**
 * Dev / CI command to run the standalone Python CLI via npm (cross-platform).
 * Requires Python deps (`pip install -e tools/inat_vision_saliency` or `requirements.txt`).
 */
export const getVisionSaliencyStandaloneCommand = ( imagePath: string ): string => (
  `npm run vision-saliency -- ${JSON.stringify( imagePath )}`
);
