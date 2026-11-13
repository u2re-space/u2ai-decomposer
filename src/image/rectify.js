/**
 * @file src/image/rectify.js
 * @module image/rectify
 * @purpose The rectify surface of the image layer: a projective warp of a quad and the measurement
 *          of the tilt that is left in the result.
 *
 *   The two halves belong together because they answer the same question from opposite ends: the
 *   warp removes the perspective the corners describe, and the measurement tells the caller what
 *   is actually left in the pixels. A warp without the measurement leaves the caller to infer the
 *   result from the corners it typed in — which is exactly the inference that is wrong.
 *
 * @depends image/distort, image/skew
 * @usedBy agent/tools (correct_perspective), stages/rectify
 * @exports perspectiveRectify, measureResidualSkew, quadToRect, solveQuadError, CORNER_ORDER
 * @ai.tags images, perspective, rectify, skew
 * @ai.hint io
 */

export {
    perspectiveRectify,
    quadToRect,
    solveQuadError,
    solveHomography,
    CORNER_ORDER,
} from './distort.js';

export {
    measureResidualSkew,
    measureResidualSkewFromBytes,
} from './skew.js';
