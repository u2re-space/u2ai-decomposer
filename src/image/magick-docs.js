/**
 * @file src/image/magick-docs.js
 * @module image/magick-docs
 * @purpose The manual of ImageMagick, written for a role that has to work a picture and does not
 *          speak ImageMagick.
 *
 *   The roles of the house know a few operators: crop, resize, project. But ImageMagick has
 *   hundreds of them, and a picture that a narrow tool cannot straighten is often straightened by
 *   `-deskew`, `-distort Perspective` or `-trim`. So the manual is given to the model instead of
 *   the handful of operators the harness knows.
 *
 *   The manual is a summary, not the manual of ImageMagick: it is the part a role needs to write a
 *   correct command line, and the addresses of the full manual are in it, for the model that wants
 *   to read more.
 *
 *   The numbers of the distort methods were measured on ImageMagick 7.1.2-34: how many control
 *   points each method wants and what it says when the number is wrong.
 *
 * @depends none
 * @usedBy agent/tools (magick_help)
 * @exports MAGICK_DOCS, MAGICK_DOC_URLS, MAGICK_DOC_TOPICS, magickDoc
 * @ai.tags imagemagick, documentation, tools
 * @ai.hint pure
 */

/** The addresses of the full manual. */
export const MAGICK_DOC_URLS = Object.freeze({
    usage: 'https://usage.imagemagick.org/',
    distorts: 'https://usage.imagemagick.org/distorts/',
    processing: 'https://imagemagick.org/command-line-processing/',
});

/** The topics of the manual. */
export const MAGICK_DOC_TOPICS = Object.freeze(['command-line', 'operators', 'distorts']);

const COMMAND_LINE = `The command line of ImageMagick 7:

  magick [settings] input-file [operators] [settings] output-file

- The word "magick" is the program. "convert" is the name ImageMagick 6 had; in ImageMagick 7 it
  is the Windows tool that converts a file system, not a picture.
- A setting is "-option value"; "+option" takes the setting away. A setting holds until it is
  changed, so it applies to every picture that follows it on the command line.
- An operator changes the picture: -crop, -resize, -distort. The operators are applied in the
  order they are written: the order is a part of the command.
- A geometry is "widthxheight{+-}x{+-}y". "100x100" is a size, "100x100+10+20" is a size with an
  offset, "-10-20" is an offset from the centre, "50%" is a share of the original, "100x100^"
  fills the box and cuts the overflow away, "100x100!" stretches and ignores the proportions.
- "( ... )" groups the settings that belong to the pictures inside the group:
  magick ( -size 100x100 xc:red ) out.png
- An argument with spaces is written in double quotes:
  magick in.png -crop "100x100+10+20" out.png
- The exit code is 0 when the picture was written; the errors are printed to stderr.
- magick -list option lists the operators of the installed version, magick -list distort lists the
  distort methods, magick -list format lists the formats that may be read and written.
- magick identify -format "%w %h %m\\n" in.png prints what a picture is without writing one.
- The full manual: ${MAGICK_DOC_URLS.processing}
  The manual of the operators: ${MAGICK_DOC_URLS.usage}`;

const OPERATORS = `The operators that matter for a reference picture:

Reading and writing
  -identify                  what the picture is
  -format "%w %h %m %[mean]" the fields of -identify
  -write file                write the picture and go on with it
  -strip                     throw the profiles and the comments away
  -verbose                   everything about the picture

Cutting
  -crop WxH+X+Y              cut a rectangle; +repage forgets the offset of the canvas
  -extract WxH+X+Y           the same cut without the other operators of the crop
  -trim                      cut the border of one colour away
  -shave WxH+X+Y             shave the edges
  -chop WxH+X+Y              cut a hole in the middle
  -splice WxH+X+Y            put a band of the background in
  -border WxH                add a frame, with -bordercolor
  -extent WxH+X+Y            set the size of the canvas
  -gravity type              the anchor of the operators that place (-gravity center)

Geometry
  -resize WxH                scale, keeping the proportions
  -resize WxH^               fill the box and cut the overflow away
  -resize WxH!               stretch, ignoring the proportions
  -scale WxH                 fast scale, no filtering
  -sample WxH                scale by picking the pixels
  -rotate degrees            turn the picture
  -shear geometry            slide one edge along the X or the Y axis
  -deskew threshold          straighten the picture by the angle of its lines
  -flip, -flop               turn the picture over
  -transpose, -transverse    turn the picture by ninety degrees
  -distort method args        the projective change; see the topic "distorts"

Colour
  -colorspace type           sRGB, Gray, CMYK, Lab, ...
  -colors value              the number of the colours of the picture
  -monochrome                black and white
  -threshold value           every pixel above the value becomes white
  -level black,white         the range of the values that is kept
  -contrast-stretch geometry the range that is used
  -normalize                 the whole range is used
  -gamma value               the gamma of the picture
  -modulate brightness,saturation,hue
  -brightness-contrast brightness,contrast
  -channel mask              the channel the operators work on (RGB, A, ...)
  -separate                  one picture per channel
  -sparse-color method args  fill the picture from a few points of colour

Edges and noise
  -blur geometry, -gaussian-blur geometry, -median geometry
  -statistic type geometry   replace a pixel with a statistic of its neighbours
  -sharpen geometry, -unsharp geometry, -adaptive-sharpen geometry
  -edge radius, -canny geometry, -morphology method kernel
  -despeckle, -noise geometry, -kuwahara geometry, -liquid-rescale geometry

Alpha
  -alpha on|off|set|extract   the alpha channel of the picture
  -transparent color          one colour becomes transparent
  -background color           the colour under the picture
  -flatten                   the background and the picture become one
  -layers method              the layers of the picture

Drawing and text
  -fill color, -stroke color, -strokewidth
  -font name, -pointsize value
  -draw "primitive"           rectangle, circle, line, text, path, ...
  -annotate geometry text     text on the picture`;

const DISTORTS = `The distort methods (magick -list distort) and the control points each of them wants.
The pairs are always source → destination: the first point is where the pixel is now, the second
is where it has to go.

  Affine                 3 pairs, 6 numbers     a turn, a scale and a shift
  RigidAffine            3 pairs, 6 numbers     the same without the shear
  AffineProjection       6 numbers             the coefficients a,b,c,d,e,f
  ScaleRotateTranslate   1 number              the angle in degrees
  SRT                    1 number              the angle, or "angle,scale,shear"
  Perspective            4 pairs, 8 numbers    the four corners of a quadrilateral
  PerspectiveProjection  4 pairs, 8 numbers    the same, projected
  BilinearForward        4 pairs, 8 numbers    the corners, sampled bilinearly
  BilinearReverse        4 pairs, 8 numbers    the same, backwards
  Polynomial             an order and the pairs the order needs, at least 6 pairs
  Barrel                 2 pairs, 4 numbers    the pincushion of the lens
  BarrelInverse          2 pairs, 4 numbers    the same, backwards
  Shepards               any number of pairs   the spline through the points
  Arc                    3 pairs               the start, the end and the angle of the arc
  Polar                  2 numbers             the centre and the radius
  DePolar                2 numbers             the same, backwards
  Resize                 1 number              the share of the size

The control points are one argument of the command line:
  magick in.png -distort Perspective "0,0 0,0 69,0 0,69" out.png
A method that is given the wrong number of numbers says so: "require at least 6 CPs", "Needs 6
coeff values", "number of arguments", "Unsolvable Matrix".
The pixels outside of the picture are the virtual pixel of the border: -virtual-pixel background,
-virtual-pixel white or -virtual-pixel edge decides what they are.

The full manual: ${MAGICK_DOC_URLS.distorts}`;

/** The manual, by topic. */
export const MAGICK_DOCS = Object.freeze({
    'command-line': COMMAND_LINE,
    operators: OPERATORS,
    distorts: DISTORTS,
});

/**
 * The manual of one topic, or of all of them.
 *
 * A topic that is not known is not an error: the whole manual is returned, because a role that
 * asked for the wrong word still needs the manual.
 * @param {string} topic the name of the topic
 * @returns {string} the text of the manual
 * @exports
 * @ai.hint pure
 */
export function magickDoc(topic = 'all') {
    const key = String(topic ?? '').trim().toLowerCase();
    if (!key || key === 'all') {
        return Object.values(MAGICK_DOCS).join('\n\n');
    }
    return MAGICK_DOCS[key] ?? Object.values(MAGICK_DOCS).join('\n\n');
}
