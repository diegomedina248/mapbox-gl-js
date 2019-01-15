// @flow

import Anchor from './anchor';

import { getAnchors, getCenterAnchor } from './get_anchors';
import clipLine from './clip_line';
import { shapeText, shapeIcon, WritingMode } from './shaping';
import { getGlyphQuads, getIconQuads } from './quads';
import CollisionFeature from './collision_feature';
import { warnOnce } from '../util/util';
import {
    allowsVerticalWritingMode,
    allowsLetterSpacing
} from '../util/script_detection';
import findPoleOfInaccessibility from '../util/find_pole_of_inaccessibility';
import classifyRings from '../util/classify_rings';
import EXTENT from '../data/extent';
import SymbolBucket from '../data/bucket/symbol_bucket';
import EvaluationParameters from '../style/evaluation_parameters';
import {SIZE_PACK_FACTOR} from './symbol_size';
import ONE_EM from './one_em';

import type {Shaping, PositionedIcon, TextJustify} from './shaping';
import type {CollisionBoxArray} from '../data/array_types';
import type {SymbolFeature} from '../data/bucket/symbol_bucket';
import type {StyleImage} from '../style/style_image';
import type {StyleGlyph} from '../style/style_glyph';
import type SymbolStyleLayer from '../style/style_layer/symbol_style_layer';
import type {ImagePosition} from '../render/image_atlas';
import type {GlyphPosition} from '../render/glyph_atlas';
import type {PossiblyEvaluatedPropertyValue} from '../style/properties';

import Point from '@mapbox/point-geometry';
import murmur3 from 'murmurhash-js';

// The symbol layout process needs `text-size` evaluated at up to five different zoom levels, and
// `icon-size` at up to three:
//
//   1. `text-size` at the zoom level of the bucket. Used to calculate a per-feature size for source `text-size`
//       expressions, and to calculate the box dimensions for icon-text-fit.
//   2. `icon-size` at the zoom level of the bucket. Used to calculate a per-feature size for source `icon-size`
//       expressions.
//   3. `text-size` and `icon-size` at the zoom level of the bucket, plus one. Used to calculate collision boxes.
//   4. `text-size` at zoom level 18. Used for something line-symbol-placement-related.
//   5.  For composite `*-size` expressions: two zoom levels of curve stops that "cover" the zoom level of the
//       bucket. These go into a vertex buffer and are used by the shader to interpolate the size at render time.
//
// (1) and (2) are stored in `bucket.layers[0].layout`. The remainder are below.
//
type Sizes = {
    layoutTextSize: PossiblyEvaluatedPropertyValue<number>, // (3)
    layoutIconSize: PossiblyEvaluatedPropertyValue<number>, // (3)
    textMaxSize: PossiblyEvaluatedPropertyValue<number>,    // (4)
    compositeTextSizes: [PossiblyEvaluatedPropertyValue<number>, PossiblyEvaluatedPropertyValue<number>], // (5)
    compositeIconSizes: [PossiblyEvaluatedPropertyValue<number>, PossiblyEvaluatedPropertyValue<number>], // (5)
};

export type VariableTextAnchor = 'center' | 'left' | 'right' | 'top' | 'bottom' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export function performSymbolLayout(bucket: SymbolBucket,
                             glyphMap: {[string]: {[number]: ?StyleGlyph}},
                             glyphPositions: {[string]: {[number]: GlyphPosition}},
                             imageMap: {[string]: StyleImage},
                             imagePositions: {[string]: ImagePosition},
                             showCollisionBoxes: boolean) {
    bucket.createArrays();

    const tileSize = 512 * bucket.overscaling;
    bucket.tilePixelRatio = EXTENT / tileSize;
    bucket.compareText = {};
    bucket.iconsNeedLinear = false;

    const layout = bucket.layers[0].layout;
    const unevaluatedLayoutValues = bucket.layers[0]._unevaluatedLayout._values;

    const sizes = {};

    if (bucket.textSizeData.functionType === 'composite') {
        const {min, max} = bucket.textSizeData.zoomRange;
        sizes.compositeTextSizes = [
            unevaluatedLayoutValues['text-size'].possiblyEvaluate(new EvaluationParameters(min)),
            unevaluatedLayoutValues['text-size'].possiblyEvaluate(new EvaluationParameters(max))
        ];
    }

    if (bucket.iconSizeData.functionType === 'composite') {
        const {min, max} = bucket.iconSizeData.zoomRange;
        sizes.compositeIconSizes = [
            unevaluatedLayoutValues['icon-size'].possiblyEvaluate(new EvaluationParameters(min)),
            unevaluatedLayoutValues['icon-size'].possiblyEvaluate(new EvaluationParameters(max))
        ];
    }

    sizes.layoutTextSize = unevaluatedLayoutValues['text-size'].possiblyEvaluate(new EvaluationParameters(bucket.zoom + 1));
    sizes.layoutIconSize = unevaluatedLayoutValues['icon-size'].possiblyEvaluate(new EvaluationParameters(bucket.zoom + 1));
    sizes.textMaxSize = unevaluatedLayoutValues['text-size'].possiblyEvaluate(new EvaluationParameters(18));

    const lineHeight = layout.get('text-line-height') * ONE_EM;
    const textAlongLine = layout.get('text-rotation-alignment') === 'map' && layout.get('symbol-placement') !== 'point';
    const keepUpright = layout.get('text-keep-upright');


    for (const feature of bucket.features) {
        const fontstack = layout.get('text-font').evaluate(feature, {}).join(',');
        const glyphPositionMap = glyphPositions;

        const shapedTextOrientations = {};
        shapedTextOrientations.horizontal = {};
        const text = feature.text;
        if (text) {
            const unformattedText = text.toString();
            const spacing = layout.get('text-letter-spacing').evaluate(feature, {}) * ONE_EM;
            const spacingIfAllowed = allowsLetterSpacing(unformattedText) ? spacing : 0;
            const symbolPlacement = layout.get('symbol-placement');
            const textAnchor = layout.get('text-anchor').evaluate(feature, {});
            // variable placement doesn't apply to line-placed labels
            let variableTextAnchor = layout.get('variable-text-anchor');
            // Layers with multiple anchors use the `variable-text-offset` property and the [x, y] offset vector
            // is calculated at placement time based on the placed `text-anchor`.
            const textOffset: [number, number] = ((variableTextAnchor ? [0, 0] : layout.get('text-offset').evaluate(feature, {})).map((t) => t * ONE_EM): any);
            const textJustify = layout.get('text-justify').evaluate(feature, {});
            const justifications =  variableTextAnchor ? variableTextAnchor.map(a => getAnchorJustification(a)) : [];

            const maxWidth =  symbolPlacement === 'point' ?
                layout.get('text-max-width').evaluate(feature, {}) * ONE_EM :
                0;

            // If this layer uses variable-text-anchor, generate shapings for all justification possibilities.
            if (!textAlongLine && variableTextAnchor) {
                let singleLine = false;
                for (let i = 0; i < justifications.length; i++) {
                    const justification: TextJustify = justifications[i];
                    if (shapedTextOrientations.horizontal[justification]) continue;
                    if (singleLine) {
                        // If the shaping for the first justification was only a single line, we
                        // can re-use it for the other justifications
                        shapedTextOrientations.horizontal[justification] = shapedTextOrientations.horizontal[0];
                    } else {
                        // If using variable-text-anchor for the layer, we use a center anchor for all shapings and apply
                        // the offsets for the anchor in the placement step.
                        const shaping = shapeText(text, glyphMap, fontstack, maxWidth, lineHeight, 'center', justification, spacingIfAllowed, textOffset, ONE_EM, WritingMode.horizontal);
                        if (shaping) {
                            shapedTextOrientations.horizontal[justification] = shaping;
                            singleLine = shaping.lineCount === 1;
                        }
                    }
                }
            } else {
                const shaping = shapeText(text, glyphMap, fontstack, maxWidth, lineHeight, textAnchor, textJustify, spacingIfAllowed, textOffset, ONE_EM, WritingMode.horizontal);
                if (shaping) shapedTextOrientations.horizontal[textJustify] = shaping;

                if (allowsVerticalWritingMode(unformattedText) && textAlongLine && keepUpright) {
                    shapedTextOrientations.vertical = shapeText(text, glyphMap, fontstack, maxWidth, lineHeight, textAnchor, textJustify, spacingIfAllowed, textOffset, ONE_EM, WritingMode.vertical);
                }
            }

        }

        let shapedIcon;
        if (feature.icon) {
            const image = imageMap[feature.icon];
            if (image) {
                shapedIcon = shapeIcon(
                    imagePositions[feature.icon],
                    layout.get('icon-offset').evaluate(feature, {}),
                    layout.get('icon-anchor').evaluate(feature, {}));
                if (bucket.sdfIcons === undefined) {
                    bucket.sdfIcons = image.sdf;
                } else if (bucket.sdfIcons !== image.sdf) {
                    warnOnce('Style sheet warning: Cannot mix SDF and non-SDF icons in one buffer');
                }
                if (image.pixelRatio !== bucket.pixelRatio) {
                    bucket.iconsNeedLinear = true;
                } else if (layout.get('icon-rotate').constantOr(1) !== 0) {
                    bucket.iconsNeedLinear = true;
                }
            }
        }

        if (shapedTextOrientations.horizontal && Object.keys(shapedTextOrientations.horizontal).length || shapedIcon) {
            addFeature(bucket, feature, shapedTextOrientations, shapedIcon, glyphPositionMap, sizes);
        }
    }

    if (showCollisionBoxes) {
        bucket.generateCollisionDebugBuffers();
    }
}

export function getTextboxScale(tilePixelRatio: number, layoutTextSize: number) {
    const glyphSize = 24,
        fontScale = layoutTextSize / glyphSize;
    return tilePixelRatio * fontScale;
}

// for variable placement, we choose the appropriate justification based on the current anchor
export function getAnchorJustification(anchor: VariableTextAnchor): TextJustify  {
    // top and bottom anchors will be replaced by an empty string, but both of those
    // anchors are center justified.
    switch (anchor) {
    case 'right':
    case 'top-right':
    case 'bottom-right':
        return 'right';
    case 'left':
    case 'top-left':
    case 'bottom-left':
        return 'left';
    }

    return 'center';
}
/**
 * Given a feature and its shaped text and icon data, add a 'symbol
 * instance' for each _possible_ placement of the symbol feature.
 * (At render timePlaceSymbols#place() selects which of these instances to
 * show or hide based on collisions with symbols in other layers.)
 * @private
 */
function addFeature(bucket: SymbolBucket,
                    feature: SymbolFeature,
                    shapedTextOrientations: any,
                    shapedIcon: PositionedIcon | void,
                    glyphPositionMap: {[string]: {[number]: GlyphPosition}},
                    sizes: Sizes) {
    const layoutTextSize = sizes.layoutTextSize.evaluate(feature, {});
    const layoutIconSize = sizes.layoutIconSize.evaluate(feature, {});

    // To reduce the number of labels that jump around when zooming we need
    // to use a text-size value that is the same for all zoom levels.
    // bucket calculates text-size at a high zoom level so that all tiles can
    // use the same value when calculating anchor positions.
    let textMaxSize = sizes.textMaxSize.evaluate(feature, {});
    if (textMaxSize === undefined) {
        textMaxSize = layoutTextSize;
    }

    const layout = bucket.layers[0].layout;
    const textOffset = layout.get('variable-text-anchor') ? [0, 0] : layout.get('text-offset').evaluate(feature, {});
    const iconOffset = layout.get('icon-offset').evaluate(feature, {});
    const justifications = Object.keys(shapedTextOrientations.horizontal);
    const defaultHorizontalShaping = justifications.length ? shapedTextOrientations.horizontal[justifications[0]] : null;
    const glyphSize = 24,
        textBoxScale = getTextboxScale(bucket.tilePixelRatio, layoutTextSize),
        textMaxBoxScale = bucket.tilePixelRatio * textMaxSize / glyphSize,
        iconBoxScale = bucket.tilePixelRatio * layoutIconSize,
        symbolMinDistance = bucket.tilePixelRatio * layout.get('symbol-spacing'),
        textPadding = layout.get('text-padding') * bucket.tilePixelRatio,
        iconPadding = layout.get('icon-padding') * bucket.tilePixelRatio,
        textMaxAngle = layout.get('text-max-angle') / 180 * Math.PI,
        textAlongLine = layout.get('text-rotation-alignment') === 'map' && layout.get('symbol-placement') !== 'point',
        iconAlongLine = layout.get('icon-rotation-alignment') === 'map' && layout.get('symbol-placement') !== 'point',
        symbolPlacement = layout.get('symbol-placement'),
        textRepeatDistance = symbolMinDistance / 2;

    const addSymbolAtAnchor = (line, anchor) => {
        if (anchor.x < 0 || anchor.x >= EXTENT || anchor.y < 0 || anchor.y >= EXTENT) {
            // Symbol layers are drawn across tile boundaries, We filter out symbols
            // outside our tile boundaries (which may be included in vector tile buffers)
            // to prevent double-drawing symbols.
            return;
        }

        addSymbol(bucket, anchor, line, shapedTextOrientations, shapedIcon, bucket.layers[0],
            bucket.collisionBoxArray, feature.index, feature.sourceLayerIndex, bucket.index,
            textBoxScale, textPadding, textAlongLine, textOffset,
            iconBoxScale, iconPadding, iconAlongLine, iconOffset,
            feature, glyphPositionMap, sizes, layoutTextSize);
    };

    if (symbolPlacement === 'line') {
        for (const line of clipLine(feature.geometry, 0, 0, EXTENT, EXTENT)) {
            const anchors = getAnchors(
                line,
                symbolMinDistance,
                textMaxAngle,
                shapedTextOrientations.vertical || defaultHorizontalShaping,
                shapedIcon,
                glyphSize,
                textMaxBoxScale,
                bucket.overscaling,
                EXTENT
            );
            for (const anchor of anchors) {
                const shapedText = defaultHorizontalShaping;
                if (!shapedText || !anchorIsTooClose(bucket, shapedText.text, textRepeatDistance, anchor)) {
                    addSymbolAtAnchor(line, anchor);
                }
            }
        }
    } else if (symbolPlacement === 'line-center') {
        // No clipping, multiple lines per feature are allowed
        // "lines" with only one point are ignored as in clipLines
        for (const line of feature.geometry) {
            if (line.length > 1) {
                const anchor = getCenterAnchor(
                    line,
                    textMaxAngle,
                    shapedTextOrientations.vertical || defaultHorizontalShaping,
                    shapedIcon,
                    glyphSize,
                    textMaxBoxScale);
                if (anchor) {
                    addSymbolAtAnchor(line, anchor);
                }
            }
        }
    } else if (feature.type === 'Polygon') {
        for (const polygon of classifyRings(feature.geometry, 0)) {
            // 16 here represents 2 pixels
            const poi = findPoleOfInaccessibility(polygon, 16);
            addSymbolAtAnchor(polygon[0], new Anchor(poi.x, poi.y, 0));
        }
    } else if (feature.type === 'LineString') {
        // https://github.com/mapbox/mapbox-gl-js/issues/3808
        for (const line of feature.geometry) {
            addSymbolAtAnchor(line, new Anchor(line[0].x, line[0].y, 0));
        }
    } else if (feature.type === 'Point') {
        for (const points of feature.geometry) {
            for (const point of points) {
                addSymbolAtAnchor([point], new Anchor(point.x, point.y, 0));
            }
        }
    }
}

const MAX_PACKED_SIZE = 65535;

function addTextVertices(bucket: SymbolBucket,
                         anchor: Point,
                         shapedText: Shaping,
                         layer: SymbolStyleLayer,
                         textAlongLine: boolean,
                         feature: SymbolFeature,
                         textOffset: [number, number],
                         lineArray: {lineStartIndex: number, lineLength: number},
                         writingMode: number,
                         placementTypes: Array<'vertical' | 'center' | 'left' | 'right'>,
                         placedTextSymbolIndices: {[string]: number},
                         glyphPositionMap: {[string]: {[number]: GlyphPosition}},
                         sizes: Sizes) {
    const glyphQuads = getGlyphQuads(anchor, shapedText,
                            layer, textAlongLine, feature, glyphPositionMap);

    const sizeData = bucket.textSizeData;
    let textSizeData = null;

    if (sizeData.functionType === 'source') {
        textSizeData = [
            SIZE_PACK_FACTOR * layer.layout.get('text-size').evaluate(feature, {})
        ];
        if (textSizeData[0] > MAX_PACKED_SIZE) {
            warnOnce(`${bucket.layerIds[0]}: Value for "text-size" is >= 256. Reduce your "text-size".`);
        }
    } else if (sizeData.functionType === 'composite') {
        textSizeData = [
            SIZE_PACK_FACTOR * sizes.compositeTextSizes[0].evaluate(feature, {}),
            SIZE_PACK_FACTOR * sizes.compositeTextSizes[1].evaluate(feature, {})
        ];
        if (textSizeData[0] > MAX_PACKED_SIZE || textSizeData[1] > MAX_PACKED_SIZE) {
            warnOnce(`${bucket.layerIds[0]}: Value for "text-size" is >= 256. Reduce your "text-size".`);
        }
    }

    bucket.addSymbols(
        bucket.text,
        glyphQuads,
        textSizeData,
        textOffset,
        textAlongLine,
        feature,
        writingMode,
        anchor,
        lineArray.lineStartIndex,
        lineArray.lineLength);

    // The placedSymbolArray is used at render time in drawTileSymbols
    // These indices allow access to the array at collision detection time
    for (const placementType of placementTypes) {
        placedTextSymbolIndices[placementType] = bucket.text.placedSymbolArray.length - 1;
    }

    return glyphQuads.length * 4;
}


/**
 * Add a single label & icon placement.
 *
 * @private
 */
function addSymbol(bucket: SymbolBucket,
                   anchor: Anchor,
                   line: Array<Point>,
                   shapedTextOrientations: any,
                   shapedIcon: PositionedIcon | void,
                   layer: SymbolStyleLayer,
                   collisionBoxArray: CollisionBoxArray,
                   featureIndex: number,
                   sourceLayerIndex: number,
                   bucketIndex: number,
                   textBoxScale: number,
                   textPadding: number,
                   textAlongLine: boolean,
                   textOffset: [number, number],
                   iconBoxScale: number,
                   iconPadding: number,
                   iconAlongLine: boolean,
                   iconOffset: [number, number],
                   feature: SymbolFeature,
                   glyphPositionMap: {[string]: {[number]: GlyphPosition}},
                   sizes: Sizes,
                   layoutTextSize: number) {
    const lineArray = bucket.addToLineVertexArray(anchor, line);

    let textCollisionFeature, iconCollisionFeature;

    let numIconVertices = 0;
    let numHorizontalGlyphVertices = 0;
    let numVerticalGlyphVertices = 0;
    const placedTextSymbolIndices = {};
    let key = murmur3('');
    const variableTextOffset = (layer.layout.get('variable-text-offset').evaluate(feature, {}) || 0) * ONE_EM;

    for (const justification: any in shapedTextOrientations.horizontal) {
        const shaping = shapedTextOrientations.horizontal[justification];

        if (!textCollisionFeature) {
            key = murmur3(shaping.text);
            const textRotate = layer.layout.get('text-rotate').evaluate(feature, {});
            // As a collision approximation, we can use either the vertical or any of the horizontal versions of the feature
            // We're counting on all versions having similar dimensions
            textCollisionFeature = new CollisionFeature(collisionBoxArray, line, anchor, featureIndex, sourceLayerIndex, bucketIndex, shaping, textBoxScale, textPadding, textAlongLine, bucket.overscaling, textRotate);
        }

        const singleLine = shaping.lineCount === 1;
        numHorizontalGlyphVertices += addTextVertices(
            bucket, anchor, shaping, layer, textAlongLine, feature, textOffset, lineArray,
            shapedTextOrientations.vertical ? WritingMode.horizontal : WritingMode.horizontalOnly,
            singleLine ? Object.keys(shapedTextOrientations.horizontal) : [justification],
            placedTextSymbolIndices, glyphPositionMap, sizes);

        if (singleLine) {
            break;
        }
    }

    if (shapedTextOrientations.vertical) {
        numVerticalGlyphVertices += addTextVertices(
            bucket, anchor, shapedTextOrientations.vertical, layer, textAlongLine, feature,
            textOffset, lineArray, WritingMode.vertical, ['vertical'], placedTextSymbolIndices, glyphPositionMap, sizes);
    }

    const textBoxStartIndex = textCollisionFeature ? textCollisionFeature.boxStartIndex : bucket.collisionBoxArray.length;
    const textBoxEndIndex = textCollisionFeature ? textCollisionFeature.boxEndIndex : bucket.collisionBoxArray.length;

    if (shapedIcon) {
        const justifications = Object.keys(shapedTextOrientations.horizontal);
        const defaultHorizontalShaping: any = justifications.length ? shapedTextOrientations.horizontal[justifications[0]] : null;
        const iconQuads = getIconQuads(anchor, shapedIcon, layer,
                            iconAlongLine, defaultHorizontalShaping,
                            feature);
        const iconRotate = layer.layout.get('icon-rotate').evaluate(feature, {});
        iconCollisionFeature = new CollisionFeature(collisionBoxArray, line, anchor, featureIndex, sourceLayerIndex, bucketIndex, shapedIcon, iconBoxScale, iconPadding, /*align boxes to line*/false, bucket.overscaling, iconRotate);

        numIconVertices = iconQuads.length * 4;

        const sizeData = bucket.iconSizeData;
        let iconSizeData = null;

        if (sizeData.functionType === 'source') {
            iconSizeData = [
                SIZE_PACK_FACTOR * layer.layout.get('icon-size').evaluate(feature, {})
            ];
            if (iconSizeData[0] > MAX_PACKED_SIZE) {
                warnOnce(`${bucket.layerIds[0]}: Value for "icon-size" is >= 256. Reduce your "icon-size".`);
            }
        } else if (sizeData.functionType === 'composite') {
            iconSizeData = [
                SIZE_PACK_FACTOR * sizes.compositeIconSizes[0].evaluate(feature, {}),
                SIZE_PACK_FACTOR * sizes.compositeIconSizes[1].evaluate(feature, {})
            ];
            if (iconSizeData[0] > MAX_PACKED_SIZE || iconSizeData[1] > MAX_PACKED_SIZE) {
                warnOnce(`${bucket.layerIds[0]}: Value for "icon-size" is >= 256. Reduce your "icon-size".`);
            }
        }

        bucket.addSymbols(
            bucket.icon,
            iconQuads,
            iconSizeData,
            iconOffset,
            iconAlongLine,
            feature,
            false,
            anchor,
            lineArray.lineStartIndex,
            lineArray.lineLength);
    }

    const iconBoxStartIndex = iconCollisionFeature ? iconCollisionFeature.boxStartIndex : bucket.collisionBoxArray.length;
    const iconBoxEndIndex = iconCollisionFeature ? iconCollisionFeature.boxEndIndex : bucket.collisionBoxArray.length;

    if (bucket.glyphOffsetArray.length >= SymbolBucket.MAX_GLYPHS) warnOnce(
        "Too many glyphs being rendered in a tile. See https://github.com/mapbox/mapbox-gl-js/issues/2907"
    );

    bucket.symbolInstances.emplaceBack(
        anchor.x,
        anchor.y,
        placedTextSymbolIndices.right >= 0 ? placedTextSymbolIndices.right : -1,
        placedTextSymbolIndices.center >= 0 ? placedTextSymbolIndices.center : -1,
        placedTextSymbolIndices.left >= 0 ? placedTextSymbolIndices.left : -1,
        placedTextSymbolIndices.vertical || -1,
        key,
        textBoxStartIndex,
        textBoxEndIndex,
        iconBoxStartIndex,
        iconBoxEndIndex,
        featureIndex,
        numHorizontalGlyphVertices,
        numVerticalGlyphVertices,
        numIconVertices,
        0,
        layoutTextSize,
        variableTextOffset);
}

function anchorIsTooClose(bucket: any, text: string, repeatDistance: number, anchor: Point) {
    const compareText = bucket.compareText;
    if (!(text in compareText)) {
        compareText[text] = [];
    } else {
        const otherAnchors = compareText[text];
        for (let k = otherAnchors.length - 1; k >= 0; k--) {
            if (anchor.dist(otherAnchors[k]) < repeatDistance) {
                // If it's within repeatDistance of one anchor, stop looking
                return true;
            }
        }
    }
    // If anchor is not within repeatDistance of any other anchor, add to array
    compareText[text].push(anchor);
    return false;
}
