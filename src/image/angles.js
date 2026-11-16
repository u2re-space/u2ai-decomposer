/**
 * @file src/image/angles.js
 * @module image/angles
 * @purpose The angles of a picture in degrees: how far it is turned, how far it is sheared and how
 *          far its sides converge.
 *
 *   A rectifier that says "the picture is a bit tilted" has said nothing that can be checked.
 *   Degrees can: a tilt of 2.4° and a tilt of 0.2° are two different pictures, and only one of
 *   them needs another attempt. So every number here is an angle in degrees, and the sign is the
 *   one of the picture itself: positive means the content runs downhill to the right, that is,
 *   clockwise on the screen.
 *
 *   Two shapes are measured: the quad of four corners (the cut of a screen out of a picture) and
 *   the linear part of a matrix (the correction of a whole picture). Both answer the same three
 *   questions — the rotation, the shear and the squeeze of the perspective.
 *
 * @depends none
 * @usedBy image/distort, image/matrix, stages/rectify
 * @exports quadAngles, matrixAngles, ANGLE_EPSILON
 * @ai.tags images, angles, degrees, skew, rotation
 * @ai.hint pure
 */

/** The angles below this size are the same angle for the purpose of the house. */
export const ANGLE_EPSILON = 0.05;

/**
 * The angle of a vector, in degrees, clockwise positive.
 * @param {number} dx
 * @param {number} dy
 * @returns {number}
 * @ai.hint pure
 */
function vectorAngle(dx, dy) {
    return (Math.atan2(dy, dx) * 180) / Math.PI;
}

/**
 * The angle of a vertical vector away from the straight down, in degrees.
 *
 * The vector from the top corner to the bottom corner of a screen points down, so the tilt of the
 * edge away from the vertical is the angle between the vector and (0, 1). It is positive when the
 * bottom of the edge is to the right of its top.
 * @param {number} dx
 * @param {number} dy
 * @returns {number}
 * @ai.hint pure
 */
function tiltFromVertical(dx, dy) {
    return (Math.atan2(dx, dy) * 180) / Math.PI;
}

/**
 * The mean of two angles, without the seam at 180°.
 * @param {number} a
 * @param {number} b
 * @returns {number}
 * @ai.hint pure
 */
function meanAngle(a, b) {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const rad = Math.atan2(
        Math.sin(toRad(a)) + Math.sin(toRad(b)),
        Math.cos(toRad(a)) + Math.cos(toRad(b)),
    );
    return (rad * 180) / Math.PI;
}

/**
 * The difference of two angles, brought into (-180, 180].
 * @param {number} a
 * @param {number} b
 * @returns {number}
 * @ai.hint pure
 */
function angleDifference(a, b) {
    let diff = (a - b) % 360;
    if (diff > 180) diff -= 360;
    if (diff <= -180) diff += 360;
    return diff;
}

/**
 * A number with three decimals: the report of an angle is read by a person, not by a machine.
 * @param {number} value
 * @returns {number}
 * @ai.hint pure
 */
function round3(value) {
    return Number(value.toFixed(3));
}

/**
 * The angles of a quad, in degrees.
 *
 * The quad is the four corners of a screen in the order of the projection: top-left, top-right,
 * bottom-left, bottom-right. The three numbers that matter are:
 *
 *   - `rotation` — the turn of the picture: the mean tilt of the two horizontal edges. It is the
 *     angle a rotation of the picture would have to undo.
 *   - `skew` — the shear: how far the two horizontal edges disagree. A rectangle has none; a
 *     picture that was dragged sideways has some.
 *   - `keystone` — the squeeze of the perspective: how far the two vertical edges disagree. It is
 *     the number that says "this was photographed at an angle".
 *
 * @param {Array<{x:number,y:number}>} quad four points in CORNER_ORDER
 * @returns {{ rotation: number, skew: number, keystone: number, top: number, bottom: number,
 *   left: number, right: number }|null} null when the quad is not four usable points
 * @exports
 * @ai.hint pure
 */
export function quadAngles(quad) {
    if (!Array.isArray(quad) || quad.length !== 4) return null;
    if (quad.some((point) => !point
        || !Number.isFinite(point.x)
        || !Number.isFinite(point.y))) return null;

    const [tl, tr, bl, br] = quad;
    const top = vectorAngle(tr.x - tl.x, tr.y - tl.y);
    const bottom = vectorAngle(br.x - bl.x, br.y - bl.y);
    const left = tiltFromVertical(bl.x - tl.x, bl.y - tl.y);
    const right = tiltFromVertical(br.x - tr.x, br.y - tr.y);

    return {
        rotation: round3(meanAngle(top, bottom)),
        skew: round3(Math.abs(angleDifference(top, bottom))),
        keystone: round3(Math.abs(angleDifference(left, right))),
        top: round3(top),
        bottom: round3(bottom),
        left: round3(left),
        right: round3(right),
    };
}

/**
 * Read a matrix as three rows of three numbers.
 * @param {number[][]|number[]} matrix
 * @returns {number[][]|null}
 * @ai.hint pure
 */
function rowsOf3(matrix) {
    if (Array.isArray(matrix) && matrix.length === 3 && matrix.every((row) => Array.isArray(row))) {
        const rows = matrix.map((row) => row.map(Number));
        if (rows.every((row) => row.length === 3 && row.every((value) => Number.isFinite(value)))) return rows;
    }
    if (Array.isArray(matrix) && matrix.length === 9 && matrix.every((value) => Number.isFinite(Number(value)))) {
        const values = matrix.map(Number);
        return [
            [values[0], values[1], values[2]],
            [values[3], values[4], values[5]],
            [values[6], values[7], values[8]],
        ];
    }
    return null;
}

/**
 * The angles of a matrix, in degrees.
 *
 * The matrix carries a projective correction, and the part of it that turns and shears the
 * picture is its linear part: the first two rows and the first two columns. The rotation is the
 * turn of that part, the skew is how far the two axes of it are from being perpendicular, and the
 * two scales say how much the picture grows along each axis.
 *
 * @param {number[][]|number[]} matrix a 3×3 homography, row major
 * @returns {{ rotation: number, skew: number, scaleX: number, scaleY: number }|null}
 *   null when the matrix cannot be read or is degenerate
 * @exports
 * @ai.hint pure
 */
export function matrixAngles(matrix) {
    const h = rowsOf3(matrix);
    if (!h) return null;
    const [a, b] = h[0];
    const [c, d] = h[1];
    const scaleX = Math.hypot(a, c);
    const scaleY = Math.hypot(b, d);
    if (!scaleX || !scaleY) return null;
    const cos = Math.max(-1, Math.min(1, (a * b + c * d) / (scaleX * scaleY)));
    // The angle between the two axes of the linear part: 90° when they are perpendicular.
    const between = (Math.acos(cos) * 180) / Math.PI;
    return {
        rotation: round3((Math.atan2(c, a) * 180) / Math.PI),
        skew: round3(90 - between),
        scaleX: round3(scaleX),
        scaleY: round3(scaleY),
    };
}
